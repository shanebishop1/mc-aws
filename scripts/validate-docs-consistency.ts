import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

interface Rule {
  readonly id: string;
  readonly description: string;
  readonly pattern: RegExp;
}

const rules: readonly Rule[] = [
  {
    id: "legacy-bd-command",
    description: "Use br commands instead of bd commands",
    pattern: /\bbd\s+[a-z]/i,
  },
  {
    id: "legacy-local-port",
    description: "Use localhost:3000 as canonical local port",
    pattern: /localhost:3001\b/i,
  },
  {
    id: "env-file-safety",
    description: "Do not describe credential-bearing env files as non-secret or safe to share",
    pattern: /\.env(?:\.(?:local|production))?[\s\S]{0,80}\b(?:non-secret|not sensitive|safe to (?:commit|share))\b/i,
  },
  {
    id: "automatic-resume-restore",
    description: "Do not claim resume enforces a restore selection or automatically restores a backup",
    pattern:
      /\bresume(?: request)?\s+(?:automatically|by default)\s+restores?\b|\bbare resume(?: request)?\s+(?:automatically\s+)?restores?\b|\bresume(?: request| API| endpoint)?\s+(?:requires?|enforces?)\s+(?:an?\s+)?explicit\s+(?:restore\s+)?(?:mode|selection|choice)\b|\brestore\s+(?:mode|selection|choice)\s+(?:is|are)\s+(?:required|enforced)\s+(?:for|by)\s+resume\b/i,
  },
  {
    id: "unowned-teardown",
    description: "Teardown claims must remain ownership-aware",
    pattern: /\bteardown (?:will )?(?:delete|remove)s? all\b/i,
  },
  {
    id: "least-privilege-worker",
    description: "Do not understate the Worker runtime identity's deployment privileges",
    pattern: /\b(?:least-privilege|narrow)\b[\s\S]{0,50}\b(?:worker|runtime (?:identity|user|key))\b/i,
  },
];

const rootDir = process.cwd();
const violations: string[] = [];
const proseFilesToCheck = Array.from(
  new Set(
    execFileSync(
      "git",
      [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        "*.md",
        "**/*.md",
        ".env.example",
        ".env.local.example",
        ".env.mock.example",
        ".env.production.example",
      ],
      {
        cwd: rootDir,
        encoding: "utf8",
      }
    )
      .split("\n")
      .filter((relativePath) => relativePath && existsSync(path.join(rootDir, relativePath)))
  )
).sort();

function githubHeadingAnchors(content: string): Set<string> {
  const anchors = new Set<string>();
  const counts = new Map<string, number>();

  for (const line of content.split("\n")) {
    const match = line.match(/^#{1,6}\s+(.+?)\s*#*$/);
    if (!match) continue;

    let heading = match[1].trim().toLowerCase();
    let previousHeading: string;
    do {
      previousHeading = heading;
      heading = heading.replace(/<[^>]+>/g, "");
    } while (heading !== previousHeading);

    const base = heading.replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s+/g, "-");
    const duplicateCount = counts.get(base) ?? 0;
    counts.set(base, duplicateCount + 1);
    anchors.add(duplicateCount === 0 ? base : `${base}-${duplicateCount}`);
  }

  return anchors;
}

function decodeLinkPath(encodedPath: string): string | undefined {
  try {
    return decodeURIComponent(encodedPath);
  } catch {
    return undefined;
  }
}

function isPathInsideRepository(targetPath: string): boolean {
  const relativeTarget = path.relative(rootDir, targetPath);
  return relativeTarget !== ".." && !relativeTarget.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeTarget);
}

function validateMarkdownAnchor(
  relativePath: string,
  targetPath: string,
  encodedAnchor: string | undefined,
  rawTarget: string
): void {
  if (statSync(targetPath).isDirectory() || !encodedAnchor || !targetPath.endsWith(".md")) return;

  const anchor = decodeURIComponent(encodedAnchor).toLowerCase();
  const targetContent = readFileSync(targetPath, "utf8");
  if (!githubHeadingAnchors(targetContent).has(anchor)) {
    violations.push(`${relativePath}: broken-anchor (${rawTarget})`);
  }
}

function validateMarkdownLinks(relativePath: string, content: string): void {
  const linkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of content.matchAll(linkPattern)) {
    const rawTarget = match[1].trim().replace(/^<|>$/g, "");
    if (!rawTarget || /^(?:https?:|mailto:)/i.test(rawTarget)) continue;

    const [encodedFilePart, encodedAnchor] = rawTarget.split("#", 2);
    const filePart = decodeLinkPath(encodedFilePart);
    if (filePart === undefined) {
      violations.push(`${relativePath}: invalid-link-encoding (${rawTarget})`);
      continue;
    }
    const targetPath = filePart
      ? path.resolve(rootDir, path.dirname(relativePath), filePart)
      : path.resolve(rootDir, relativePath);

    if (!isPathInsideRepository(targetPath)) {
      violations.push(`${relativePath}: link-outside-repository (${rawTarget})`);
      continue;
    }

    if (!existsSync(targetPath)) {
      violations.push(`${relativePath}: broken-link (${rawTarget})`);
      continue;
    }

    validateMarkdownAnchor(relativePath, targetPath, encodedAnchor, rawTarget);
  }
}

for (const relativePath of proseFilesToCheck) {
  const absolutePath = path.join(rootDir, relativePath);
  const content = readFileSync(absolutePath, "utf8");

  if (relativePath.toLowerCase().endsWith(".md")) {
    validateMarkdownLinks(relativePath, content);
  }

  for (const rule of rules) {
    if (!rule.pattern.test(content)) {
      continue;
    }

    violations.push(`${relativePath}: ${rule.id} (${rule.description})`);
  }
}

const readme = readFileSync(path.join(rootDir, "README.md"), "utf8");
const setupGuide = readFileSync(path.join(rootDir, "docs/setup/SETUP_AND_RUN.md"), "utf8");
const mockQuickStart = readFileSync(path.join(rootDir, "docs/QUICK_START_MOCK_MODE.md"), "utf8");
const setupSource = readFileSync(path.join(rootDir, "setup.sh"), "utf8");
const deploymentPreflightIndex = setupSource.lastIndexOf("print_deployment_preflight");
const dnsMaterializationIndex = setupSource.indexOf("scripts/materialize-dns-secrets.ts", deploymentPreflightIndex);
const cdkDeploymentIndex = setupSource.indexOf(
  'run_with_mise pnpm exec cdk deploy "$STACK_NAME"',
  dnsMaterializationIndex
);

const requiredContracts: ReadonlyArray<[string, boolean]> = [
  ["README does not duplicate setup commands", !readme.includes("bash ./setup.sh")],
  ["setup guide uses canonical production setup command", setupGuide.includes("bash ./setup.sh")],
  ["mock guide documents Playwright browser installation", mockQuickStart.includes("playwright install chromium")],
  [
    "mock guide does not recommend setup.sh as a tool installer",
    !/run .{0,10}setup\.sh once|setup\.sh.{0,40}or install them with mise/i.test(mockQuickStart),
  ],
  ["setup prints account in deployment preflight", setupSource.includes('log "  AWS account: ${CDK_DEFAULT_ACCOUNT}"')],
  ["setup prints region in deployment preflight", setupSource.includes('log "  AWS region:  ${CDK_DEFAULT_REGION}"')],
  ["setup requires typed DEPLOY confirmation", setupSource.includes('[[ "$confirmation" != "DEPLOY" ]]')],
  [
    "preflight confirmation precedes DNS materialization and CDK deployment",
    deploymentPreflightIndex >= 0 &&
      dnsMaterializationIndex > deploymentPreflightIndex &&
      cdkDeploymentIndex > dnsMaterializationIndex,
  ],
  [
    "completion output does not claim unconditional readiness",
    !setupSource.includes("fully deployed and ready to use"),
  ],
  ["README links the complete production setup guide", readme.includes("docs/setup/SETUP_AND_RUN.md")],
];

for (const [description, passes] of requiredContracts) {
  if (!passes) violations.push(`contract: ${description}`);
}

if (violations.length > 0) {
  console.error("[DOCS-CHECK] Consistency violations detected:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log("[DOCS-CHECK] All docs consistency checks passed.");
