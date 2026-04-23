import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import type { EnvSchemaValidationIssue, RuntimeTarget } from "../lib/runtime-config-schema";
import { validateEnvForTarget, validateRuntimeStateWranglerConfig } from "../lib/runtime-config-schema";

type CheckLevel = "pass" | "warn" | "fail";

interface CheckResult {
  level: CheckLevel;
  message: string;
}

const autoProvisionedWorkerVars = new Set([
  "AUTH_SECRET",
  "RUNTIME_STATE_SNAPSHOT_KV_ID",
  "RUNTIME_STATE_SNAPSHOT_KV_PREVIEW_ID",
]);

const autoPreparedWranglerErrors = [
  "RUNTIME_STATE_SNAPSHOT_KV id is required.",
  "RUNTIME_STATE_SNAPSHOT_KV preview_id is required.",
  "RUNTIME_STATE_SNAPSHOT_KV id cannot use placeholder values.",
  "RUNTIME_STATE_SNAPSHOT_KV preview_id cannot use placeholder values.",
];

const results: CheckResult[] = [];
const toolchainOnly = process.argv.includes("--toolchain-only");

const addResult = (level: CheckLevel, message: string) => {
  results.push({ level, message });
};

const addPass = (message: string) => addResult("pass", message);
const addWarn = (message: string) => addResult("warn", message);
const addFail = (message: string) => addResult("fail", message);

const readText = (relativePath: string): string => {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
};

const safeReadText = (relativePath: string): string | null => {
  const absolutePath = path.join(process.cwd(), relativePath);
  if (!fs.existsSync(absolutePath)) {
    return null;
  }

  return fs.readFileSync(absolutePath, "utf8");
};

const readToolVersion = (toolName: string): string | null => {
  const content = safeReadText(".tool-versions");
  if (!content) {
    return null;
  }

  const line = content
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${toolName} `));

  return line ? line.slice(toolName.length + 1).trim() : null;
};

const readMiseVersion = (toolName: string): string | null => {
  const content = safeReadText("mise.toml");
  if (!content) {
    return null;
  }

  const match = content.match(new RegExp(`^${toolName}\\s*=\\s*"([^"]+)"$`, "mu"));
  return match?.[1] ?? null;
};

const runCommand = (command: string, args: string[]): string | null => {
  try {
    return execFileSync(command, args, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
};

const classifyEnvIssue = (target: RuntimeTarget, issue: EnvSchemaValidationIssue): CheckLevel => {
  if (issue.kind === "deprecated") {
    return "warn";
  }

  if (target === "worker" && autoProvisionedWorkerVars.has(issue.name)) {
    return "warn";
  }

  return "fail";
};

const classifyWranglerError = (error: string): CheckLevel => {
  if (autoPreparedWranglerErrors.includes(error)) {
    return "warn";
  }

  return "fail";
};

const reportEnvValidation = (relativePath: string, target: RuntimeTarget) => {
  const raw = safeReadText(relativePath);
  if (!raw) {
    addWarn(`${relativePath} is missing; skip ${target} env validation until you create it.`);
    return;
  }

  const values = dotenv.parse(raw) as Record<string, string | undefined>;
  const report = validateEnvForTarget(values, target);

  if (report.issues.length === 0) {
    addPass(`${relativePath} passes ${target} env validation.`);
    return;
  }

  for (const issue of report.issues) {
    const level = classifyEnvIssue(target, issue);
    const message = `${relativePath}: ${issue.message}`;

    if (level === "fail") {
      addFail(message);
    } else {
      addWarn(message);
    }
  }
};

interface ToolchainExpectation {
  expectedNodeVersion: string | null;
  expectedPnpmVersion: string | null;
  expectedEnginePnpmVersion: string | null;
}

const readToolchainExpectation = (): ToolchainExpectation => {
  const packageJson = JSON.parse(readText("package.json")) as {
    engines?: { node?: string; pnpm?: string };
    packageManager?: string;
  };

  return {
    expectedNodeVersion: packageJson.engines?.node ?? null,
    expectedPnpmVersion: packageJson.packageManager?.startsWith("pnpm@")
      ? packageJson.packageManager.slice("pnpm@".length)
      : null,
    expectedEnginePnpmVersion: packageJson.engines?.pnpm ?? null,
  };
};

const reportRequiredFiles = () => {
  const requiredFiles = [
    ".tool-versions",
    "mise.toml",
    "pnpm-lock.yaml",
    ".env.local.example",
    ".env.production.example",
    ".env.mock.example",
    "wrangler.jsonc",
  ];

  for (const relativePath of requiredFiles) {
    if (fs.existsSync(path.join(process.cwd(), relativePath))) {
      addPass(`Found ${relativePath}.`);
    } else {
      addFail(`Missing required reproducibility file: ${relativePath}.`);
    }
  }
};

const reportMissingPackageConstraints = ({
  expectedNodeVersion,
  expectedPnpmVersion,
  expectedEnginePnpmVersion,
}: ToolchainExpectation) => {
  if (!expectedNodeVersion) {
    addFail("package.json is missing engines.node.");
  }

  if (!expectedPnpmVersion) {
    addFail("package.json is missing packageManager=pnpm@<exact-version>.");
  }

  if (!expectedEnginePnpmVersion) {
    addFail("package.json is missing engines.pnpm.");
  }

  if (expectedPnpmVersion && expectedEnginePnpmVersion && expectedPnpmVersion !== expectedEnginePnpmVersion) {
    addFail(
      `package.json pnpm version drift: packageManager=${expectedPnpmVersion}, engines.pnpm=${expectedEnginePnpmVersion}.`
    );
  }
};

const reportPinnedVersionMatch = ({
  actualVersion,
  expectedVersion,
  sourceLabel,
  expectedLabel,
}: {
  actualVersion: string | null;
  expectedVersion: string | null;
  sourceLabel: string;
  expectedLabel: string;
}) => {
  if (!expectedVersion) {
    return;
  }

  if (actualVersion !== expectedVersion) {
    addFail(`${sourceLabel}=${actualVersion ?? "missing"} does not match ${expectedLabel}=${expectedVersion}.`);
    return;
  }

  addPass(`${sourceLabel} pins ${expectedVersion}.`);
};

const reportPinnedConfigVersions = ({ expectedNodeVersion, expectedPnpmVersion }: ToolchainExpectation) => {
  const toolVersionsNode = readToolVersion("node");
  const toolVersionsPnpm = readToolVersion("pnpm");
  const miseNode = readMiseVersion("node");
  const misePnpm = readMiseVersion("pnpm");

  reportPinnedVersionMatch({
    actualVersion: toolVersionsNode,
    expectedVersion: expectedNodeVersion,
    sourceLabel: ".tool-versions node",
    expectedLabel: "package.json engines.node",
  });
  reportPinnedVersionMatch({
    actualVersion: miseNode,
    expectedVersion: expectedNodeVersion,
    sourceLabel: "mise.toml node",
    expectedLabel: "package.json engines.node",
  });
  reportPinnedVersionMatch({
    actualVersion: toolVersionsPnpm,
    expectedVersion: expectedPnpmVersion,
    sourceLabel: ".tool-versions pnpm",
    expectedLabel: "package.json packageManager",
  });
  reportPinnedVersionMatch({
    actualVersion: misePnpm,
    expectedVersion: expectedPnpmVersion,
    sourceLabel: "mise.toml pnpm",
    expectedLabel: "package.json packageManager",
  });
};

const reportRuntimeVersions = ({ expectedNodeVersion, expectedPnpmVersion }: ToolchainExpectation) => {
  if (expectedNodeVersion) {
    const actualNodeVersion = process.version.replace(/^v/u, "");
    if (actualNodeVersion === expectedNodeVersion) {
      addPass(`Node.js runtime matches pinned version ${expectedNodeVersion}.`);
    } else {
      addFail(`Node.js runtime mismatch: expected ${expectedNodeVersion}, found ${actualNodeVersion}.`);
    }
  }

  if (expectedPnpmVersion) {
    const actualPnpmVersion = runCommand("pnpm", ["--version"]);
    if (!actualPnpmVersion) {
      addFail("pnpm is not available in PATH.");
    } else if (actualPnpmVersion !== expectedPnpmVersion) {
      addFail(`pnpm runtime mismatch: expected ${expectedPnpmVersion}, found ${actualPnpmVersion}.`);
    } else {
      addPass(`pnpm runtime matches pinned version ${expectedPnpmVersion}.`);
    }
  }
};

const reportWranglerConfig = () => {
  const wranglerConfigRaw = safeReadText("wrangler.jsonc");
  if (!wranglerConfigRaw) {
    return;
  }

  try {
    const wranglerValidation = validateRuntimeStateWranglerConfig(JSON.parse(wranglerConfigRaw));
    if (wranglerValidation.isValid) {
      addPass("wrangler.jsonc passes runtime-state validation.");
      return;
    }

    for (const error of wranglerValidation.errors) {
      const level = classifyWranglerError(error);
      if (level === "fail") {
        addFail(`wrangler.jsonc: ${error}`);
      } else {
        addWarn(`wrangler.jsonc: ${error} deploy-cloudflare.sh will replace these ids during deploy.`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown JSON parse error";
    addFail(`wrangler.jsonc is not valid JSON: ${message}`);
  }
};

const printSummaryAndExit = () => {
  const failures = results.filter((result) => result.level === "fail");
  const warnings = results.filter((result) => result.level === "warn");

  for (const result of results) {
    const prefix =
      result.level === "pass" ? "[DOCTOR] PASS" : result.level === "warn" ? "[DOCTOR] WARN" : "[DOCTOR] FAIL";
    console.log(`${prefix} ${result.message}`);
  }

  if (warnings.length > 0) {
    console.log(`[DOCTOR] WARNINGS: ${warnings.length}`);
  }

  if (failures.length > 0) {
    console.error(`[DOCTOR] FAILED with ${failures.length} blocking issue(s).`);
    process.exit(1);
  }

  console.log("[DOCTOR] OK - environment reproducibility checks passed.");
};

const main = () => {
  const expectation = readToolchainExpectation();

  reportRequiredFiles();
  reportMissingPackageConstraints(expectation);
  reportPinnedConfigVersions(expectation);
  reportRuntimeVersions(expectation);
  reportWranglerConfig();

  if (!toolchainOnly) {
    reportEnvValidation(".env.local", "local-dev");
    reportEnvValidation(".env.production", "worker");
  }

  printSummaryAndExit();
};

main();
