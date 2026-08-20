import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildWorkerSecretUploadEntries } from "./deploy-env";

const rootDir = path.resolve(process.cwd());
const helperPath = path.join(rootDir, "scripts/deploy-env.ts");

describe("deployment build environment sanitization", () => {
  it("filters deployment-only keys across dotenv whitespace and export forms", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-aws-deploy-env-"));
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
        "  PANEL_DNS_MANAGEMENT = external",
      ].join("\n")
    );

    execFileSync(
      "pnpm",
      ["exec", "tsx", helperPath, "sanitize-build-env", "--env-file", envFile, "--output", outputFile],
      {
        cwd: rootDir,
        stdio: "pipe",
      }
    );

    const output = fs.readFileSync(outputFile, "utf8");
    expect(output).toContain("SAFE_SETTING=retained");
    expect(output).toContain("AWS_ACCESS_KEY_ID=\nAWS_SECRET_ACCESS_KEY=\nAWS_SESSION_TOKEN=");
    expect(output).not.toContain("CLOUDFLARE_API_TOKEN");
    expect(output).not.toContain("CLOUDFLARE_DEPLOY_API_TOKEN");
    expect(output).not.toContain("CLOUDFLARE_PANEL_DNS_API_TOKEN");
    expect(output).not.toContain("PANEL_DNS_MANAGEMENT");
  });
});

describe("Worker secret upload entries", () => {
  it("uploads a selected-file deprecated DNS alias under only the canonical key", () => {
    const entries = buildWorkerSecretUploadEntries("export   CLOUDFLARE_API_TOKEN = file-runtime-token\n");

    expect(entries).toContainEqual({ key: "CLOUDFLARE_DNS_API_TOKEN", value: "file-runtime-token" });
    expect(entries.some(({ key }) => key === "CLOUDFLARE_API_TOKEN")).toBe(false);
  });

  it("prefers a canonical selected-file token over the deprecated alias", () => {
    const entries = buildWorkerSecretUploadEntries(
      "CLOUDFLARE_DNS_API_TOKEN=canonical-runtime-token\nCLOUDFLARE_API_TOKEN=deprecated-runtime-token\n"
    );

    expect(entries).toContainEqual({ key: "CLOUDFLARE_DNS_API_TOKEN", value: "canonical-runtime-token" });
    expect(entries.some(({ value }) => value === "deprecated-runtime-token")).toBe(false);
  });

  it("never derives compatibility input from the shell deployment token", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-aws-deploy-secret-"));
    const envFile = path.join(tempDir, "selected.env");
    fs.writeFileSync(envFile, "AUTH_SECRET=selected-file-secret\n");

    const output = execFileSync("pnpm", ["exec", "tsx", helperPath, "worker-secret-entries", "--env-file", envFile], {
      cwd: rootDir,
      encoding: "utf8",
      env: { ...process.env, CLOUDFLARE_API_TOKEN: "shell-deploy-token" },
    });

    expect(output).toContain("AUTH_SECRET\t");
    expect(output).not.toContain("CLOUDFLARE_DNS_API_TOKEN");
    expect(output).not.toContain("CLOUDFLARE_API_TOKEN");
  });
});
