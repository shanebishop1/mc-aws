import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import path from "node:path";

export const LOCAL_SKILL_CONTENT_MARKER = "MC_AWS_LOCAL_SKILL_DO_NOT_PACKAGE";
export const MAX_TOTAL_SCANNED_BYTES = 512 * 1024 * 1024;
export const MAX_SCANNED_FILES = 10_000;
const SCAN_CHUNK_BYTES = 64 * 1024;

const forbiddenNames = (name: string): boolean => {
  const lower = name.toLowerCase();
  return (
    lower === ".agents" ||
    lower === ".git" ||
    lower === ".local-artifacts" ||
    /^(?:\.env|env)(?:\.|$)/i.test(name) ||
    /^(?:\.?mock-state\.json)(?:\.|$)/i.test(name) ||
    /(?:^|[-_.])credentials?(?:$|[-_.])/i.test(name) ||
    /(?:^|[-_.])oauth(?:$|[-_.])/i.test(name)
  );
};

const secretLikeContent =
  /-----BEGIN [A-Z0-9 ]{0,64}PRIVATE KEY-----|["']?\b(?:aws_(?:access_key_id|secret_access_key)|github_token|client[_-]?secret|access[_-]?token|refresh[_-]?token|oauth(?:[_-]?(?:token|secret|client))?|securestring|password|secret|token|api[_-]?key)["']?[ \t]*[:=][ \t]*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s,}\]]+)/i;

function inspectFile(
  artifactRoot: string,
  absolute: string,
  relative: string,
  budget: { scannedBytes: number; fileCount: number }
): void {
  const before = lstatSync(absolute);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`Unexpected non-regular artifact entered ${artifactRoot}: ${relative}`);
  }
  const descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`Artifact changed during exclusion scan: ${relative}`);
    }
    const chunk = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
    let carry = "";
    while (true) {
      const bytesRead = readSync(descriptor, chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) break;
      budget.scannedBytes += bytesRead;
      if (budget.scannedBytes > MAX_TOTAL_SCANNED_BYTES) {
        throw new Error(`Generated artifacts exceed the global exclusion-scan byte bound: ${artifactRoot}`);
      }
      const text = carry + chunk.subarray(0, bytesRead).toString("latin1");
      if (text.includes(LOCAL_SKILL_CONTENT_MARKER)) {
        throw new Error(`Local skill content entered ${artifactRoot}: ${relative}`);
      }
      if (secretLikeContent.test(text)) {
        throw new Error(`Secret-like content entered ${artifactRoot}: ${relative}`);
      }
      carry = text.slice(-512);
    }
  } finally {
    closeSync(descriptor);
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: traversal rejects every path type while sharing one global scan budget.
function inspectDirectory(
  artifactRoot: string,
  absoluteRoot: string,
  budget: { scannedBytes: number; fileCount: number }
): void {
  const pending = [absoluteRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(absoluteRoot, absolute).replaceAll(path.sep, "/");
      if (forbiddenNames(entry.name)) {
        if (entry.name.toLowerCase() === ".agents") {
          throw new Error(`Developer-only .agents path entered ${artifactRoot}: ${relative}`);
        }
        throw new Error(`Forbidden packaged path entered ${artifactRoot}: ${relative}`);
      }
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile()) {
        budget.fileCount += 1;
        if (budget.fileCount > MAX_SCANNED_FILES) {
          throw new Error(`Generated artifacts exceed the file-count bound: ${artifactRoot}`);
        }
        inspectFile(artifactRoot, absolute, relative, budget);
      } else if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink entered ${artifactRoot}: ${relative}`);
      else throw new Error(`Unexpected non-regular artifact entered ${artifactRoot}: ${relative}`);
    }
  }
}

export function validateAgentSkillExclusion(artifactRoots: readonly string[]): void {
  if (artifactRoots.length === 0) throw new Error("At least one generated artifact root is required.");
  const budget = { scannedBytes: 0, fileCount: 0 };
  for (const artifactRoot of artifactRoots) {
    const absoluteRoot = path.resolve(artifactRoot);
    if (!existsSync(absoluteRoot) || !lstatSync(absoluteRoot).isDirectory()) {
      throw new Error(`Generated artifact root is missing: ${artifactRoot}`);
    }
    inspectDirectory(artifactRoot, absoluteRoot, budget);
  }
}

if (process.argv[1]?.endsWith("validate-agent-skill-exclusion.ts")) {
  try {
    validateAgentSkillExclusion(process.argv.slice(2));
    console.log("[AGENT-PACKAGE] Developer-only skill is absent from generated panel artifacts.");
  } catch (error) {
    console.error(`[AGENT-PACKAGE] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
