import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = path.resolve(process.cwd(), "infra/src/ec2/check-mc-idle.sh");
const cleanupDirs: string[] = [];

const makeExecutable = (filePath: string, contents: string): void => {
  writeFileSync(filePath, contents, "utf8");
  chmodSync(filePath, 0o755);
};

interface Harness {
  rootDir: string;
  runScript: () => void;
  readAwsCalls: () => string;
  readLogs: () => string;
}

const createHarness = (sequence: string[], requiredObservations = 3): Harness => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "mc-idle-test-"));
  const binDir = path.join(rootDir, "bin");
  const stateDir = path.join(rootDir, "state");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  const sequencePath = path.join(stateDir, "mcstatus-sequence.txt");
  const indexPath = path.join(stateDir, "mcstatus-index.txt");
  const awsLogPath = path.join(stateDir, "aws-calls.log");
  const loggerLogPath = path.join(stateDir, "logger.log");

  writeFileSync(sequencePath, `${sequence.join("\n")}\n`, "utf8");
  writeFileSync(indexPath, "0", "utf8");
  writeFileSync(awsLogPath, "", "utf8");
  writeFileSync(loggerLogPath, "", "utf8");

  makeExecutable(
    path.join(binDir, "mcstatus"),
    `#!/usr/bin/env bash
set -euo pipefail
index=$(cat "${indexPath}")
line=$(sed -n "$((index + 1))p" "${sequencePath}")
echo "$((index + 1))" > "${indexPath}"

if [[ -z "\${line:-}" ]]; then
  line="ok:0"
fi

case "$line" in
  ok:*)
    players="\${line#ok:}"
    echo "players: \${players}/20"
    ;;
  fail)
    echo "network timeout" >&2
    exit 1
    ;;
  malformed)
    echo "players: unknown/20"
    ;;
  missing)
    echo "motd: demo"
    ;;
  *)
    echo "players: 0/20"
    ;;
esac
`
  );

  makeExecutable(
    path.join(binDir, "aws"),
    `#!/usr/bin/env bash
set -euo pipefail
printf "%s\n" "$*" >> "${awsLogPath}"
exit 0
`
  );

  makeExecutable(
    path.join(binDir, "logger"),
    `#!/usr/bin/env bash
set -euo pipefail
printf "%s\n" "$*" >> "${loggerLogPath}"
exit 0
`
  );

  makeExecutable(
    path.join(binDir, "systemctl"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "is-active" ]]; then
  exit 1
fi
exit 0
`
  );

  makeExecutable(
    path.join(binDir, "sleep"),
    `#!/usr/bin/env bash
set -euo pipefail
exit 0
`
  );

  const runScript = (): void => {
    const result = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        AWS_REGION: "us-west-2",
        INSTANCE_ID: "i-test123",
        MCSTATUS_BIN: path.join(binDir, "mcstatus"),
        MC_IDLE_MARKER: path.join(stateDir, "idle.marker"),
        MC_EMPTY_STREAK_FILE: path.join(stateDir, "idle.streak"),
        MC_MAINTENANCE_LOCK: path.join(stateDir, "maintenance.lock"),
        MC_IDLE_REQUIRED_EMPTY_OBSERVATIONS: String(requiredObservations),
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
  };

  return {
    rootDir,
    runScript,
    readAwsCalls: () => readFileSync(awsLogPath, "utf8"),
    readLogs: () => readFileSync(loggerLogPath, "utf8"),
  };
};

afterEach(() => {
  for (const dir of cleanupDirs.splice(0, cleanupDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("check-mc-idle.sh", () => {
  it("shuts down after required consecutive successful empty probes", () => {
    const harness = createHarness(["ok:0", "ok:0", "ok:0"], 3);
    cleanupDirs.push(harness.rootDir);

    harness.runScript();
    harness.runScript();
    harness.runScript();

    const awsCalls = harness.readAwsCalls();
    expect(awsCalls).toContain("ssm put-parameter");
    expect(awsCalls).toContain("ec2 stop-instances --instance-ids i-test123 --region us-west-2");
  });

  it("suppresses idle progression when probe command fails", () => {
    const harness = createHarness(["ok:0", "fail", "ok:0", "ok:0"], 3);
    cleanupDirs.push(harness.rootDir);

    harness.runScript();
    harness.runScript();
    harness.runScript();
    harness.runScript();

    const awsCalls = harness.readAwsCalls();
    expect(awsCalls).not.toContain("ec2 stop-instances");

    const logs = harness.readLogs();
    expect(logs).toContain("Probe unavailable/malformed; cleared idle streak and suppressed shutdown");
  });

  it("requires a fresh consecutive streak after mixed malformed telemetry", () => {
    const harness = createHarness(["ok:0", "malformed", "ok:0", "ok:0", "ok:0"], 3);
    cleanupDirs.push(harness.rootDir);

    harness.runScript();
    harness.runScript();
    harness.runScript();
    harness.runScript();
    harness.runScript();

    const awsCalls = harness.readAwsCalls();
    const stopCallCount = awsCalls.split("\n").filter((line) => line.includes("ec2 stop-instances")).length;

    expect(stopCallCount).toBe(1);
    expect(awsCalls).toContain("--region us-west-2");
  });
});
