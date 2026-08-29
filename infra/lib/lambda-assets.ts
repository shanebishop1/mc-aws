import { execFileSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";

export const lambdaAssetRuntimeFiles = {
  AdoptDnsSecureString: ["index.js"],
  FailureEventSanitizer: ["index.js"],
  InboundEmailCommand: ["index.js"],
  MigrateServerActionLock: ["index.js"],
  RetainLambdaLogs: ["index.js"],
  SeedEmailAllowlist: ["index.js"],
  StartMinecraftServer: [
    "clients.js",
    "ec2.js",
    "execution-context.js",
    "failure-classification.js",
    "handlers/backup.js",
    "handlers/backups.js",
    "handlers/hibernate.js",
    "handlers/restore.js",
    "handlers/resume.js",
    "index.js",
    "lifecycle-lock.js",
    "notifications.js",
    "operation-state.js",
    "posix-shell.js",
    "restore-contract.js",
    "resume-command.js",
    "runtime-budgets.js",
    "sanitization.js",
    "ssm.js",
  ],
} as const;

export type LambdaAssetId = keyof typeof lambdaAssetRuntimeFiles;

const markerFileName = ".mc-aws-lambda-asset.json";
const stagingPrefix = "mc-aws-lambda-asset-";

function assertRegularSourceFile(sourceRoot: string, relativePath: string): string {
  const sourcePath = path.resolve(sourceRoot, relativePath);
  const relative = path.relative(sourceRoot, sourcePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Lambda asset path escapes its source directory: ${relativePath}`);
  }
  const stat = lstatSync(sourcePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Lambda asset source must be a regular non-symlink file: ${relativePath}`);
  }
  return sourcePath;
}

function copyApprovedFiles(assetId: LambdaAssetId, sourceRoot: string, destinationRoot: string): void {
  const files = ["package.json", "package-lock.json", ...lambdaAssetRuntimeFiles[assetId]];
  for (const relativePath of files) {
    const sourcePath = assertRegularSourceFile(sourceRoot, relativePath);
    const destinationPath = path.join(destinationRoot, relativePath);
    mkdirSync(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
    cpSync(sourcePath, destinationPath, { force: false, errorOnExist: true });
  }
}

function removeOwnedStagingDirectory(stagingDirectory: string): void {
  const resolved = realpathSync(stagingDirectory);
  const expectedParent = realpathSync(os.tmpdir());
  if (path.dirname(resolved) !== expectedParent || !path.basename(resolved).startsWith(stagingPrefix)) {
    throw new Error(`Refusing to clean unowned Lambda staging directory: ${resolved}`);
  }
  rmSync(resolved, { recursive: true, force: false, maxRetries: 3 });
}

function buildLambdaAsset(assetId: LambdaAssetId, sourceRoot: string, outputDirectory: string): void {
  const stagingDirectory = mkdtempSync(path.join(os.tmpdir(), stagingPrefix));
  const npmCache = path.join(stagingDirectory, ".npm-cache");
  try {
    copyApprovedFiles(assetId, sourceRoot, stagingDirectory);
    const isContractTest = process.env.VITEST === "true" && process.env.NODE_ENV === "test";
    if (!isContractTest) {
      execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
        cwd: stagingDirectory,
        env: { ...process.env, npm_config_cache: npmCache },
        stdio: "pipe",
        maxBuffer: 16 * 1024 * 1024,
      });
      execFileSync("npm", ["ls", "--omit=dev", "--all", "--json"], {
        cwd: stagingDirectory,
        env: { ...process.env, npm_config_cache: npmCache },
        stdio: "pipe",
        maxBuffer: 16 * 1024 * 1024,
      });
    }
    rmSync(npmCache, { recursive: true, force: true });
    writeFileSync(
      path.join(stagingDirectory, markerFileName),
      `${JSON.stringify({ assetId, runtimeFiles: lambdaAssetRuntimeFiles[assetId] }, null, 2)}\n`,
      { mode: 0o600 }
    );
    cpSync(stagingDirectory, outputDirectory, { recursive: true, force: false, errorOnExist: true });
  } finally {
    removeOwnedStagingDirectory(stagingDirectory);
  }
}

export function createLambdaDeploymentCode(assetId: LambdaAssetId, sourceRoot: string): lambda.AssetCode {
  return lambda.Code.fromAsset(sourceRoot, {
    // Hash the clean bundle, not the source directory. This binds deployment to
    // the exact npm-ci output and to helper/manifest changes.
    assetHashType: cdk.AssetHashType.OUTPUT,
    bundling: {
      image: lambda.Runtime.NODEJS_24_X.bundlingImage,
      local: {
        tryBundle(outputDirectory: string): boolean {
          buildLambdaAsset(assetId, sourceRoot, outputDirectory);
          return true;
        },
      },
      command: ["false"],
    },
  });
}

export { markerFileName };
