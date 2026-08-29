import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = path.resolve(process.cwd(), "infra/src/ec2/mc-wait-ready.sh");
const cleanup: string[] = [];

function executable(file: string, body: string) {
  writeFileSync(file, body, "utf8");
  chmodSync(file, 0o755);
}

function run(options: { protocolReady: boolean; dnsIp?: string; mode?: string }) {
  const root = mkdtempSync(path.join(os.tmpdir(), "mc-ready-test-"));
  cleanup.push(root);
  const bin = path.join(root, "bin");
  const marker = path.join(root, "bootstrap-complete");
  mkdirSync(bin);
  writeFileSync(marker, "ready\n");
  executable(path.join(bin, "systemctl"), "#!/usr/bin/env bash\nexit 0\n");
  executable(path.join(bin, "mcstatus"), `#!/usr/bin/env bash\nexit ${options.protocolReady ? 0 : 1}\n`);
  executable(path.join(bin, "getent"), `#!/usr/bin/env bash\nprintf '%s STREAM host\n' '${options.dnsIp || ""}'\n`);
  executable(path.join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
  return spawnSync("bash", [script, options.mode || "cloudflare", "mc.example.com", "203.0.113.10"], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      MCSTATUS_BIN: path.join(bin, "mcstatus"),
      MC_BOOTSTRAP_MARKER: marker,
      MC_READY_TIMEOUT_SECONDS: "1",
      MC_READY_POLL_SECONDS: "1",
      MC_DNS_GRACE_SECONDS: "0",
    },
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// Each assertion launches the real readiness shell loop; several sequential process
// launches can exceed Vitest's unit-test default under normal CI concurrency.
describe("mc-wait-ready.sh", { timeout: 15_000 }, () => {
  it("requires Minecraft protocol but reports recursive DNS propagation separately", () => {
    expect(run({ protocolReady: false, dnsIp: "203.0.113.10" }).status).not.toBe(0);
    const staleDns = run({ protocolReady: true, dnsIp: "198.51.100.9" });
    expect(staleDns.status).toBe(0);
    expect(staleDns.stdout).toContain('"dnsReady":false');
    expect(run({ protocolReady: true, dnsIp: "203.0.113.10" }).stdout).toContain('"dnsReady":true');
  });

  it("allows intentional raw-IP readiness without DNS", () => {
    expect(run({ protocolReady: true, mode: "raw_ip" }).status).toBe(0);
  });
});
