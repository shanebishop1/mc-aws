import { readFileSync } from "node:fs";
import path from "node:path";
import { workerSecretAllowlist } from "@/lib/runtime-config-schema";
import { describe, expect, it } from "vitest";
import { deployOnlyIgnoredSecretNames } from "./deploy-env";

describe("deployment credential boundary", () => {
  it("excludes local human AWS credentials from the general Worker secret uploader", () => {
    const deploySource = readFileSync(path.resolve(process.cwd(), "scripts/cloudflare/deploy-cloudflare.sh"), "utf8");

    expect(workerSecretAllowlist).not.toContain("AWS_ACCESS_KEY_ID");
    expect(workerSecretAllowlist).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(workerSecretAllowlist).not.toContain("AWS_SESSION_TOKEN");
    expect(deployOnlyIgnoredSecretNames.has("AWS_ACCESS_KEY_ID")).toBe(true);
    expect(deployOnlyIgnoredSecretNames.has("AWS_SECRET_ACCESS_KEY")).toBe(true);
    expect(deployOnlyIgnoredSecretNames.has("AWS_SESSION_TOKEN")).toBe(true);
    expect(deploySource).toContain("scripts/validation/build-child-isolation-cli.ts run");
    expect(deploySource).toContain("scripts/cloudflare/deploy-env.ts sanitize-build-env");
    expect(deploySource).toContain("bash scripts/cloudflare/rotate-worker-runtime-key.sh");
    expect(deploySource).toContain("exec {DEPLOY_ENV_FD}<&-");
    expect(deploySource).toContain("NEXT_BUILD_DOTENV_FILES=(");
    expect(deploySource).toContain("scan-artifacts");
    expect(deploySource.indexOf("scan-artifacts")).toBeLessThan(deploySource.indexOf('echo "🔑 Uploading secrets'));
  });

  it("uses the local AWS CLI session instead of collecting human keys in the setup wizard", () => {
    const wizardSource = readFileSync(path.resolve(process.cwd(), "scripts/setup/setup-wizard.sh"), "utf8");

    expect(wizardSource).toContain("aws sts get-caller-identity");
    expect(wizardSource).toContain("aws sso login");
    expect(wizardSource).not.toContain("prompt AWS_ACCESS_KEY_ID");
    expect(wizardSource).not.toContain("prompt AWS_SECRET_ACCESS_KEY");
    expect(wizardSource).not.toContain('write_env_files "AWS_ACCESS_KEY_ID"');
    expect(wizardSource).not.toContain('write_env_files "AWS_SECRET_ACCESS_KEY"');
  });

  it("keeps deploy and panel-route credentials out of Worker secrets and build input", () => {
    const deploySource = readFileSync(path.resolve(process.cwd(), "scripts/cloudflare/deploy-cloudflare.sh"), "utf8");
    const packageSource = readFileSync(path.resolve(process.cwd(), "package.json"), "utf8");

    expect(workerSecretAllowlist).not.toContain("CLOUDFLARE_API_TOKEN");
    expect(workerSecretAllowlist).not.toContain("CLOUDFLARE_PANEL_DNS_API_TOKEN");
    expect(workerSecretAllowlist).not.toContain("PANEL_DNS_MANAGEMENT");
    expect(deployOnlyIgnoredSecretNames.has("CLOUDFLARE_API_TOKEN")).toBe(true);
    expect(deployOnlyIgnoredSecretNames.has("CLOUDFLARE_DEPLOY_API_TOKEN")).toBe(true);
    expect(deployOnlyIgnoredSecretNames.has("CLOUDFLARE_PANEL_DNS_API_TOKEN")).toBe(true);
    expect(deployOnlyIgnoredSecretNames.has("PANEL_DNS_MANAGEMENT")).toBe(true);
    expect(deploySource).toContain("scripts/cloudflare/deploy-env.ts worker-secret-names");
    expect(deploySource).toContain("worker-secret-value");
    expect(deploySource).not.toContain("put_secret_base64");
    expect(deploySource).not.toContain('Buffer.from(process.argv[1], "base64")');
    expect(deploySource).toContain('env -i PATH="$PATH" HOME="${HOME:-}" TMPDIR="$TMPDIR"');
    expect(deploySource).toContain("DEPLOY_ARTIFACT_MERKLE_SHA256");
    expect(deploySource).toContain("worker-version-evidence");
    expect(packageSource).toContain("build:production:check");
    expect(packageSource).toContain("tsx scripts/validation/production-build-contract.ts");
    expect(packageSource).not.toContain("AUTH_SECRET=");
    expect(packageSource).not.toContain('"predeploy:cf"');
  });

  it("keeps the generic Cloudflare deploy token out of CDK runtime parameters", () => {
    const setupSource = readFileSync(path.resolve(process.cwd(), "setup.sh"), "utf8");
    const stackSource = readFileSync(path.resolve(process.cwd(), "infra/lib/minecraft-stack.ts"), "utf8");

    expect(setupSource.match(/unset CLOUDFLARE_API_TOKEN/g)).toHaveLength(2);
    expect(stackSource).not.toContain("process.env.CLOUDFLARE_API_TOKEN");
    expect(stackSource).not.toContain("process.env.CLOUDFLARE_DNS_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN");
    expect(stackSource).toContain("requireSuccessfulIsolatedBuildChild");
    const hostPackage = stackSource.indexOf('"scripts/setup/build-host-release.mjs"');
    expect(stackSource.lastIndexOf("requireSuccessfulIsolatedBuildChild", hostPackage)).toBeGreaterThan(-1);
  });

  it("uses the shell deploy token only as an external-mode route API fallback and preserves DNS", () => {
    const deploySource = readFileSync(path.resolve(process.cwd(), "scripts/cloudflare/deploy-cloudflare.sh"), "utf8");

    expect(deploySource).toContain('PANEL_DNS_MANAGEMENT" == "external" && -z "$CF_DNS_API_TOKEN"');
    expect(deploySource).toContain('CF_DNS_API_TOKEN="$CLOUDFLARE_DEPLOY_API_TOKEN"');
    const managedDnsBranch = deploySource.indexOf('"$PANEL_DNS_MANAGEMENT" == "managed" ]]; then');
    expect(managedDnsBranch).toBeGreaterThan(-1);
    expect(deploySource.indexOf("ensure_panel_dns", managedDnsBranch)).toBeGreaterThan(managedDnsBranch);
    expect(deploySource).toContain("Preserving externally managed panel DNS");
    expect(deploySource.lastIndexOf("capture_panel_route_before_deploy\n")).toBeLessThan(
      deploySource.lastIndexOf('"$PANEL_DNS_MANAGEMENT" == "managed"')
    );
    expect(deploySource.match(/^capture_panel_route_after_deploy$/gm)).toHaveLength(2);
    expect(deploySource.lastIndexOf("\ncapture_panel_route_after_deploy\n")).toBeGreaterThan(
      deploySource.indexOf('echo "✅ Worker bindings restored"')
    );
  });

  it("keeps Worker values out of child argv/environment and uses stdin for each upload", () => {
    const deploySource = readFileSync(path.resolve(process.cwd(), "scripts/cloudflare/deploy-cloudflare.sh"), "utf8");
    const rotationSource = readFileSync(
      path.resolve(process.cwd(), "scripts/cloudflare/rotate-worker-runtime-key.sh"),
      "utf8"
    );

    expect(deploySource).toContain("--config - -sS -q");
    expect(deploySource).not.toContain("Bearer ${CF_DNS_API_TOKEN}");
    expect(rotationSource).toContain("put_runtime_secret");
    expect(rotationSource).toContain("--config - --http1.1");
    expect(rotationSource).not.toContain("MC_SECRET_ACCESS_KEY=");
    expect(rotationSource).not.toContain("MC_PROBE_TOKEN=");
    expect(rotationSource).not.toContain('-H "Authorization: Bearer $PROBE_TOKEN"');
  });
});
