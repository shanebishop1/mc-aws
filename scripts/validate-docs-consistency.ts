import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

interface Rule {
  readonly id: string;
  readonly description: string;
  readonly pattern: RegExp;
}

const filesToCheck = [
  "README.md",
  "SECURITY.md",
  "docs/README.md",
  "docs/AWS_CREDENTIALS_SETUP.md",
  "docs/CLOUDFLARE_SETUP.md",
  "docs/docs/API.md",
  "docs/GOOGLE_OAUTH_SETUP.md",
  "docs/OPERATIONS_GUIDE.md",
  "docs/QUICK_START_MOCK_MODE.md",
  "docs/MOCK_MODE_DEVELOPER_GUIDE.md",
  "docs/TEARDOWN.md",
  "docs/setup/AWS_ACCOUNT_SETUP.md",
  "docs/setup/CLOUDFLARE_SETUP.md",
  "docs/setup/DUCKDNS_SETUP.md",
  "docs/setup/EC2_KEY_PAIR_SETUP.md",
  "docs/setup/GITHUB_REPO_SETUP.md",
  "docs/setup/GITHUB_TOKEN_SETUP.md",
  "docs/setup/GOOGLE_DRIVE_SETUP.md",
  "docs/setup/GOOGLE_OAUTH_SETUP.md",
  "docs/setup/SES_SETUP.md",
  "docs/setup/SETUP_AND_RUN.md",
  "tests/MOCK_MODE_QUICK_REF.md",
] as const;

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
];

const rootDir = process.cwd();
const violations: string[] = [];

function githubHeadingAnchors(content: string): Set<string> {
  const anchors = new Set<string>();
  const counts = new Map<string, number>();

  for (const line of content.split("\n")) {
    const match = line.match(/^#{1,6}\s+(.+?)\s*#*$/);
    if (!match) continue;

    const base = match[1]
      .trim()
      .toLowerCase()
      .replace(/<[^>]+>/g, "")
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s+/g, "-");
    const duplicateCount = counts.get(base) ?? 0;
    counts.set(base, duplicateCount + 1);
    anchors.add(duplicateCount === 0 ? base : `${base}-${duplicateCount}`);
  }

  return anchors;
}

function validateMarkdownLinks(relativePath: string, content: string): void {
  const linkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of content.matchAll(linkPattern)) {
    const rawTarget = match[1].trim().replace(/^<|>$/g, "");
    if (!rawTarget || /^(?:https?:|mailto:)/i.test(rawTarget)) continue;

    const [encodedFilePart, encodedAnchor] = rawTarget.split("#", 2);
    const filePart = decodeURIComponent(encodedFilePart);
    const targetPath = filePart
      ? path.resolve(rootDir, path.dirname(relativePath), filePart)
      : path.resolve(rootDir, relativePath);

    if (!existsSync(targetPath)) {
      violations.push(`${relativePath}: broken-link (${rawTarget})`);
      continue;
    }

    if (statSync(targetPath).isDirectory() || !encodedAnchor || !targetPath.endsWith(".md")) continue;
    const anchor = decodeURIComponent(encodedAnchor).toLowerCase();
    const targetContent = readFileSync(targetPath, "utf8");
    if (!githubHeadingAnchors(targetContent).has(anchor)) {
      violations.push(`${relativePath}: broken-anchor (${rawTarget})`);
    }
  }
}

for (const relativePath of filesToCheck) {
  const absolutePath = path.join(rootDir, relativePath);
  const content = readFileSync(absolutePath, "utf8");

  validateMarkdownLinks(relativePath, content);

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

const requiredContracts: ReadonlyArray<[string, boolean]> = [
  ["README uses canonical production setup command", readme.includes("bash ./setup.sh")],
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
    "preflight confirmation immediately precedes CDK deployment",
    /print_deployment_preflight\s*\n\s*\(cd infra && run_with_mise pnpm exec cdk deploy/.test(setupSource),
  ],
  [
    "completion output does not claim unconditional readiness",
    !setupSource.includes("fully deployed and ready to use"),
  ],
  ["README describes authoritative server-side allowlist", readme.includes("/minecraft/email-allowlist")],
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
