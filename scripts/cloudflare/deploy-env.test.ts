import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildWorkerSecretUploadEntries,
  deploymentArtifactMerkleSha256,
  deploymentReceiptSha256,
  deploymentUploadConfigSha256,
  sanitizeDeploymentBuildEnv,
  scanDeploymentArtifacts,
  sealWorkerUploadStage,
  stageFinalWorkerUpload,
  stageWorkerUpload,
  verifyActiveWorkerVersionEvidence,
  verifyExactActiveWorkerReceipt,
  workerRollbackDecision,
  workerSecretNames,
  workerSecretValue,
} from "./deploy-env";

const backupFencePrivateKey = generateKeyPairSync("ed25519")
  .privateKey.export({ format: "der", type: "pkcs8" })
  .toString("base64");
const executorReceiptSpki = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" });
const executorReceiptKeyId = `executor-receipt-${createHash("sha256").update(executorReceiptSpki).digest("hex")}`;
const executorReceiptVerifiers = JSON.stringify({
  schemaVersion: 1,
  currentKeyId: executorReceiptKeyId,
  verifiers: [
    {
      schemaVersion: 1,
      keyId: executorReceiptKeyId,
      publicKeySpki: executorReceiptSpki.toString("base64"),
    },
  ],
});

const rootDir = path.resolve(process.cwd());
const helperPath = path.join(rootDir, "scripts/cloudflare/deploy-env.ts");
const temporaryDirectories: string[] = [];
const publicProviderCatalog = JSON.stringify({
  schemaVersion: 1,
  profiles: [
    {
      schemaVersion: 1,
      profileId: "reviewed-provider",
      providerId: "reviewed-openai-api",
      providerKind: "openai-compatible",
      displayName: "Reviewed provider",
      endpoint: "https://provider.example.com",
      allowedModels: ["reviewed-model"],
      supportedFeatures: ["streaming", "tools"],
    },
  ],
});
const runtimeProviderProfiles = publicProviderCatalog;
const validAuthSecret = "jyp8kdTmswhaH5xy5NaoA3tcHpTyqGDTx-WbFKgm8Nk";

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("deployment build environment sanitization", () => {
  it("removes AUTH_SECRET and all build-time secret canaries", () => {
    const source = [
      `AUTH_SECRET=${validAuthSecret}`,
      "GOOGLE_CLIENT_SECRET=google-secret-canary",
      "CLOUDFLARE_DNS_API_TOKEN=dns-token-canary",
      "ADMIN_EMAIL=admin@example.com",
      "MC_BACKEND_MODE=aws",
      "NEXT_PUBLIC_APP_URL=https://panel.example.com",
    ].join("\n");

    const output = sanitizeDeploymentBuildEnv(source);
    expect(output).not.toContain(validAuthSecret);
    expect(output).not.toContain("google-secret-canary");
    expect(output).not.toContain("dns-token-canary");
    expect(output).not.toContain("ADMIN_EMAIL=admin@example.com");
    expect(output).toContain("MC_BACKEND_MODE=aws");
  });

  it("keeps runtime-only names and values out of the build environment", () => {
    const source = [
      `AUTH_SECRET=${validAuthSecret}`,
      "ADMIN_EMAIL=admin@example.com",
      "MC_AGENT_RUNTIME_TOKEN=runtime-bearer-canary",
      `MC_AGENT_RUNTIME_TOKEN_SHA256=${"ab".repeat(32)}`,
      `MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8=${backupFencePrivateKey}`,
      "NEXT_PUBLIC_APP_URL=https://panel.example.com",
    ].join("\n");

    const output = sanitizeDeploymentBuildEnv(source);
    for (const canary of [validAuthSecret, "runtime-bearer-canary", "ab".repeat(32), backupFencePrivateKey]) {
      expect(output).not.toContain(canary);
    }
    expect(output).toContain("NEXT_PUBLIC_APP_URL=https://panel.example.com");
  });

  it("filters deployment-only keys across dotenv whitespace and export forms", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-aws-deploy-env-"));
    temporaryDirectories.push(tempDir);
    const envFile = path.join(tempDir, "source.env");
    const outputFile = path.join(tempDir, "build.env");
    fs.writeFileSync(
      envFile,
      [
        "SAFE_SETTING=retained",
        "  AWS_ACCESS_KEY_ID = local-only",
        "export    AWS_SECRET_ACCESS_KEY=local-only",
        "\texport\tAWS_SESSION_TOKEN \t= local-only",
        " export CLOUDFLARE_API_TOKEN = deploy-only",
        "CLOUDFLARE_DEPLOY_API_TOKEN = deploy-only",
        " export   CLOUDFLARE_PANEL_DNS_API_TOKEN=panel-only",
        " export AUTH_SECRET: colon-secret",
        " AWS_SECRET_ACCESS_KEY: colon-access-key",
        "  PANEL_DNS_MANAGEMENT = external",
      ].join("\n")
    );

    execFileSync(
      process.execPath,
      ["--import", "tsx", helperPath, "sanitize-build-env", "--env-file", envFile, "--output", outputFile],
      {
        cwd: rootDir,
        stdio: "pipe",
      }
    );

    const output = fs.readFileSync(outputFile, "utf8");
    expect(output).not.toContain("SAFE_SETTING=retained");
    expect(output).toContain("AWS_ACCESS_KEY_ID=\nAWS_SECRET_ACCESS_KEY=\nAWS_SESSION_TOKEN=");
    expect(output).not.toContain("CLOUDFLARE_API_TOKEN");
    expect(output).not.toContain("CLOUDFLARE_DEPLOY_API_TOKEN");
    expect(output).not.toContain("CLOUDFLARE_PANEL_DNS_API_TOKEN");
    expect(output).not.toContain("PANEL_DNS_MANAGEMENT");
    expect(output).not.toContain("colon-secret");
    expect(output).not.toContain("colon-access-key");
  });
});

describe("deploy artifact secret scan", () => {
  it("requires finalized Wrangler bytes and remains unchanged after transitive checkout mutation", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-aws-worker-stage-"));
    temporaryDirectories.push(tempDir);
    fs.mkdirSync(path.join(tempDir, "nested"));
    fs.mkdirSync(path.join(tempDir, "assets"));
    fs.writeFileSync(
      path.join(tempDir, "wrangler.jsonc"),
      JSON.stringify({ main: "worker.mjs", assets: { directory: "assets" }, vars: {} })
    );
    fs.writeFileSync(
      path.join(tempDir, "worker.mjs"),
      'import "@/nested/first.js"; import "package-export"; export default {};\n'
    );
    fs.writeFileSync(path.join(tempDir, "nested/first.js"), 'import "./second.js"; import "package-export";\n');
    fs.writeFileSync(path.join(tempDir, "nested/second.js"), "export const value = 'before';\n");
    fs.mkdirSync(path.join(tempDir, "node_modules/package-export"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "node_modules/package-export/package.json"), '{"exports":"./index.js"}\n');
    fs.writeFileSync(
      path.join(tempDir, "node_modules/package-export/index.js"),
      "export const packageValue = 'before';\n"
    );
    fs.writeFileSync(path.join(tempDir, "assets/index.html"), "immutable asset\n");
    const bundle = path.join(tempDir, "bundle");
    fs.mkdirSync(bundle);
    fs.writeFileSync(
      path.join(bundle, "worker.js"),
      "import './resolved-dep.mjs'; export const value = 'bundled-before'; export const packageValue = 'resolved';\n"
    );
    fs.writeFileSync(path.join(bundle, "resolved-dep.mjs"), "export const resolved = true;\n");
    fs.writeFileSync(path.join(bundle, "README.md"), "Wrangler diagnostics\n");
    fs.writeFileSync(path.join(bundle, "bundle-meta.json"), "{}\n");
    expect(() => stageWorkerUpload()).toThrow("finalized prebundled upload");
    const stage = stageFinalWorkerUpload(
      path.join(tempDir, "wrangler.jsonc"),
      bundle,
      path.join(tempDir, "assets"),
      path.join(tempDir, "stage")
    );
    const configDigest = deploymentUploadConfigSha256(path.join(stage, "wrangler.jsonc"));
    fs.writeFileSync(
      path.join(stage, "wrangler.jsonc"),
      `${JSON.stringify({ main: "artifact/worker.js", assets: { directory: "artifact/assets" }, vars: { MC_AWS_UPLOAD_CONFIG_SHA256: "d".repeat(64) } })}\n`
    );
    expect(deploymentUploadConfigSha256(path.join(stage, "wrangler.jsonc"))).toBe(configDigest);
    fs.writeFileSync(
      path.join(stage, "wrangler.jsonc"),
      `${JSON.stringify({ name: "mutated-worker", main: "artifact/worker.js", assets: { directory: "artifact/assets" }, vars: { MC_AWS_UPLOAD_CONFIG_SHA256: "d".repeat(64) } })}\n`
    );
    expect(deploymentUploadConfigSha256(path.join(stage, "wrangler.jsonc"))).not.toBe(configDigest);
    const before = deploymentArtifactMerkleSha256([path.join(stage, "artifact")]);
    fs.writeFileSync(path.join(tempDir, "nested/second.js"), "export const value = 'after';\n");
    fs.writeFileSync(path.join(tempDir, "nested/first.js"), "export const value = 'alias-mutated';\n");
    fs.writeFileSync(
      path.join(tempDir, "node_modules/package-export/index.js"),
      "export const packageValue = 'after';\n"
    );
    expect(deploymentArtifactMerkleSha256([path.join(stage, "artifact")])).toBe(before);
    expect(fs.readFileSync(path.join(stage, "artifact/worker.js"), "utf8")).toContain("bundled-before");
    expect(fs.readFileSync(path.join(stage, "artifact/worker.js"), "utf8")).toContain("packageValue = 'resolved'");
    expect(fs.existsSync(path.join(stage, "artifact/README.md"))).toBe(false);
    expect(fs.existsSync(path.join(stage, "artifact/bundle-meta.json"))).toBe(false);
    expect(fs.readFileSync(path.join(stage, "artifact/assets/index.html"), "utf8")).toContain("immutable asset");
    sealWorkerUploadStage(stage);
    expect(() => fs.writeFileSync(path.join(stage, "artifact/worker.js"), "tampered")).toThrow();
    for (const directory of [stage, path.join(stage, "artifact"), path.join(stage, "artifact/assets")]) {
      fs.chmodSync(directory, 0o700);
    }
  });

  it("Merkle-addresses exact upload contents, names, and directory structure", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-aws-artifact-merkle-"));
    temporaryDirectories.push(tempDir);
    const worker = path.join(tempDir, "worker.mjs");
    const output = path.join(tempDir, ".open-next");
    fs.mkdirSync(output);
    fs.writeFileSync(worker, "import worker from './.open-next/worker.js';\n");
    fs.writeFileSync(path.join(output, "worker.js"), "export default {};\n");
    const first = deploymentArtifactMerkleSha256([worker, output]);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(deploymentArtifactMerkleSha256([worker, output])).toBe(first);
    fs.writeFileSync(path.join(output, "worker.js"), "export default { fetch() {} };\n");
    expect(deploymentArtifactMerkleSha256([worker, output])).not.toBe(first);
  });

  it("attests exact provider active version, script ETag, and both plain-text bindings", () => {
    const artifact = "a".repeat(64);
    const receipt = "b".repeat(64);
    const uploadConfig = "c".repeat(64);
    const versionId = "11111111-2222-4333-8444-555555555555";
    const deploymentId = "66666666-7777-4888-8999-000000000000";
    const deployments = JSON.stringify({
      id: deploymentId,
      versions: [{ version_id: versionId, percentage: 100 }],
    });
    const version = JSON.stringify({
      id: versionId,
      resources: {
        script: { etag: "provider-etag-123" },
        bindings: [
          { name: "MC_AWS_ARTIFACT_MERKLE_SHA256", type: "plain_text", text: artifact },
          { name: "MC_AWS_RECEIPT_VERIFIER_SET_SHA256", type: "plain_text", text: receipt },
          { name: "MC_AWS_UPLOAD_CONFIG_SHA256", type: "plain_text", text: uploadConfig },
        ],
      },
    });
    expect(verifyActiveWorkerVersionEvidence(deployments, version, artifact, receipt, uploadConfig)).toEqual({
      deploymentId,
      versionId,
      scriptEtag: "provider-etag-123",
    });
    expect(() =>
      verifyActiveWorkerVersionEvidence(
        deployments,
        version.replace(artifact, "d".repeat(64)),
        artifact,
        receipt,
        uploadConfig
      )
    ).toThrow("artifact Merkle binding");
    expect(() =>
      verifyActiveWorkerVersionEvidence(
        deployments.replace(versionId, "99999999-2222-4333-8444-555555555555"),
        version.replace(versionId, "22222222-2222-4333-8444-555555555555"),
        artifact,
        receipt,
        uploadConfig
      )
    ).toThrow("not the exact active version");
  });

  it("domain-separates the immutable deployment receipt and detects tuple changes", () => {
    const tuple = {
      deploymentId: "deployment-1",
      versionId: "version-1",
      scriptEtag: "etag-1",
      artifactMerkleSha256: "a".repeat(64),
      receiptVerifierSetSha256: "b".repeat(64),
      uploadConfigSha256: "c".repeat(64),
    };
    const receipt = deploymentReceiptSha256(tuple);
    expect(receipt).toMatch(/^[a-f0-9]{64}$/);
    expect(deploymentReceiptSha256({ ...tuple, versionId: "version-2" })).not.toBe(receipt);
    expect(deploymentReceiptSha256({ ...tuple, scriptEtag: "etag-2" })).not.toBe(receipt);
    expect(() => deploymentReceiptSha256({ ...tuple, artifactMerkleSha256: "c" })).toThrow("digests are malformed");
  });

  it("rejects an active tuple change between the first and publication status reads", () => {
    const artifact = "a".repeat(64);
    const verifier = "b".repeat(64);
    const config = "c".repeat(64);
    const deploymentId = "66666666-7777-4888-8999-000000000000";
    const versionId = "11111111-2222-4333-8444-555555555555";
    const version = JSON.stringify({
      id: versionId,
      resources: {
        script: { etag: "etag" },
        bindings: [
          { name: "MC_AWS_ARTIFACT_MERKLE_SHA256", type: "plain_text", text: artifact },
          { name: "MC_AWS_RECEIPT_VERIFIER_SET_SHA256", type: "plain_text", text: verifier },
          { name: "MC_AWS_UPLOAD_CONFIG_SHA256", type: "plain_text", text: config },
        ],
      },
    });
    const status = JSON.stringify({ id: deploymentId, versions: [{ version_id: versionId, percentage: 100 }] });
    expect(
      verifyExactActiveWorkerReceipt(status, version, status, version, artifact, verifier, config)
        .deploymentReceiptSha256
    ).toMatch(/^[a-f0-9]{64}$/);
    expect(() =>
      verifyExactActiveWorkerReceipt(
        status,
        version,
        status.replace(versionId, "22222222-2222-4333-8444-555555555555"),
        version.replace(versionId, "22222222-2222-4333-8444-555555555555"),
        artifact,
        verifier,
        config
      )
    ).toThrow("changed between publication observations");
  });

  it("rejects an OpenNext artifact containing an exact secret canary without echoing it", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-aws-artifact-scan-"));
    temporaryDirectories.push(tempDir);
    const artifact = path.join(tempDir, ".open-next");
    fs.mkdirSync(artifact);
    const canary = "auth-secret-artifact-canary";
    fs.writeFileSync(path.join(artifact, "worker.js"), `compiled=${canary}`);

    expect(() => scanDeploymentArtifacts([artifact], [canary])).toThrow(
      "Deploy artifact scan found forbidden secret material"
    );
    try {
      scanDeploymentArtifacts([artifact], [canary]);
    } catch (error) {
      expect(String(error)).not.toContain(canary);
    }
  });

  it("passes clean Next and OpenNext artifact trees", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-aws-artifact-scan-clean-"));
    temporaryDirectories.push(tempDir);
    const next = path.join(tempDir, ".next");
    const openNext = path.join(tempDir, ".open-next");
    fs.mkdirSync(next);
    fs.mkdirSync(openNext);
    fs.writeFileSync(path.join(next, "BUILD_ID"), "safe-build");
    fs.writeFileSync(path.join(openNext, "worker.js"), "safe-worker");

    expect(() => scanDeploymentArtifacts([next, openNext], [validAuthSecret, "secret-canary"])).not.toThrow();
  });

  it("rejects runtime-only administrator identity material in deploy artifacts", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-aws-artifact-runtime-only-"));
    temporaryDirectories.push(tempDir);
    const artifact = path.join(tempDir, ".open-next");
    const source = path.join(tempDir, "source.env");
    fs.mkdirSync(artifact);
    fs.writeFileSync(path.join(artifact, "worker.js"), `compiled=${validAuthSecret}`);
    fs.writeFileSync(
      source,
      `ADMIN_EMAIL=admin@example.com\nAUTH_SECRET=${validAuthSecret}\nMC_AGENT_RUNTIME_ENABLED=false\n`
    );

    try {
      execFileSync(
        process.execPath,
        ["--import", "tsx", helperPath, "scan-artifacts", "--env-file", source, "--path", artifact],
        { cwd: rootDir, encoding: "utf8", stdio: "pipe" }
      );
      throw new Error("expected runtime-only artifact scan to fail");
    } catch (error) {
      expect(String(error)).not.toContain("admin@example.com");
      expect(String(error)).toContain("Deploy artifact scan found forbidden secret material");
    }
  });

  it.each([
    ".mock-state.json",
    "nested/oauth-client.json",
    "nested/credentials.snapshot",
    "nested/secure-string-values.json",
  ])("rejects suspicious artifact filename %s without needing an exact value", (relativePath) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-aws-artifact-filename-scan-"));
    temporaryDirectories.push(tempDir);
    const artifact = path.join(tempDir, ".open-next");
    const filePath = path.join(artifact, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "opaque material");

    expect(() => scanDeploymentArtifacts([artifact])).toThrow("Deploy artifact scan found forbidden secret material");
  });

  it.each([
    '{"parameter":{"type":"SecureString","value":"mock-secure-string-canary"}}',
    '{"oauth":{"client_secret":"oauth-client-canary","refresh_token":"refresh-canary"}}',
    'export const credentials = { token: "opaque-token-canary" };',
  ])("rejects broad secret-like persisted structures without an exact env value", (content) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-aws-artifact-structure-scan-"));
    temporaryDirectories.push(tempDir);
    const artifact = path.join(tempDir, ".next");
    fs.mkdirSync(artifact);
    fs.writeFileSync(path.join(artifact, "manifest.bin"), content);

    expect(() => scanDeploymentArtifacts([artifact])).toThrow("Deploy artifact scan found forbidden secret material");
  });
});

describe("Worker rollback compare-and-swap", () => {
  const baseline = [{ versionId: "version-a", percentage: 100 }];
  const status = (deploymentId: string, versionId: string): string =>
    JSON.stringify({ id: deploymentId, versions: [{ version_id: versionId, percentage: 100 }] });

  it("restores A only while this transaction's exact deployment B remains active", () => {
    expect(workerRollbackDecision(status("deployment-b", "version-b"), baseline, "deployment-b")).toBe(
      "restore-baseline"
    );
  });

  it("treats an already-restored baseline A as idempotent after a crash", () => {
    expect(workerRollbackDecision(status("rollback-deployment", "version-a"), baseline, "deployment-b")).toBe(
      "already-baseline"
    );
  });

  it("never overwrites concurrent deployment C", () => {
    expect(() => workerRollbackDecision(status("deployment-c", "version-c"), baseline, "deployment-b")).toThrow(
      "concurrent state C"
    );
    expect(() => workerRollbackDecision(status("unknown", "version-b"), baseline, null)).toThrow(
      "no transaction-applied deployment B"
    );
  });
});

describe("Worker secret upload entries", () => {
  it("uploads a selected-file deprecated DNS alias under only the canonical key", () => {
    const entries = buildWorkerSecretUploadEntries(
      `AUTH_SECRET=${validAuthSecret}\nMC_AGENT_RUNTIME_ENABLED=false\nexport   CLOUDFLARE_API_TOKEN = file-runtime-token\n`
    );

    expect(entries).toContainEqual({ key: "CLOUDFLARE_DNS_API_TOKEN", value: "file-runtime-token" });
    expect(entries.some(({ key }) => key === "CLOUDFLARE_API_TOKEN")).toBe(false);
  });

  it("prefers a canonical selected-file token over the deprecated alias", () => {
    const entries = buildWorkerSecretUploadEntries(
      `AUTH_SECRET=${validAuthSecret}\nMC_AGENT_RUNTIME_ENABLED=false\nCLOUDFLARE_DNS_API_TOKEN=canonical-runtime-token\nCLOUDFLARE_API_TOKEN=deprecated-runtime-token\n`
    );

    expect(entries).toContainEqual({ key: "CLOUDFLARE_DNS_API_TOKEN", value: "canonical-runtime-token" });
    expect(entries.some(({ value }) => value === "deprecated-runtime-token")).toBe(false);
  });

  it("never derives compatibility input from the shell deployment token", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-aws-deploy-secret-"));
    temporaryDirectories.push(tempDir);
    const envFile = path.join(tempDir, "selected.env");
    fs.writeFileSync(envFile, `MC_AGENT_RUNTIME_ENABLED=false\nAUTH_SECRET=${validAuthSecret}\n`);

    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", helperPath, "worker-secret-entries", "--env-file", envFile],
      {
        cwd: rootDir,
        encoding: "utf8",
        env: { ...process.env, CLOUDFLARE_API_TOKEN: "shell-deploy-token" },
      }
    );

    expect(output).toContain("AUTH_SECRET\n");
    expect(output.trim().split(/\r?\n/)).toEqual(["AUTH_SECRET", "MC_AGENT_RUNTIME_ENABLED"]);
    expect(output).not.toContain("CLOUDFLARE_DNS_API_TOKEN");
    expect(output).not.toContain("CLOUDFLARE_API_TOKEN");
    expect(output).not.toContain(validAuthSecret);
  });

  it("returns a selected value only on stdout while the command contract carries names", () => {
    const source = `AUTH_SECRET=${validAuthSecret}\nADMIN_EMAIL=admin@example.com\nMC_AGENT_RUNTIME_ENABLED=false\nMC_BACKEND_MODE=aws\n`;

    expect(workerSecretNames(source)).toEqual(["AUTH_SECRET", "ADMIN_EMAIL", "MC_AGENT_RUNTIME_ENABLED"]);
    expect(workerSecretNames(source)).not.toContain("MC_BACKEND_MODE");
    expect(workerSecretValue(source, "AUTH_SECRET")).toBe(validAuthSecret);
    expect(() => workerSecretValue(source, "NOT_APPROVED")).toThrow(
      "Refusing to read unapproved or unset Worker secret key: NOT_APPROVED"
    );
  });

  it("treats the exact setup-managed AMI pin as deploy-only metadata", () => {
    const entries = buildWorkerSecretUploadEntries(
      `MC_AGENT_RUNTIME_ENABLED=false\nAUTH_SECRET=${validAuthSecret}\nAL2023_ARM64_AMI_ID=ami-${"1".repeat(17)}\n`
    );

    expect(entries).toContainEqual({ key: "AUTH_SECRET", value: validAuthSecret });
    expect(entries.some(({ key }) => key === "AL2023_ARM64_AMI_ID")).toBe(false);
  });

  it("accepts bootstrap provenance and emits DynamoDB table names only as deploy-config vars", () => {
    const entries = buildWorkerSecretUploadEntries(
      [
        `AUTH_SECRET=${validAuthSecret}`,
        "MC_AGENT_RUNTIME_ENABLED=false",
        `MC_BOOTSTRAP_PINS_SHA256=${"a1".repeat(32)}`,
        "MC_LIFECYCLE_LOCK_TABLE_NAME=mc-aws-lifecycle-lock",
        "MC_OPERATION_STATE_TABLE_NAME=mc-aws-operation-state",
      ].join("\n")
    );

    expect(entries).toContainEqual({ key: "AUTH_SECRET", value: validAuthSecret });
    expect(entries.some(({ key }) => key === "MC_BOOTSTRAP_PINS_SHA256")).toBe(false);
    expect(entries.some(({ key }) => key === "MC_LIFECYCLE_LOCK_TABLE_NAME")).toBe(false);
    expect(entries.some(({ key }) => key === "MC_OPERATION_STATE_TABLE_NAME")).toBe(false);
  });

  it.each(["mock", "AWS", "invalid"])("rejects noncanonical Worker backend mode %s", (mode) => {
    expect(() =>
      buildWorkerSecretUploadEntries(
        `AUTH_SECRET=${validAuthSecret}\nMC_BACKEND_MODE=${mode}\nMC_AGENT_RUNTIME_ENABLED=false\n`
      )
    ).toThrow('MC_BACKEND_MODE must be the canonical Worker value "aws".');
  });

  it("uploads the exact Agent runtime control-plane and credential-free provider keys", () => {
    const entries = buildWorkerSecretUploadEntries(
      [
        `AUTH_SECRET=${validAuthSecret}`,
        "MC_AGENT_RUNTIME_ENABLED=true",
        "MC_AGENT_RUNTIME_ID=minecraft-gateway",
        `MC_AGENT_RUNTIME_TOKEN_SHA256=${"ab".repeat(32)}`,
        `MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8=${backupFencePrivateKey}`,
        `MC_AGENT_EXECUTOR_RECEIPT_VERIFIERS='${executorReceiptVerifiers}'`,
        `MC_AGENT_PUBLIC_PROVIDER_CATALOG='${publicProviderCatalog}'`,
        `MC_AGENT_RUNTIME_PROVIDER_PROFILES='${runtimeProviderProfiles}'`,
      ].join("\n")
    );

    expect(entries).toEqual([
      { key: "AUTH_SECRET", value: validAuthSecret },
      { key: "MC_AGENT_RUNTIME_ENABLED", value: "true" },
      { key: "MC_AGENT_RUNTIME_ID", value: "minecraft-gateway" },
      { key: "MC_AGENT_RUNTIME_TOKEN_SHA256", value: "ab".repeat(32) },
      { key: "MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8", value: backupFencePrivateKey },
      { key: "MC_AGENT_EXECUTOR_RECEIPT_VERIFIERS", value: executorReceiptVerifiers },
      { key: "MC_AGENT_PUBLIC_PROVIDER_CATALOG", value: publicProviderCatalog },
      { key: "MC_AGENT_RUNTIME_PROVIDER_PROFILES", value: runtimeProviderProfiles },
    ]);
  });

  it.each(["OPENROUTER_API_KEY", "PROVIDER_SECRET"])("rejects unapproved provider secret input %s", (key) => {
    expect(() =>
      buildWorkerSecretUploadEntries(`MC_AGENT_RUNTIME_ENABLED=false\n${key}=not-a-real-provider-secret\n`)
    ).toThrow(`Refusing to upload unapproved Worker secret key(s): ${key}`);
  });

  it("rejects a credential reference embedded in the public catalog", () => {
    const sensitiveCatalog = publicProviderCatalog.replace(
      '"endpoint"',
      '"credentialRef":"secret-ref:providers/reviewed","endpoint"'
    );

    expect(() =>
      buildWorkerSecretUploadEntries(
        [
          `AUTH_SECRET=${validAuthSecret}`,
          "MC_AGENT_RUNTIME_ENABLED=true",
          "MC_AGENT_RUNTIME_ID=minecraft-gateway",
          `MC_AGENT_RUNTIME_TOKEN_SHA256=${"ab".repeat(32)}`,
          `MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8=${backupFencePrivateKey}`,
          `MC_AGENT_EXECUTOR_RECEIPT_VERIFIERS='${executorReceiptVerifiers}'`,
          `MC_AGENT_PUBLIC_PROVIDER_CATALOG='${sensitiveCatalog}'`,
          `MC_AGENT_RUNTIME_PROVIDER_PROFILES='${runtimeProviderProfiles}'`,
        ].join("\n")
      )
    ).toThrow("Refusing to upload invalid public Agent provider metadata.");
  });

  it.each([
    JSON.stringify(["reviewed-provider"]),
    runtimeProviderProfiles.replace("https://provider.example.com", "https://other.example.com"),
    runtimeProviderProfiles.replace('"reviewed-model"', '"substituted-model"'),
    runtimeProviderProfiles.replace('"openai-compatible"', '"openrouter"'),
  ])("rejects ID-only or substituted runtime profile metadata at deploy", (runtimeProfiles) => {
    expect(() =>
      buildWorkerSecretUploadEntries(
        [
          `AUTH_SECRET=${validAuthSecret}`,
          "MC_AGENT_RUNTIME_ENABLED=true",
          "MC_AGENT_RUNTIME_ID=minecraft-gateway",
          `MC_AGENT_RUNTIME_TOKEN_SHA256=${"ab".repeat(32)}`,
          `MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8=${backupFencePrivateKey}`,
          `MC_AGENT_EXECUTOR_RECEIPT_VERIFIERS='${executorReceiptVerifiers}'`,
          `MC_AGENT_PUBLIC_PROVIDER_CATALOG='${publicProviderCatalog}'`,
          `MC_AGENT_RUNTIME_PROVIDER_PROFILES='${runtimeProfiles}'`,
        ].join("\n")
      )
    ).toThrow("Refusing to upload invalid public Agent provider metadata.");
  });

  it("always requires and uploads an explicit false decommission state", () => {
    expect(() => buildWorkerSecretUploadEntries("AUTH_SECRET=selected-file-secret\n")).toThrow(
      'MC_AGENT_RUNTIME_ENABLED must be explicitly set to "true" or "false" for every Worker deploy.'
    );

    expect(buildWorkerSecretUploadEntries(`AUTH_SECRET=${validAuthSecret}\nMC_AGENT_RUNTIME_ENABLED=false\n`)).toEqual([
      { key: "AUTH_SECRET", value: validAuthSecret },
      { key: "MC_AGENT_RUNTIME_ENABLED", value: "false" },
    ]);

    expect(() => buildWorkerSecretUploadEntries("MC_AGENT_RUNTIME_ENABLED=false\n")).toThrow(
      "at least 32 cryptographically random bytes"
    );
    expect(() =>
      buildWorkerSecretUploadEntries("AUTH_SECRET=weak-existing-value\nMC_AGENT_RUNTIME_ENABLED=false\n")
    ).toThrow("at least 32 cryptographically random bytes");
  });

  it("rejects partial enabled runtime configuration instead of retaining old authorization", () => {
    expect(() =>
      buildWorkerSecretUploadEntries(
        `AUTH_SECRET=${validAuthSecret}\nMC_AGENT_RUNTIME_ENABLED=true\nMC_AGENT_RUNTIME_ID=minecraft-gateway\n`
      )
    ).toThrow(
      "MC_AGENT_RUNTIME_ENABLED=true requires complete Worker runtime configuration. Missing: MC_AGENT_RUNTIME_TOKEN_SHA256, MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8, MC_AGENT_EXECUTOR_RECEIPT_VERIFIERS, MC_AGENT_PUBLIC_PROVIDER_CATALOG, MC_AGENT_RUNTIME_PROVIDER_PROFILES."
    );
  });

  it("rejects malformed enabled runtime identity material", () => {
    const completeConfig = [
      `AUTH_SECRET=${validAuthSecret}`,
      "MC_AGENT_RUNTIME_ENABLED=true",
      "MC_AGENT_RUNTIME_ID=minecraft-gateway",
      `MC_AGENT_RUNTIME_TOKEN_SHA256=${"ab".repeat(32)}`,
      `MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8=${backupFencePrivateKey}`,
      `MC_AGENT_EXECUTOR_RECEIPT_VERIFIERS='${executorReceiptVerifiers}'`,
      `MC_AGENT_PUBLIC_PROVIDER_CATALOG='${publicProviderCatalog}'`,
      `MC_AGENT_RUNTIME_PROVIDER_PROFILES='${runtimeProviderProfiles}'`,
    ];
    expect(() =>
      buildWorkerSecretUploadEntries(completeConfig.with(2, "MC_AGENT_RUNTIME_ID=bad id").join("\n"))
    ).toThrow("Refusing to upload invalid MC_AGENT_RUNTIME_ID.");
    expect(() =>
      buildWorkerSecretUploadEntries(completeConfig.with(3, "MC_AGENT_RUNTIME_TOKEN_SHA256=ABC").join("\n"))
    ).toThrow("Refusing to upload invalid MC_AGENT_RUNTIME_TOKEN_SHA256.");
    expect(() =>
      buildWorkerSecretUploadEntries(
        completeConfig.with(4, "MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8=not-base64").join("\n")
      )
    ).toThrow("Refusing to upload invalid MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8.");
  });
});
