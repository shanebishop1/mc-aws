import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { type LambdaAssetId, lambdaAssetRuntimeFiles, markerFileName } from "../../infra/lib/lambda-assets";

const assemblyDirectory = realpathSync(path.resolve(process.argv[2] || "infra/cdk.out"));
const expectedAssetIds = new Set(Object.keys(lambdaAssetRuntimeFiles));
const requiredAssetIds = new Set(
  process.env.MC_REQUIRE_ALL_LAMBDA_ASSETS === "true"
    ? expectedAssetIds
    : [
        "FailureEventSanitizer",
        "MigrateServerActionLock",
        "RetainLambdaLogs",
        "SeedEmailAllowlist",
        "StartMinecraftServer",
      ]
);
const auditedAssetIds = new Set<string>();

function walk(
  directory: string,
  visitor: (absolutePath: string, relativePath: string) => void,
  root = directory
): void {
  for (const entry of readdirSync(directory).sort()) {
    const absolutePath = path.join(directory, entry);
    const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
    const stat = lstatSync(absolutePath);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      throw new Error(`Lambda artifact contains a link or special entry: ${relativePath}`);
    }
    visitor(absolutePath, relativePath);
    if (stat.isDirectory()) walk(absolutePath, visitor, root);
  }
}

const manifestNames = readdirSync(assemblyDirectory).filter((name) => name.endsWith(".assets.json"));
if (manifestNames.length === 0) throw new Error(`No CDK asset manifest found in ${assemblyDirectory}`);

for (const manifestName of manifestNames) {
  const manifest = JSON.parse(readFileSync(path.join(assemblyDirectory, manifestName), "utf8"));
  for (const fileAsset of Object.values(manifest.files || {}) as Array<{ source?: { path?: string } }>) {
    if (!fileAsset.source?.path) continue;
    const sourcePath = realpathSync(path.resolve(assemblyDirectory, fileAsset.source.path));
    if (!statSync(sourcePath).isDirectory()) continue;
    const markerPath = path.join(sourcePath, markerFileName);
    let marker: { assetId: LambdaAssetId; runtimeFiles: string[] };
    try {
      marker = JSON.parse(readFileSync(markerPath, "utf8"));
    } catch {
      continue;
    }
    if (!expectedAssetIds.has(marker.assetId) || auditedAssetIds.has(marker.assetId)) {
      throw new Error(`Unexpected or duplicate Lambda asset marker: ${marker.assetId}`);
    }
    const expectedRuntimeFiles = [...lambdaAssetRuntimeFiles[marker.assetId]].sort();
    if (JSON.stringify([...marker.runtimeFiles].sort()) !== JSON.stringify(expectedRuntimeFiles)) {
      throw new Error(`Lambda marker runtime inventory mismatch: ${marker.assetId}`);
    }

    const topLevelRuntimeFiles: string[] = [];
    const inventory: string[] = [];
    walk(sourcePath, (absolutePath, relativePath) => {
      if (
        !relativePath.startsWith("node_modules/") &&
        /\.test\.|\.test$|\.ts$|\.env|\.git|\.log$|tsconfig/i.test(relativePath)
      ) {
        throw new Error(`Forbidden file in Lambda deployment artifact: ${relativePath}`);
      }
      if (lstatSync(absolutePath).isFile()) {
        if (
          !relativePath.startsWith("node_modules/") &&
          !["package.json", "package-lock.json", markerFileName].includes(relativePath)
        ) {
          topLevelRuntimeFiles.push(relativePath);
        }
        const digest = createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
        inventory.push(`${relativePath}\t${lstatSync(absolutePath).size}\t${digest}`);
      }
    });
    if (JSON.stringify(topLevelRuntimeFiles.sort()) !== JSON.stringify(expectedRuntimeFiles)) {
      throw new Error(`Deployed runtime file inventory mismatch for ${marker.assetId}`);
    }
    if (!statSync(path.join(sourcePath, "node_modules")).isDirectory()) {
      throw new Error(`Production dependencies are missing from ${marker.assetId}`);
    }

    execFileSync("npm", ["ls", "--omit=dev", "--all", "--json"], {
      cwd: sourcePath,
      stdio: "pipe",
      maxBuffer: 16 * 1024 * 1024,
    });
    execFileSync("npm", ["audit", "--omit=dev", "--audit-level=high"], { cwd: sourcePath, stdio: "inherit" });
    const inventoryDigest = createHash("sha256").update(inventory.sort().join("\n")).digest("hex");
    console.log(
      `Audited exact CDK Lambda asset ${marker.assetId}: ${inventory.length} files, sha256=${inventoryDigest}`
    );
    auditedAssetIds.add(marker.assetId);
  }
}

const missing = [...requiredAssetIds].filter((assetId) => !auditedAssetIds.has(assetId));
if (missing.length > 0) throw new Error(`Expected CDK Lambda assets were not audited: ${missing.join(", ")}`);
