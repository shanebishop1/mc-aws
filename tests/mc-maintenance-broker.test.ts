import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash, createHmac, generateKeyPairSync, sign as signBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseMaintenanceApplyArguments } from "../lib/agent/maintenance";

const root = process.cwd();
const broker = path.join(root, "infra/src/ec2/mc-agent-host-broker.py");
const bootHelper = path.join(root, "infra/src/ec2/mc-maintenance-boot.py");
const javaPropertiesHelper = path.join(root, "infra/src/ec2/mc-agent-world-roots.py");
const fixtures: string[] = [];
const fixtureProcesses: ChildProcess[] = [];
const ORIGINAL_PROPERTIES = "motd=Old MOTD\nonline-mode=true\n";
const RESULT_PROPERTIES = "motd=New MOTD\nonline-mode=true\n";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function signRequest(value: Record<string, unknown>, key: Buffer): string {
  return createHmac("sha256", key)
    .update(`mc-aws-host-broker:v1\n${canonical(value)}`)
    .digest("base64url");
}

function executable(directory: string, name: string, source: string): string {
  const target = path.join(directory, name);
  writeFileSync(target, source, { mode: 0o755 });
  chmodSync(target, 0o755);
  return target;
}

function fixture(original = ORIGINAL_PROPERTIES, enablement = "enabled") {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mc-maintenance-broker-"));
  fixtures.push(directory);
  const server = path.join(directory, "server");
  const state = path.join(directory, "system-state.json");
  const systemctlLog = path.join(directory, "systemctl.log");
  const consoleLog = path.join(directory, "console.log");
  const transactionLog = path.join(directory, "transaction.log");
  const authorityLog = path.join(directory, "authority.log");
  const failStatus = path.join(directory, "mcstatus-fail");
  const failRestore = path.join(directory, "restore-fail");
  const failAuthority = path.join(directory, "authority-fail");
  const failAfterCommit = path.join(directory, "fail-after-commit");
  const failMarkerAfterCommit = path.join(directory, "fail-marker-after-commit");
  const crash = path.join(directory, "crash");
  const key = Buffer.alloc(32, 7);
  const keyPath = path.join(directory, "key");
  const bootId = path.join(directory, "boot-id");
  const marker = path.join(directory, "boot-hold.json");
  const fence = path.join(directory, "maintenance-state.json");
  const operationLock = path.join(directory, "operation.lock");
  const worldRootsSocket = path.join(directory, "world-roots.sock");
  const publicKeyPath = path.join(directory, "backup-fence-public.pem");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o444 });
  chmodSync(publicKeyPath, 0o444);
  writeFileSync(keyPath, key, { mode: 0o400 });
  chmodSync(keyPath, 0o400);
  writeFileSync(bootId, "fixture-boot\n");
  mkdirSync(server, { recursive: true });
  writeFileSync(path.join(server, "server.properties"), original);
  writeFileSync(state, JSON.stringify({ active: true, enablement, runtimeMasked: false, players: ["Steve", "Alex"] }));

  const systemctl = executable(
    directory,
    "systemctl",
    `#!/usr/bin/env python3
import json, pathlib, sys
state = pathlib.Path(${JSON.stringify(state)})
log = pathlib.Path(${JSON.stringify(systemctlLog)})
fail_restore = pathlib.Path(${JSON.stringify(failRestore)})
value = json.loads(state.read_text())
log.open("a").write(" ".join(sys.argv[1:]) + "\\n")
command = sys.argv[1] if len(sys.argv) > 1 else ""
if command == "is-active": raise SystemExit(0 if value["active"] else 3)
if command == "is-enabled":
    print("masked-runtime" if value["runtimeMasked"] else value["enablement"])
    raise SystemExit(1 if value["enablement"] == "disabled" else 0)
if command == "mask":
    if "--runtime" in sys.argv: value["runtimeMasked"] = True
    else: value["enablement"] = "masked"
if command == "unmask":
    if "--runtime" in sys.argv: value["runtimeMasked"] = False
    else:
        value["runtimeMasked"] = False
        if value["enablement"] == "masked": value["enablement"] = "disabled"
if command == "stop": value["active"] = False
if command == "start":
    if fail_restore.exists(): raise SystemExit(1)
    if value["runtimeMasked"]: raise SystemExit(1)
    value["active"] = True
state.write_text(json.dumps(value))
`
  );
  const runuser = executable(
    directory,
    "runuser",
    `#!/usr/bin/env python3
import json, pathlib, sys
state = pathlib.Path(${JSON.stringify(state)})
pathlib.Path(${JSON.stringify(consoleLog)}).open("a").write(" ".join(sys.argv[1:]) + "\\n")
value = json.loads(state.read_text())
command = sys.argv[-1].rstrip("\\r")
if command.startswith("minecraft:kick "):
    player = command.split()[1]
    value["players"] = [item for item in value["players"] if item != player]
state.write_text(json.dumps(value))
`
  );
  const status = executable(
    directory,
    "mcstatus",
    `#!/usr/bin/env python3
import json, pathlib, re, sys
if pathlib.Path(${JSON.stringify(failStatus)}).exists(): raise SystemExit(1)
state = json.loads(pathlib.Path(${JSON.stringify(state)}).read_text())
if sys.argv[-1] == "query":
    players = state["players"]
    print(f"players: {len(players)}/20" + ((" " + " ".join(players)) if players else ""))
else:
    text = pathlib.Path(${JSON.stringify(path.join(server, "server.properties"))}).read_text()
    raw = next(line.split("=", 1)[1] for line in text.splitlines() if line.startswith("motd="))
    print("MOTD: " + raw.replace(chr(92) + chr(92), chr(92)))
`
  );
  const worldRootsServer = executable(
    directory,
    "world-roots-server.py",
    `#!/usr/bin/env python3
import base64, hashlib, hmac, json, os, pathlib, shutil, signal, socket, struct
socket_path = pathlib.Path(${JSON.stringify(worldRootsSocket)})
server_root = pathlib.Path(${JSON.stringify(server)})
key = pathlib.Path(${JSON.stringify(keyPath)}).read_bytes()
server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(str(socket_path)); server.listen(4)
while True:
    connection, _ = server.accept()
    peer_pid = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[0]
    raw = b""
    while not raw.endswith(b"\\n"): raw += connection.recv(8192)
    request = json.loads(raw)
    unsigned = dict(request); supplied = unsigned.pop("mac")
    expected = base64.urlsafe_b64encode(hmac.new(key, b"mc-aws-world-root-transaction:v1\\n" + json.dumps(unsigned, ensure_ascii=False, separators=(",",":"), sort_keys=True).encode(), hashlib.sha256).digest()).rstrip(b"=").decode()
    if not hmac.compare_digest(supplied, expected): raise SystemExit("bad transaction MAC")
    staged = server_root / request["stageName"]
    pathlib.Path(${JSON.stringify(transactionLog)}).open("a").write("transaction\\n")
    shutil.copyfile(staged, server_root / "server.properties")
    if pathlib.Path(${JSON.stringify(crash)}).exists():
        os.kill(peer_pid, signal.SIGKILL); connection.close(); continue
    response = ({"schemaVersion":1,"committed":False,"error":"response lost after commit"}
        if pathlib.Path(${JSON.stringify(failAfterCommit)}).exists()
        else {"schemaVersion":1,"committed":True,"generation":"d"*64})
    connection.sendall(json.dumps(response,separators=(",",":"),sort_keys=True).encode()+b"\\n")
    connection.close()
`
  );
  const worldRootsProcess = spawn("python3", [worldRootsServer], { stdio: "ignore" });
  fixtureProcesses.push(worldRootsProcess);
  for (let attempt = 0; attempt < 100 && !existsSync(worldRootsSocket); attempt++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  if (!existsSync(worldRootsSocket)) throw new Error("world-root transaction fixture did not start");
  const maintenanceBoot = executable(
    directory,
    "maintenance-boot.py",
    `#!/usr/bin/env python3
import os, pathlib, sys
if pathlib.Path(${JSON.stringify(failMarkerAfterCommit)}).exists() and pathlib.Path(${JSON.stringify(transactionLog)}).exists():
    raise SystemExit(74)
os.execv(sys.executable, [sys.executable, ${JSON.stringify(bootHelper)}, *sys.argv[1:]])
`
  );
  const authority = executable(
    directory,
    "host-operation.py",
    `#!/usr/bin/env python3
import json, pathlib, sys
pathlib.Path(${JSON.stringify(authorityLog)}).open("a").write(" ".join(sys.argv[1:]) + "\\n")
if pathlib.Path(${JSON.stringify(failAuthority)}).exists(): raise SystemExit(1)
value={"schemaVersion":1,"generation":7,"recordSequence":6,"effectFingerprint":"f"*64}
if "--backup-authorization-fingerprint" in sys.argv:
    value["backupAuthorizationFingerprint"]=sys.argv[sys.argv.index("--backup-authorization-fingerprint")+1]
print(json.dumps(value,separators=(",",":"),sort_keys=True))
`
  );

  return {
    directory,
    key,
    privateKey,
    state,
    marker,
    fence,
    transactionLog,
    authorityLog,
    consoleLog,
    failStatus,
    failRestore,
    failAuthority,
    failAfterCommit,
    failMarkerAfterCommit,
    crash,
    env: {
      ...process.env,
      MC_HOST_BROKER_KEY: keyPath,
      MC_HOST_BROKER_SOCKET: path.join(directory, "host-broker.sock"),
      MC_SERVER_ROOT: server,
      MC_MAINTENANCE_BOOT_HELPER: maintenanceBoot,
      MC_MAINTENANCE_BOOT_HOLD: marker,
      MC_BOOT_ID_FILE: bootId,
      MC_MAINTENANCE_LOCK: fence,
      MC_OPERATION_LOCK: operationLock,
      MC_SYSTEMCTL_BIN: systemctl,
      MC_RUNUSER_BIN: runuser,
      MC_SCREEN_BIN: path.join(directory, "screen-does-not-run-as-root"),
      MC_STATUS_BIN: status,
      MC_WORLD_ROOTS_SOCKET: worldRootsSocket,
      MC_JAVA_PROPERTIES_HELPER: javaPropertiesHelper,
      MC_HOST_OPERATION_HELPER: authority,
      MC_HOST_OPERATION_CONTRACT: path.join(directory, "contract.json"),
      MC_EXECUTOR_JOURNAL: path.join(directory, "executor-journal.json"),
      MC_GATEWAY_JOURNAL: path.join(directory, "gateway-journal.json"),
      MC_BACKUP_FENCE_PUBLIC_KEY: publicKeyPath,
      MC_HOST_BROKER_TEST_MODE: "1",
    },
  };
}

function identity(invocationId: string) {
  return {
    schemaVersion: 1 as const,
    runtimeId: "runtime-1",
    leaseId: "lease-1",
    leaseGeneration: 1,
    taskId: "task-1",
    sessionId: "session-1",
    invocationId,
    invocationDigest: "a".repeat(64),
  };
}

function signedBackup(value: ReturnType<typeof fixture>, invocationId: string) {
  const now = Date.now();
  const { schemaVersion: _schemaVersion, ...boundIdentity } = identity(invocationId);
  const unsigned = {
    schemaVersion: 1,
    status: "succeeded",
    authorizationId: "backup-auth-1",
    ...boundIdentity,
    backupId: "backup-1",
    lifecycleLockId: "lifecycle-1",
    lifecycleFencingToken: 9,
    lifecycleLeaseGeneration: 12,
    lifecycleLeaseExpiresAt: new Date(now + 60 * 60_000).toISOString(),
    issuedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 30_000).toISOString(),
  } as Record<string, unknown>;
  const signature = signBytes(null, Buffer.from(canonical(unsigned)), value.privateKey).toString("base64url");
  return { ...unsigned, signature };
}

function maintenanceRequest(
  value: ReturnType<typeof fixture>,
  invocationId: string,
  options: { original?: string; result?: string; motd?: string; key?: string; expectedMotd?: string } = {}
) {
  const original = options.original ?? ORIGINAL_PROPERTIES;
  const result = options.result ?? RESULT_PROPERTIES;
  const motd = options.motd ?? "New MOTD";
  return {
    schemaVersion: 1,
    operation: "maintenance.apply",
    invocation: identity(invocationId),
    backup: signedBackup(value, invocationId),
    config: {
      schemaVersion: 1,
      path: "server.properties",
      key: options.key ?? "motd",
      value: motd,
      expectedSha256: sha256(original),
      expectedBytes: Buffer.byteLength(original),
      resultSha256: sha256(result),
      resultBytes: Buffer.byteLength(result),
    },
    serviceIntent: "restore-prior",
    expectedProtocol: { schemaVersion: 1, host: "127.0.0.1", port: 25565, motd: options.expectedMotd ?? motd },
  };
}

function invoke(value: ReturnType<typeof fixture>, request: Record<string, unknown>) {
  const unsigned = structuredClone(request);
  const signed = { ...unsigned, mac: signRequest(unsigned, value.key) };
  return spawnSync("python3", [broker, "--once"], {
    input: `${canonical(signed)}\n`,
    env: value.env,
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const process of fixtureProcesses.splice(0)) process.kill("SIGTERM");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("bounded maintenance host broker", () => {
  it("exposes only MOTD and requires its exact independent observer", () => {
    expect(() =>
      parseMaintenanceApplyArguments({
        path: "server.properties",
        key: "online-mode",
        value: "false",
        expectedSha256: "a".repeat(64),
        expectedBytes: 1,
        resultSha256: "b".repeat(64),
        resultBytes: 1,
        serviceIntent: "restore-prior",
        expectedProtocol: { schemaVersion: 1, host: "127.0.0.1", port: 25565, motd: "unchanged" },
      })
    ).toThrow("invalid");
    expect(() =>
      parseMaintenanceApplyArguments({
        path: "server.properties",
        key: "motd",
        value: "New MOTD",
        expectedSha256: "a".repeat(64),
        expectedBytes: 1,
        resultSha256: "b".repeat(64),
        resultBytes: 1,
        serviceIntent: "restore-prior",
        expectedProtocol: { schemaVersion: 1, host: "127.0.0.1", port: 25565, motd: "Old MOTD" },
      })
    ).toThrow("expectedProtocol");
  });

  it("runs signed/journal-authorized quiesce, canonical edit, restore, and MOTD observation", () => {
    const value = fixture();
    const result = invoke(value, maintenanceRequest(value, "invoke-success"));
    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed, parsed.error).toMatchObject({ ok: true, effectState: "committed", verification: "observed" });
    expect(readFileSync(path.join(value.directory, "server", "server.properties"), "utf8")).toBe(RESULT_PROPERTIES);
    expect(readFileSync(value.transactionLog, "utf8")).toContain("transaction");
    expect(readFileSync(value.authorityLog, "utf8")).toContain("executor-active-effect");
    expect(existsSync(value.fence)).toBe(false);
    expect(JSON.parse(readFileSync(value.state, "utf8"))).toMatchObject({
      active: true,
      enablement: "enabled",
      runtimeMasked: false,
    });
  });

  it("restores an active persistently masked service to the exact prior active/mask state", () => {
    const value = fixture(ORIGINAL_PROPERTIES, "masked");
    const response = invoke(value, maintenanceRequest(value, "masked-service"));
    expect(JSON.parse(response.stdout)).toMatchObject({ ok: true, verification: "observed" });
    expect(JSON.parse(readFileSync(value.state, "utf8"))).toMatchObject({
      active: true,
      enablement: "masked",
      runtimeMasked: false,
    });
  });

  it.each([
    ["LF", "motd=Old\\\n Continued\nonline-mode=true\n", "motd=New MOTD\nonline-mode=true\n"],
    ["CRLF", "motd=Old MOTD\r\nonline-mode=true\r\n", "motd=New MOTD\r\nonline-mode=true\r\n"],
    ["backslash", "motd=Old MOTD\nonline-mode=true\n", "motd=Path\\\\Name\nonline-mode=true\n"],
  ])("preserves Java-properties semantics for %s canonical edits", (_name, original, rendered) => {
    const value = fixture(original);
    const motd = rendered.includes("Path") ? "Path\\Name" : "New MOTD";
    const response = invoke(
      value,
      maintenanceRequest(value, `properties-${_name}`, { original, result: rendered, motd })
    );
    expect(JSON.parse(response.stdout)).toMatchObject({ ok: true, verification: "observed" });
    expect(readFileSync(path.join(value.directory, "server", "server.properties"), "utf8")).toBe(rendered);
  });

  it.each(["line\nbreak", "line\rbreak", "nul\0break"])("rejects raw control injection %j", (motd) => {
    const value = fixture();
    const response = invoke(value, maintenanceRequest(value, `control-${motd.charCodeAt(4)}`, { motd }));
    expect(JSON.parse(response.stdout)).toMatchObject({ ok: false, effectState: "not-entered" });
    expect(existsSync(value.transactionLog)).toBe(false);
  });

  it("rejects duplicate decoded escaped keys before effect entry", () => {
    const original = "motd=one\nm\\u006ftd=two\nonline-mode=true\n";
    const value = fixture(original);
    const response = invoke(value, maintenanceRequest(value, "duplicate-key", { original }));
    expect(JSON.parse(response.stdout)).toMatchObject({ ok: false, effectState: "not-entered" });
    expect(existsSync(value.transactionLog)).toBe(false);
  });

  it("reports a helper failure after the exact result appears as committed, never no-effect", () => {
    const value = fixture();
    writeFileSync(value.failAfterCommit, "fail\n");
    const response = invoke(value, maintenanceRequest(value, "helper-failed-after-commit"));
    expect(JSON.parse(response.stdout)).toMatchObject({
      ok: false,
      effectState: "unknown",
      verification: "unresolved",
    });
    expect(readFileSync(path.join(value.directory, "server", "server.properties"), "utf8")).toBe(RESULT_PROPERTIES);
  });

  it("defaults to unknown when committed-result marker publication fails and never redispatches", () => {
    const value = fixture();
    writeFileSync(value.failMarkerAfterCommit, "fail\n");
    const request = maintenanceRequest(value, "marker-failed-after-commit");

    const response = JSON.parse(invoke(value, request).stdout);
    expect(response).toMatchObject({
      ok: false,
      effectState: "unknown",
      verification: "unresolved",
      output: { noAutoRetry: true },
    });
    expect(readFileSync(path.join(value.directory, "server", "server.properties"), "utf8")).toBe(RESULT_PROPERTIES);
    expect(JSON.parse(readFileSync(value.marker, "utf8"))).toMatchObject({
      phase: "editing",
      details: { effectState: "entering" },
    });
    expect(existsSync(value.fence)).toBe(true);
    expect(readFileSync(value.transactionLog, "utf8").trim().split("\n")).toHaveLength(1);

    const retried = JSON.parse(invoke(value, request).stdout);
    expect(retried).toMatchObject({ ok: false, effectState: "unknown", output: { noAutoRetry: true } });
    expect(readFileSync(value.transactionLog, "utf8").trim().split("\n")).toHaveLength(1);

    rmSync(value.failMarkerAfterCommit);
    const reconciled = JSON.parse(invoke(value, request).stdout);
    expect(reconciled).toMatchObject({ ok: true, effectState: "committed", verification: "observed" });
    expect(readFileSync(value.transactionLog, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("retains exact intent and barriers across root-process death at effect entry", () => {
    const value = fixture();
    writeFileSync(value.crash, "crash\n");
    const result = invoke(value, maintenanceRequest(value, "invoke-crash"));
    expect(result.signal).toBe("SIGKILL");
    expect(JSON.parse(readFileSync(value.marker, "utf8"))).toMatchObject({
      operation: "agent-maintenance",
      phase: "editing",
      details: {
        effectState: "entering",
        invocation: { invocationId: "invoke-crash" },
        serviceBefore: { active: true },
      },
    });
    expect(existsSync(value.fence)).toBe(true);
  });

  it("never redispatches a retained uncertain effect and exposes the exact operator reconciliation action", () => {
    const value = fixture();
    writeFileSync(value.crash, "crash\n");
    const request = maintenanceRequest(value, "invoke-loss");
    expect(invoke(value, request).signal).toBe("SIGKILL");
    rmSync(value.crash);
    writeFileSync(path.join(value.directory, "server", "server.properties"), ORIGINAL_PROPERTIES);
    const retried = invoke(value, request);
    expect(JSON.parse(retried.stdout)).toMatchObject({
      ok: false,
      effectState: "unknown",
      output: {
        noAutoRetry: true,
        operatorAction: expect.stringContaining("--reconcile-agent-maintenance invoke-loss"),
      },
    });
    expect(readFileSync(value.transactionLog, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("retains committed intent when protocol or exact service restoration is unresolved", () => {
    const protocol = fixture();
    writeFileSync(protocol.failStatus, "fail\n");
    expect(JSON.parse(invoke(protocol, maintenanceRequest(protocol, "protocol-unresolved")).stdout)).toMatchObject({
      ok: false,
      effectState: "committed",
      verification: "unresolved",
    });
    expect(JSON.parse(readFileSync(protocol.marker, "utf8"))).toMatchObject({ phase: "verification-unresolved" });
    expect(existsSync(protocol.fence)).toBe(true);

    const restore = fixture();
    writeFileSync(restore.failRestore, "fail\n");
    expect(JSON.parse(invoke(restore, maintenanceRequest(restore, "restore-unresolved")).stdout)).toMatchObject({
      ok: false,
      effectState: "committed",
    });
    expect(JSON.parse(readFileSync(restore.marker, "utf8"))).toMatchObject({ phase: "restoration-unresolved" });
    expect(existsSync(restore.fence)).toBe(true);
  });

  it("rejects missing active journal authority before transaction and restores exact service state", () => {
    const value = fixture();
    writeFileSync(value.failAuthority, "fail\n");
    const response = JSON.parse(invoke(value, maintenanceRequest(value, "authority-denied")).stdout);
    expect(response).toMatchObject({ ok: false, effectState: "not-entered" });
    expect(existsSync(value.transactionLog)).toBe(false);
    expect(existsSync(value.marker)).toBe(false);
    expect(existsSync(value.fence)).toBe(false);
    expect(JSON.parse(readFileSync(value.state, "utf8"))).toMatchObject({ active: true, runtimeMasked: false });
  });

  it("uses only namespaced commands, the minecraft UID bridge, and exact player truth", () => {
    const value = fixture();
    const list = invoke(value, {
      schemaVersion: 1,
      operation: "console.execute",
      invocation: identity("console-list"),
      command: "minecraft:list",
      timeoutMs: 5_000,
    });
    const listed = JSON.parse(list.stdout);
    expect(listed, listed.error).toMatchObject({ ok: true, committed: false, output: { players: ["Steve", "Alex"] } });
    expect(existsSync(value.consoleLog)).toBe(false);

    const kick = invoke(value, {
      schemaVersion: 1,
      operation: "console.execute",
      invocation: identity("console-kick"),
      command: "minecraft:kick Steve maintenance",
      timeoutMs: 5_000,
    });
    expect(JSON.parse(kick.stdout)).toMatchObject({
      ok: true,
      committed: true,
      verification: "observed",
      output: { player: "Steve", playersAfter: ["Alex"], independentlyObserved: true },
    });
    expect(readFileSync(value.consoleLog, "utf8")).toContain("--user minecraft --");

    const raw = invoke(value, {
      schemaVersion: 1,
      operation: "console.execute",
      invocation: identity("console-raw"),
      command: "kick Alex",
      timeoutMs: 5_000,
    });
    expect(JSON.parse(raw.stdout)).toMatchObject({ ok: false, effectState: "not-entered" });
  });
});
