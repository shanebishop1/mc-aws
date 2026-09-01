import { existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type ArtifactGroup = "all" | "build" | "next" | "test" | "cdk";

const artifactPaths: Record<Exclude<ArtifactGroup, "all">, readonly string[]> = {
  build: [
    ".next",
    ".open-next",
    ".local-artifacts/build-tmp",
    ".local-artifacts/opennext-tmp",
    ".local-artifacts/cloudflare-tmp",
    "out",
    "build",
    "next-env.d.ts",
    "tsconfig.tsbuildinfo",
  ],
  next: [".next", ".local-artifacts/build-tmp", "out", "build", "next-env.d.ts", "tsconfig.tsbuildinfo"],
  test: ["coverage", "playwright-report", "test-results", "artifacts", ".local-artifacts/test-tmp"],
  cdk: ["infra/cdk.out", ".local-artifacts/cdk-tmp"],
};

function pathsFor(group: ArtifactGroup): readonly string[] {
  if (group !== "all") return artifactPaths[group];
  return Object.values(artifactPaths).flat();
}

export function cleanRepositoryArtifacts(root: string, group: ArtifactGroup): string[] {
  const resolvedRoot = realpathSync(root);
  const removed: string[] = [];
  for (const relativePath of pathsFor(group)) {
    const candidate = path.resolve(resolvedRoot, relativePath);
    const relative = path.relative(resolvedRoot, candidate);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Refusing to clean path outside the repository: ${relativePath}`);
    }
    let current = resolvedRoot;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
        throw new Error(`Refusing to clean through a symbolic link: ${path.relative(resolvedRoot, current)}`);
      }
    }
    if (!existsSync(candidate)) continue;
    rmSync(candidate, { recursive: true, force: true, maxRetries: 3 });
    removed.push(relativePath);
  }
  return removed;
}

export function parseArtifactGroup(input: string | undefined): ArtifactGroup {
  const group = input ?? "all";
  if (group === "all" || group === "build" || group === "next" || group === "test" || group === "cdk") return group;
  throw new Error("Usage: pnpm clean[:build|:test|:cdk]");
}

function main(args = process.argv.slice(2)): void {
  if (args.length > 1) throw new Error("Usage: pnpm clean[:build|:test|:cdk]");
  const group = parseArtifactGroup(args[0]);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const repositoryArtifacts = cleanRepositoryArtifacts(root, group);
  console.log(`Cleaned ${repositoryArtifacts.length} ${group} artifact path(s).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
