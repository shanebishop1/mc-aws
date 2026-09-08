import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const rotationScript = path.resolve(process.cwd(), "scripts/cloudflare/rotate-worker-runtime-key.sh");
const temporaryDirectories: string[] = [];
const runtimeSecretCanary = "new-runtime-secret";

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function writeExecutable(filePath: string, source: string): void {
  writeFileSync(filePath, source, { mode: 0o700 });
  chmodSync(filePath, 0o700);
}

type ProbeResponse = "success" | "404" | "502" | "503" | "transport" | "authFailure";

function runRotation(options: { probeResponses?: ProbeResponse[]; noPriorKey?: boolean; maxAttempts?: number } = {}) {
  const tempDirectory = mkdtempSync(path.join(tmpdir(), "mc-aws-runtime-rotation-"));
  temporaryDirectories.push(tempDirectory);
  const eventLog = path.join(tempDirectory, "events.log");
  const stateFile = path.join(tempDirectory, "state");
  const awsPath = path.join(tempDirectory, "aws-mock");
  const wranglerPath = path.join(tempDirectory, "wrangler-mock");
  const curlPath = path.join(tempDirectory, "curl-mock");
  const curlStateFile = path.join(tempDirectory, "curl-state");

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
const procArgv = fs.readFileSync("/proc/" + process.pid + "/cmdline").toString();
const procEnv = fs.readFileSync("/proc/" + process.pid + "/environ").toString();
const stdin = fs.readFileSync(0, "utf8");
const name = args.at(-1);
const argvExposure = procArgv.includes(${JSON.stringify(runtimeSecretCanary)}) || procArgv.includes("Bearer ");
const envExposure = procEnv.includes(${JSON.stringify(runtimeSecretCanary)});
if (args.includes("bulk")) process.exitCode = 9;
fs.appendFileSync(${JSON.stringify(eventLog)}, "wrangler " + args.join(" ") + " stdin-present=" + Boolean(stdin) + " argv-secret=" + argvExposure + " env-secret=" + envExposure + "\\n");
process.stdout.write("{}")
`
  );

  writeExecutable(
    curlPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const responses = process.env.PROBE_RESPONSES.split(",");
const attempt = fs.existsSync(process.env.CURL_STATE_FILE) ? Number(fs.readFileSync(process.env.CURL_STATE_FILE, "utf8")) : 0;
const response = responses[Math.min(attempt, responses.length - 1)];
fs.writeFileSync(process.env.CURL_STATE_FILE, String(attempt + 1));
const outputIndex = args.indexOf("--output");
const outputFile = args[outputIndex + 1];
const url = args.at(-1);
  const procArgv = fs.readFileSync("/proc/" + process.pid + "/cmdline").toString();
  const procEnv = fs.readFileSync("/proc/" + process.pid + "/environ").toString();
  fs.appendFileSync(process.env.EVENT_LOG, "curl " + url + " response=" + response + " http1=" + args.includes("--http1.1") + " config-stdin=" + args.includes("--config") + " argv-secret=" + procArgv.includes("Bearer ") + " env-secret=" + procEnv.includes("PROBE_TOKEN") + "\\n");
if (response === "transport") {
  process.stdout.write("000");
  process.exit(7);
}
const status = response === "success" ? "200" : response === "authFailure" ? "502" : response;
const body = response === "success"
  ? { success: true, data: { managedInstanceVerified: true } }
  : { success: false, error: response === "authFailure" ? "AuthFailure" : "temporarily unavailable" };
fs.writeFileSync(outputFile, JSON.stringify(body));
process.stdout.write(status);
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
      CURL_STATE_FILE: curlStateFile,
      PROBE_RESPONSES: (options.probeResponses ?? ["success"]).join(","),
      NO_PRIOR_KEY: options.noPriorKey ? "1" : "0",
      VERIFY_MAX_ATTEMPTS: String(options.maxAttempts ?? 4),
      VERIFY_RETRY_DELAY_SECONDS: "0",
      VERIFY_REQUEST_TIMEOUT_SECONDS: "1",
      RUNTIME_IAM_USER_NAME: "mc-aws-runtime-user",
      SKIP_RUNTIME_IDENTITY_TAG_CHECK: "1",
      WORKER_NAME: "mc-aws-panel",
      VERIFY_URL: "https://panel.example.com",
      WRANGLER_CONFIG_FILE: "/dev/null",
      WRANGLER_HOME_DIR: tempDirectory,
      TMPDIR: tempDirectory,
      MC_AWS_DEPLOYMENT_MANIFEST: path.join(tempDirectory, "deployment-manifest.json"),
      MC_AWS_CLOUDFLARE_RECOVERY_RECORD: path.join(tempDirectory, "runtime-recovery.json"),
      CLOUDFLARE_API_TOKEN: "",
      CLOUDFLARE_DEPLOY_API_TOKEN: "",
    },
  });

  const events = readFileSync(eventLog, "utf8");
  return { result, events, tempDirectory };
}

describe("Worker runtime key rotation", { timeout: 20_000 }, () => {
  it("journals every phase, never deletes unclassified inactive keys, and never attempts to reactivate deleted keys", () => {
    const source = readFileSync(rotationScript, "utf8");
    for (const phase of [
      "candidate-created",
      "candidate-create-intent",
      "candidate-staging",
      "candidate-staged",
      "candidate-verified",
      "primary-promotion-intent",
      "primary-promoted",
      "prepared",
      "commit-decided",
      "primary-verification-intent",
      "primary-verification-complete",
      "prior-deactivation-intent",
      "prior-deactivated",
      "temporary-secrets-removal-intent",
      "temporary-secrets-removed",
      "prior-key-deletion-intent",
      "finalized",
      "rollback-intent",
      "rolled-back",
    ]) {
      expect(source).toContain(`runtime_journal ${phase}`);
    }
    expect(source).toContain("durableReplaceFile");
    expect(source).toContain("previousKeyIds");
    expect(source).toContain("newKeyId");
    expect(source).toContain("refusing to delete unclassified recovery state");
    expect(source).toContain("record_worker_identity_after_final_secret_mutation");
    expect(
      source.indexOf(
        "record_worker_identity_after_final_secret_mutation adopt\n    fi\n    runtime_journal temporary-secrets-removed"
      )
    ).toBeGreaterThan(-1);
    expect(source).not.toContain("--status Active");
  });
  it("uploads and verifies replacement credentials before revoking the prior runtime key", () => {
    const { result, events } = runRotation();

    expect(result.status, `${result.stdout}\n${result.stderr}\n${events}`).toBe(0);
    expect(events).toContain(
      "secret put --config /dev/null --name mc-aws-panel MC_AWS_RUNTIME_CANDIDATE_ACCESS_KEY_ID"
    );
    expect(events).toContain(
      "secret put --config /dev/null --name mc-aws-panel MC_AWS_RUNTIME_CANDIDATE_SECRET_ACCESS_KEY"
    );
    expect(events).toContain("secret put --config /dev/null --name mc-aws-panel MC_AWS_RUNTIME_CREDENTIAL_PROBE_TOKEN");
    expect(events).toContain("secret put --config /dev/null --name mc-aws-panel AWS_ACCESS_KEY_ID");
    expect(events).toContain("secret put --config /dev/null --name mc-aws-panel AWS_SECRET_ACCESS_KEY");
    expect(events).toContain("secret put --config /dev/null --name mc-aws-panel AWS_SESSION_TOKEN");
    expect(events).not.toContain("bulk");
    expect(events).not.toContain(runtimeSecretCanary);
    expect(events).not.toContain("argv-secret=true");
    expect(events).not.toContain("env-secret=true");

    const candidateVerification = events.indexOf("mode=candidate");
    const primaryVerification = events.indexOf("mode=primary");
    const priorRevocation = events.indexOf("--access-key-id AKIAOLD --status Inactive");
    const priorDeletion = events.indexOf("delete-access-key --user-name mc-aws-runtime-user --access-key-id AKIAOLD");
    expect(candidateVerification).toBeGreaterThan(-1);
    expect(primaryVerification).toBeGreaterThan(candidateVerification);
    expect(events).toContain("http1=true");
    expect(priorRevocation).toBeGreaterThan(primaryVerification);
    expect(priorDeletion).toBeGreaterThan(priorRevocation);
  });

  it("retries transient deployment and AWS propagation failures before promotion", () => {
    const { result, events } = runRotation({
      probeResponses: ["404", "502", "authFailure", "success", "transport", "success", "success"],
    });

    expect(result.status, `${result.stdout}\n${result.stderr}\n${events}`).toBe(0);
    expect(events.match(/mode=candidate/g)).toHaveLength(4);
    expect(events.match(/mode=primary/g)).toHaveLength(4);
    expect(result.stdout).toContain("candidate verification succeeded on attempt 4/4");
    expect(result.stdout).toContain("primary verification succeeded on attempt 2/4");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("AuthFailure");
  });

  it("retains the prior valid key and deletes the candidate after persistent verification failure", () => {
    const { result, events } = runRotation({ probeResponses: ["502"], maxAttempts: 3 });

    expect(result.status).not.toBe(0);
    expect(events.match(/mode=candidate/g)).toHaveLength(3);
    expect(events).not.toContain("--access-key-id AKIAOLD --status Inactive");
    expect(events).not.toContain("delete-access-key --user-name mc-aws-runtime-user --access-key-id AKIAOLD");
    expect(events).toContain("delete-access-key --user-name mc-aws-runtime-user --access-key-id AKIANEW");
    expect(result.stderr).toContain("did not succeed within 3 attempts");
  });

  it("removes the private verification response file after a failed run", () => {
    const { result, tempDirectory } = runRotation({ probeResponses: ["502"], maxAttempts: 1 });

    expect(result.status).not.toBe(0);
    expect(readdirSync(tempDirectory).filter((entry) => entry.startsWith("mc-aws-runtime-verify."))).toEqual([]);
  });

  it("supports first deployment when the runtime identity has no prior key", () => {
    const { result, events } = runRotation({ noPriorKey: true });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(events).toContain("mode=candidate");
    expect(events).toContain("mode=primary");
    expect(events).not.toContain("update-access-key");
  });
});
