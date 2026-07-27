import { readFileSync } from "node:fs";
import path from "node:path";
import { workerSecretAllowlist } from "@/lib/runtime-config-schema";
import { describe, expect, it } from "vitest";

describe("deployment credential boundary", () => {
  it("excludes local human AWS credentials from the general Worker secret uploader", () => {
    const deploySource = readFileSync(path.resolve(process.cwd(), "scripts/deploy-cloudflare.sh"), "utf8");

    expect(workerSecretAllowlist).not.toContain("AWS_ACCESS_KEY_ID");
    expect(workerSecretAllowlist).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(workerSecretAllowlist).not.toContain("AWS_SESSION_TOKEN");
    expect(deploySource).toContain("AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN");
    expect(deploySource).toContain("is_worker_secret_ignored");
    expect(deploySource).toContain("env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN");
    expect(deploySource).toContain("AWS_ACCESS_KEY_ID=*|AWS_SECRET_ACCESS_KEY=*|AWS_SESSION_TOKEN=*");
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
});
