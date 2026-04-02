import { readFileSync } from "node:fs";
import path from "node:path";

interface Rule {
  readonly id: string;
  readonly description: string;
  readonly pattern: RegExp;
}

const filesToCheck = [
  "README.md",
  "docs/docs/API.md",
  "docs/GOOGLE_OAUTH_SETUP.md",
  "docs/QUICK_START_MOCK_MODE.md",
  "docs/MOCK_MODE_DEVELOPER_GUIDE.md",
  "tests/MOCK_MODE_QUICK_REF.md",
  ".claude/settings.local.json",
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

for (const relativePath of filesToCheck) {
  const absolutePath = path.join(rootDir, relativePath);
  const content = readFileSync(absolutePath, "utf8");

  for (const rule of rules) {
    if (!rule.pattern.test(content)) {
      continue;
    }

    violations.push(`${relativePath}: ${rule.id} (${rule.description})`);
  }
}

if (violations.length > 0) {
  console.error("[DOCS-CHECK] Consistency violations detected:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log("[DOCS-CHECK] All docs consistency checks passed.");
