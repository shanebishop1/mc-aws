import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const rotationScript = path.resolve(process.cwd(), "scripts/rotate-worker-runtime-key.sh");

function writeExecutable(filePath: string, source: string): void {
  writeFileSync(filePath, source, { mode: 0o700 });
  chmodSync(filePath, 0o700);
}

function runRotation(options: { failProbe?: boolean; noPriorKey?: boolean } = {}) {
  const tempDirectory = mkdtempSync(path.join(tmpdir(), "mc-aws-runtime-rotation-"));
  const eventLog = path.join(tempDirectory, "events.log");
  const stateFile = path.join(tempDirectory, "state");
  const awsPath = path.join(tempDirectory, "aws-mock");
  const wranglerPath = path.join(tempDirectory, "wrangler-mock");
  const curlPath = path.join(tempDirectory, "curl-mock");

  writeExecutable(
    awsPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.EVENT_LOG, "aws " + args.join(" ") + "\\n");
const command = args.join(" ");
if (command.includes("list-access-keys")) {
  const hasNew = fs.existsSync(process.env.STATE_FILE);
  const keys = process.env.NO_PRIOR_KEY === "1" ? [] : [{ AccessKeyId: "AKIAOLD", Status: "Active" }];
  if (hasNew) keys.push({ AccessKeyId: "AKIANEW", Status: "Active" });
  process.stdout.write(JSON.stringify({ AccessKeyMetadata: keys }));
} else if (command.includes("create-access-key")) {
  fs.writeFileSync(process.env.STATE_FILE, "created");
  process.stdout.write(JSON.stringify({ AccessKey: { AccessKeyId: "AKIANEW", SecretAccessKey: "new-runtime-secret" } }));
} else {
  process.stdout.write("{}");
}
`
  );

  writeExecutable(
    wranglerPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
let suffix = "";
if (args.includes("bulk")) {
  const payload = JSON.parse(fs.readFileSync(0, "utf8"));
  suffix = " " + Object.keys(payload).sort().join(",");
}
fs.appendFileSync(${JSON.stringify(eventLog)}, "wrangler " + args.join(" ") + suffix + "\\n");
process.stdout.write("{}")
`
  );

  writeExecutable(
    curlPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.EVENT_LOG, "curl " + args.at(-1) + "\\n");
if (process.env.FAIL_PROBE === "1") process.exit(22);
process.stdout.write(JSON.stringify({ success: true, data: { managedInstanceVerified: true } }));
`
  );

  const result = spawnSync("bash", [rotationScript], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      AWS_CLI: awsPath,
      WRANGLER_BIN: wranglerPath,
      CURL_BIN: curlPath,
      EVENT_LOG: eventLog,
      STATE_FILE: stateFile,
      FAIL_PROBE: options.failProbe ? "1" : "0",
      NO_PRIOR_KEY: options.noPriorKey ? "1" : "0",
      RUNTIME_IAM_USER_NAME: "mc-aws-runtime-user",
      SKIP_RUNTIME_IDENTITY_TAG_CHECK: "1",
      WORKER_NAME: "mc-aws-panel",
      VERIFY_URL: "https://panel.example.com",
      WRANGLER_CONFIG_FILE: "/dev/null",
      WRANGLER_HOME_DIR: tempDirectory,
      CLOUDFLARE_API_TOKEN: "",
      CLOUDFLARE_DEPLOY_API_TOKEN: "",
    },
  });

  const events = readFileSync(eventLog, "utf8");
  return { result, events };
}

describe("Worker runtime key rotation", () => {
  it("uploads and verifies replacement credentials before revoking the prior runtime key", () => {
    const { result, events } = runRotation();

    expect(result.status, `${result.stdout}\n${result.stderr}\n${events}`).toBe(0);
    expect(events).toContain(
      "MC_AWS_RUNTIME_CANDIDATE_ACCESS_KEY_ID,MC_AWS_RUNTIME_CANDIDATE_SECRET_ACCESS_KEY,MC_AWS_RUNTIME_CREDENTIAL_PROBE_TOKEN"
    );
    expect(events).toContain("AWS_ACCESS_KEY_ID,AWS_SECRET_ACCESS_KEY,AWS_SESSION_TOKEN");

    const candidateVerification = events.indexOf("mode=candidate");
    const primaryVerification = events.indexOf("mode=primary");
    const priorRevocation = events.indexOf("--access-key-id AKIAOLD --status Inactive");
    const priorDeletion = events.indexOf("delete-access-key --user-name mc-aws-runtime-user --access-key-id AKIAOLD");
    expect(candidateVerification).toBeGreaterThan(-1);
    expect(primaryVerification).toBeGreaterThan(candidateVerification);
    expect(priorRevocation).toBeGreaterThan(primaryVerification);
    expect(priorDeletion).toBeGreaterThan(priorRevocation);
  });

  it("retains the prior valid key when candidate verification fails", () => {
    const { result, events } = runRotation({ failProbe: true });

    expect(result.status).not.toBe(0);
    expect(events).not.toContain("--access-key-id AKIAOLD --status Inactive");
    expect(events).not.toContain("delete-access-key --user-name mc-aws-runtime-user --access-key-id AKIAOLD");
    expect(events).toContain("delete-access-key --user-name mc-aws-runtime-user --access-key-id AKIANEW");
  });

  it("supports first deployment when the runtime identity has no prior key", () => {
    const { result, events } = runRotation({ noPriorKey: true });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(events).toContain("mode=candidate");
    expect(events).toContain("mode=primary");
    expect(events).not.toContain("update-access-key");
  });
});
