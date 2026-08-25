import { readFileSync } from "node:fs";
import path from "node:path";
import { workerSecretAllowlist } from "@/lib/runtime-config-schema";
import { describe, expect, it } from "vitest";
import { deployOnlyIgnoredSecretNames } from "./deploy-env";

describe("deployment credential boundary", () => {
  it("excludes local human AWS credentials from the general Worker secret uploader", () => {
    const deploySource = readFileSync(path.resolve(process.cwd(), "scripts/deploy-cloudflare.sh"), "utf8");

    expect(workerSecretAllowlist).not.toContain("AWS_ACCESS_KEY_ID");
    expect(workerSecretAllowlist).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(workerSecretAllowlist).not.toContain("AWS_SESSION_TOKEN");
    expect(deployOnlyIgnoredSecretNames.has("AWS_ACCESS_KEY_ID")).toBe(true);
    expect(deployOnlyIgnoredSecretNames.has("AWS_SECRET_ACCESS_KEY")).toBe(true);
    expect(deployOnlyIgnoredSecretNames.has("AWS_SESSION_TOKEN")).toBe(true);
    expect(deploySource).toContain("env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN");
    expect(deploySource).toContain("deploy-env.ts sanitize-build-env");
    expect(deploySource).toContain("bash scripts/rotate-worker-runtime-key.sh");
  });

  it("uses the local AWS CLI session instead of collecting human keys in the setup wizard", () => {
    const wizardSource = readFileSync(path.resolve(process.cwd(), "scripts/setup-wizard.sh"), "utf8");

    expect(wizardSource).toContain("aws sts get-caller-identity");
    expect(wizardSource).toContain("aws sso login");
    expect(wizardSource).not.toContain("prompt AWS_ACCESS_KEY_ID");
    expect(wizardSource).not.toContain("prompt AWS_SECRET_ACCESS_KEY");
    expect(wizardSource).not.toContain('write_env_files "AWS_ACCESS_KEY_ID"');
    expect(wizardSource).not.toContain('write_env_files "AWS_SECRET_ACCESS_KEY"');
  });

  it("keeps deploy and panel-route credentials out of Worker secrets and build input", () => {
    const deploySource = readFileSync(path.resolve(process.cwd(), "scripts/deploy-cloudflare.sh"), "utf8");
    const standaloneUploaderSource = readFileSync(path.resolve(process.cwd(), "scripts/upload-secrets.sh"), "utf8");

    expect(workerSecretAllowlist).not.toContain("CLOUDFLARE_API_TOKEN");
    expect(workerSecretAllowlist).not.toContain("CLOUDFLARE_PANEL_DNS_API_TOKEN");
    expect(workerSecretAllowlist).not.toContain("PANEL_DNS_MANAGEMENT");
    expect(deployOnlyIgnoredSecretNames.has("CLOUDFLARE_API_TOKEN")).toBe(true);
    expect(deployOnlyIgnoredSecretNames.has("CLOUDFLARE_DEPLOY_API_TOKEN")).toBe(true);
    expect(deployOnlyIgnoredSecretNames.has("CLOUDFLARE_PANEL_DNS_API_TOKEN")).toBe(true);
    expect(deployOnlyIgnoredSecretNames.has("PANEL_DNS_MANAGEMENT")).toBe(true);
    expect(deploySource).toContain("deploy-env.ts worker-secret-entries");
    expect(deploySource).toContain("put_secret_base64");
    expect(standaloneUploaderSource).toContain("deploy-env.ts worker-secret-entries");
  });

  it("keeps the generic Cloudflare deploy token out of CDK runtime parameters", () => {
    const setupSource = readFileSync(path.resolve(process.cwd(), "setup.sh"), "utf8");
    const stackSource = readFileSync(path.resolve(process.cwd(), "infra/lib/minecraft-stack.ts"), "utf8");

    expect(setupSource.match(/unset CLOUDFLARE_API_TOKEN/g)).toHaveLength(2);
    expect(stackSource).toContain('const cloudflareToken = (process.env.CLOUDFLARE_DNS_API_TOKEN || "").trim()');
    expect(stackSource).not.toContain("process.env.CLOUDFLARE_DNS_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN");
  });

  it("uses the shell deploy token only as an external-mode route API fallback and preserves DNS", () => {
    const deploySource = readFileSync(path.resolve(process.cwd(), "scripts/deploy-cloudflare.sh"), "utf8");

    expect(deploySource).toContain('PANEL_DNS_MANAGEMENT" == "external" && -z "$CF_DNS_API_TOKEN"');
    expect(deploySource).toContain('CF_DNS_API_TOKEN="$CLOUDFLARE_DEPLOY_API_TOKEN"');
    expect(deploySource).toContain('"$PANEL_DNS_MANAGEMENT" == "managed" ]]; then\n  ensure_panel_dns');
    expect(deploySource).toContain("Preserving externally managed panel DNS");
    expect(deploySource.indexOf("capture_panel_route_before_deploy")).toBeLessThan(
      deploySource.indexOf('"$PANEL_DNS_MANAGEMENT" == "managed"')
    );
    expect(deploySource.match(/^capture_panel_route_after_deploy$/gm)).toHaveLength(2);
    expect(deploySource.lastIndexOf("\ncapture_panel_route_after_deploy\n")).toBeGreaterThan(
      deploySource.indexOf('echo "✅ Worker bindings restored"')
    );
  });
});
