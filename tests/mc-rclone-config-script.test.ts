import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = path.resolve(process.cwd(), "infra/src/ec2/mc-rclone-config.sh");
const cleanupDirs: string[] = [];
const validToken = {
  access_token: "secret-access-token",
  token_type: "Bearer",
  refresh_token: "secret-refresh-token",
  expiry: "2030-01-02T03:04:05.000Z",
};

const makeExecutable = (filePath: string, contents: string): void => {
  writeFileSync(filePath, contents, "utf8");
  chmodSync(filePath, 0o755);
};

const createHarness = () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "mc-rclone-config-test-"));
  cleanupDirs.push(rootDir);
  const binDir = path.join(rootDir, "bin");
  const configPath = path.join(rootDir, "rclone", "rclone.conf");
  const remoteFile = path.join(rootDir, "gdrive-remote");
  const awsLog = path.join(rootDir, "aws.log");
  const awsPath = path.join(binDir, "aws-mock");
  mkdirSync(binDir);
  writeFileSync(remoteFile, "persisted-drive\n", "utf8");
  makeExecutable(
    awsPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${awsLog}"
if [[ "\${RCLONE_TEST_AWS_FAIL:-0}" == "1" ]]; then
  exit 1
fi
printf '%s' "\${RCLONE_TEST_TOKEN:-}"
`
  );

  const run = (extraEnv: Record<string, string | undefined> = {}, args: string[] = []) =>
    spawnSync("bash", [scriptPath, ...args], {
      env: {
        ...process.env,
        MC_RCLONE_AWS_CLI: awsPath,
        MC_RCLONE_CONFIG_PATH: configPath,
        MC_RCLONE_REMOTE_FILE: remoteFile,
        MC_RCLONE_CONFIG_OWNER: String(process.getuid?.() ?? 0),
        MC_RCLONE_CONFIG_GROUP: String(process.getgid?.() ?? 0),
        RCLONE_TEST_TOKEN: JSON.stringify(validToken, null, 2),
        ...extraEnv,
      },
      encoding: "utf8",
    });

  return { awsLog, configPath, run };
};

afterEach(() => {
  for (const dir of cleanupDirs.splice(0, cleanupDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("mc-rclone-config.sh", () => {
  it("is executable Bash", () => {
    expect(spawnSync("bash", ["-n", scriptPath]).status).toBe(0);
    expect(statSync(scriptPath).mode & 0o111).not.toBe(0);
  });

  it("decrypts, validates, compacts, and atomically materializes the persisted remote", () => {
    const harness = createHarness();

    const result = harness.run();

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(harness.awsLog, "utf8")).toBe(
      "ssm get-parameter --name /minecraft/gdrive-token --with-decryption --query Parameter.Value --output text\n"
    );
    expect(readFileSync(harness.configPath, "utf8")).toBe(
      `[persisted-drive]\ntype = drive\ntoken = ${JSON.stringify(validToken)}\n`
    );
    expect(statSync(harness.configPath).mode & 0o777).toBe(0o600);
  });

  it("materializes deployment OAuth client credentials from the versioned envelope without exposing them", () => {
    const harness = createHarness();
    const clientId = "deployment-client-id";
    const clientSecret = "deployment-client-secret";
    const envelope = { version: 1, client_id: clientId, client_secret: clientSecret, token: validToken };

    const result = harness.run({ RCLONE_TEST_TOKEN: JSON.stringify(envelope) });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(harness.configPath, "utf8")).toBe(
      `[persisted-drive]\ntype = drive\nclient_id = ${clientId}\nclient_secret = ${clientSecret}\ntoken = ${JSON.stringify(validToken)}\n`
    );
    expect(output).not.toContain(clientId);
    expect(output).not.toContain(clientSecret);
    expect(statSync(harness.configPath).mode & 0o777).toBe(0o600);
  });

  it("keeps an existing config and does not expose an invalid token", () => {
    const harness = createHarness();
    mkdirSync(path.dirname(harness.configPath), { recursive: true });
    writeFileSync(harness.configPath, "existing-config\n", "utf8");
    const invalidSecret = "do-not-log-this-secret";

    const result = harness.run({ RCLONE_TEST_TOKEN: `{"access_token":"${invalidSecret}"}` });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain(invalidSecret);
    expect(readFileSync(harness.configPath, "utf8")).toBe("existing-config\n");
  });

  it("allows an unavailable token only in bootstrap mode", () => {
    const harness = createHarness();

    const bootstrapResult = harness.run({ RCLONE_TEST_AWS_FAIL: "1" }, ["--bootstrap"]);
    const runtimeResult = harness.run({ RCLONE_TEST_AWS_FAIL: "1" });

    expect(bootstrapResult.status, bootstrapResult.stderr).toBe(0);
    expect(runtimeResult.status).not.toBe(0);
    expect(existsSync(harness.configPath)).toBe(false);
  });

  it("rejects an unsafe remote name before retrieving the token", () => {
    const harness = createHarness();

    const result = harness.run({ GDRIVE_REMOTE: "drive]\ntoken = exposed" });

    expect(result.status).not.toBe(0);
    expect(existsSync(harness.awsLog)).toBe(false);
    expect(existsSync(harness.configPath)).toBe(false);
  });
});
