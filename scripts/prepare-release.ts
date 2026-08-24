import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type ReleaseInput = "major" | "minor" | "patch" | string;

const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseStableSemver(version: string): readonly [bigint, bigint, bigint] {
  const match = STABLE_SEMVER.exec(version);
  if (!match) {
    throw new Error(`Version must be stable SemVer (X.Y.Z without prefixes or prereleases): ${version}`);
  }
  return [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])];
}

export function compareVersions(left: string, right: string): number {
  const leftParts = parseStableSemver(left);
  const rightParts = parseStableSemver(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] > rightParts[index] ? 1 : -1;
  }
  return 0;
}

export function resolveReleaseVersion(current: string, input: ReleaseInput): string {
  const [major, minor, patch] = parseStableSemver(current);
  let next: string;
  switch (input) {
    case "major":
      next = `${major + BigInt(1)}.0.0`;
      break;
    case "minor":
      next = `${major}.${minor + BigInt(1)}.0`;
      break;
    case "patch":
      next = `${major}.${minor}.${patch + BigInt(1)}`;
      break;
    default:
      parseStableSemver(input);
      next = input;
  }
  if (compareVersions(next, current) <= 0) {
    throw new Error(`Release version ${next} must be greater than current version ${current}`);
  }
  return next;
}

function command(command: string, args: readonly string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit status ${result.status ?? "unknown"}`;
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
  }
  return result.stdout.trim();
}

function commandSucceeds(executable: string, args: readonly string[]): boolean {
  return spawnSync(executable, args, { stdio: "ignore" }).status === 0;
}

function assertCleanWorktree(): void {
  if (command("git", ["status", "--porcelain", "--untracked-files=all"])) {
    throw new Error("Working tree must be clean before preparing a release");
  }
}

function readPackage(packagePath: string): { private?: boolean; version?: string; [key: string]: unknown } {
  return JSON.parse(readFileSync(packagePath, "utf8"));
}

export function main(args = process.argv.slice(2)): void {
  if (args.length !== 1) {
    throw new Error("Usage: pnpm release:prepare <major|minor|patch|X.Y.Z>");
  }

  const root = command("git", ["rev-parse", "--show-toplevel"]);
  if (path.resolve(root) !== path.resolve(process.cwd())) {
    throw new Error("Run release preparation from the repository root");
  }
  if (command("git", ["branch", "--show-current"]) !== "main") {
    throw new Error("Release preparation must start on main");
  }
  assertCleanWorktree();

  const packagePath = path.join(root, "package.json");
  const packageJson = readPackage(packagePath);
  if (packageJson.private !== true || typeof packageJson.version !== "string") {
    throw new Error("package.json must remain private and contain the application version");
  }
  const nextVersion = resolveReleaseVersion(packageJson.version, args[0]);
  const tag = `v${nextVersion}`;
  const branch = `release/${tag}`;

  command("gh", ["auth", "status"]);
  command("git", ["fetch", "--quiet", "origin", "refs/heads/main:refs/remotes/origin/main", "--tags"]);
  assertCleanWorktree();
  if (command("git", ["rev-parse", "HEAD"]) !== command("git", ["rev-parse", "origin/main"])) {
    throw new Error("Local main must exactly match origin/main; pull or push outstanding commits first");
  }
  if (commandSucceeds("git", ["show-ref", "--verify", "--quiet", `refs/tags/${tag}`])) {
    throw new Error(`Tag ${tag} already exists`);
  }
  if (commandSucceeds("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])) {
    throw new Error(`Local branch ${branch} already exists`);
  }
  if (command("git", ["ls-remote", "--heads", "origin", `refs/heads/${branch}`])) {
    throw new Error(`Remote branch ${branch} already exists`);
  }

  command("git", ["switch", "--create", branch]);
  packageJson.version = nextVersion;
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

  // pnpm does not encode the root package version in lockfile v9, but this
  // reconciles pnpm-lock.yaml whenever package metadata requires a lock update.
  command("pnpm", ["install", "--lockfile-only"]);
  const changedFiles = command("git", ["status", "--porcelain", "--untracked-files=all"])
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3));
  if (
    !changedFiles.includes("package.json") ||
    changedFiles.some((file) => !["package.json", "pnpm-lock.yaml"].includes(file))
  ) {
    throw new Error(`Unexpected release preparation changes: ${changedFiles.join(", ")}`);
  }

  command("git", ["add", "package.json", "pnpm-lock.yaml"]);
  command("git", ["commit", "-m", `chore: prepare ${tag}`]);
  command("git", ["push", "--set-upstream", "origin", branch]);
  command("gh", [
    "pr",
    "create",
    "--base",
    "main",
    "--head",
    branch,
    "--title",
    `chore: prepare ${tag}`,
    "--body",
    `Prepare ${tag}. After this PR passes Baseline Validation and merges, release automation will publish the tag and GitHub Release at the validated merge SHA.`,
  ]);
  console.log(`Opened release preparation PR for ${tag} from ${branch}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`[RELEASE-PREP] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
