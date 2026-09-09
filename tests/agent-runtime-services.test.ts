import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProductionDirectLiveHostEffects } from "../agent-runtime/src/live-host-effects";

const ec2 = path.resolve(process.cwd(), "infra/src/ec2");
const gateway = readFileSync(path.join(ec2, "mc-agent-gateway.service"), "utf8");
const executor = readFileSync(path.join(ec2, "mc-agent-executor.service"), "utf8");
const executorSocket = readFileSync(path.join(ec2, "mc-agent-executor.socket"), "utf8");
const toolRead = readFileSync(path.join(ec2, "mc-agent-tool-read.service"), "utf8");
const toolReadSocket = readFileSync(path.join(ec2, "mc-agent-tool-read.socket"), "utf8");
const toolWrite = readFileSync(path.join(ec2, "mc-agent-tool-write.service"), "utf8");
const toolWriteSocket = readFileSync(path.join(ec2, "mc-agent-tool-write.socket"), "utf8");
const tmpfiles = readFileSync(path.join(ec2, "mc-agent-runtime.tmpfiles"), "utf8");
const gatewayConfig = readFileSync(path.join(ec2, "mc-agent-gateway.json"), "utf8");
const parsedGatewayConfig = JSON.parse(gatewayConfig) as {
  providerCredentialNames: string[];
  profiles: Array<{ credentialName: string; providerKind: string; allowedModels: string[] }>;
};
const executorConfig = readFileSync(path.join(ec2, "mc-agent-executor.json"), "utf8");
const executorCli = readFileSync(path.resolve(process.cwd(), "agent-runtime/src/executor-cli.ts"), "utf8");
const installerPath = path.join(ec2, "mc-agent-install.sh");
const installer = readFileSync(installerPath, "utf8");
const profileInstaller = readFileSync(path.join(ec2, "mc-profile-install.sh"), "utf8");
const rollout = readFileSync(path.join(ec2, "mc-runtime-rollout.sh"), "utf8");
const minecraft = readFileSync(path.join(ec2, "minecraft.service"), "utf8");
const backup = readFileSync(path.join(ec2, "mc-backup.sh"), "utf8");

function effectiveIpv4Policy(unit: string, address: string): "allow" | "deny" | "unmatched" {
  const numeric = (value: string) =>
    value.split(".").reduce((result, octet) => ((result << 8) | Number(octet)) >>> 0, 0);
  const candidate = numeric(address);
  const matches = [...unit.matchAll(/^IPAddress(Allow|Deny)=([0-9.]+)\/(\d+)$/gm)]
    .map((match) => {
      const prefix = Number(match[3]);
      const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
      return {
        action: match[1].toLowerCase() as "allow" | "deny",
        prefix,
        matches: (candidate & mask) === (numeric(match[2]) & mask),
      };
    })
    .filter((rule) => rule.matches)
    .sort((left, right) => right.prefix - left.prefix || (left.action === "deny" ? -1 : 1));
  return matches[0]?.action ?? "unmatched";
}

describe("agent runtime host services", () => {
  it("keeps Minecraft ownership and world location unchanged", () => {
    expect(minecraft).toContain("User=minecraft");
    expect(minecraft).toContain("WorkingDirectory=/opt/minecraft/server");
    expect(minecraft).toContain("ExecStartPre=+/bin/chown -R minecraft:minecraft /opt/minecraft/server/");
    expect(installer).not.toContain("chown -R minecraft:minecraft /opt/minecraft/server");
  });

  it.each([
    ["gateway", gateway],
    ["executor", executor],
  ])("hardens the unprivileged %s service", (_name, unit) => {
    expect(unit).toContain("NoNewPrivileges=true");
    expect(unit).toMatch(/CapabilityBoundingSet=\n/);
    expect(unit).toMatch(/AmbientCapabilities=\n/);
    expect(unit).toContain("ProtectSystem=strict");
    expect(unit).toContain("ProtectHome=true");
    expect(unit).toContain("PrivateTmp=true");
    expect(unit).toContain("PrivateDevices=true");
    expect(unit).toContain("ProtectProc=invisible");
    expect(unit).toContain("ProcSubset=pid");
    expect(unit).toContain("KeyringMode=private");
    expect(unit).toContain("RestrictNamespaces=true");
    expect(unit).toContain("SystemCallFilter=~@mount @privileged @resources @reboot @swap @obsolete");
    expect(unit).toMatch(/IPAddressDeny=169\.254\.(?:0\.0\/16|169\.254\/32)/);
    expect(unit).toContain("IPAddressDeny=fd00:ec2::254/128");
  });

  it("gives only the gateway network and protected credentials without a writable server mount", () => {
    expect(gateway).toContain("User=mc-agent-gateway");
    expect(gateway).not.toContain("User=minecraft");
    expect(installer).toMatch(/useradd[^\n]*mc-agent-gateway/);
    expect(gateway).toContain("LoadCredential=runtime-bearer:");
    expect(gateway).toContain("LoadCredential=gateway-private-key:");
    expect(gateway).toContain("LoadCredential=provider-openrouter:");
    expect(parsedGatewayConfig.providerCredentialNames).toEqual(["provider-openrouter"]);
    expect(parsedGatewayConfig.profiles.map(({ credentialName }) => credentialName)).toEqual(
      parsedGatewayConfig.providerCredentialNames
    );
    expect(parsedGatewayConfig.profiles[0]).toMatchObject({
      providerKind: "openrouter",
      allowedModels: ["replace-with-reviewed-model"],
    });
    expect(parsedGatewayConfig.providerCredentialNames).not.toEqual(
      expect.arrayContaining(["runtime-bearer", "gateway-private-key"])
    );
    expect(gateway).toContain("RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6");
    expect(gateway).toContain("ReadOnlyPaths=/opt/mc-agent /run/mc-agent");
    expect(gateway).not.toContain("ReadWritePaths=/opt/mc-agent");
    expect(gateway).toContain("ExecStartPre=/usr/bin/python3 /usr/local/bin/mc-agent-world-roots.py verify");
    expect(gateway).toContain("MC_AGENT_GATEWAY_CONFIG=/etc/mc-agent/world-roots-current/gateway.json");
    expect(gateway).toContain("ReadWritePaths=/var/lib/mc-agent-gateway /run/mc-agent-download");
    expect(gatewayConfig).toContain('"downloadSocketPath": "/run/mc-agent-download/download.sock"');
    expect(gateway).toContain("InaccessiblePaths=");
    expect(gateway).toContain("/opt/minecraft/server");
    expect(gateway).not.toContain("ReadWritePaths=/opt/minecraft");
    expect(gateway).toContain("MemoryHigh=192M");
    expect(gateway).toContain("MemoryMax=256M");
    expect(gateway).toContain("TasksMax=64");
    expect(gatewayConfig).toContain('"extensions": {');
    expect(gatewayConfig).toContain('"bundlePaths": ["extensions/status-report/extension.json"]');
    expect(gateway).toContain("Environment=MC_AGENT_MAINTENANCE_FENCE=/run/mc-agent/maintenance-state.json");
    expect(gateway).toContain("Restart=on-failure");
    const gatewayCli = readFileSync(path.resolve(process.cwd(), "agent-runtime/src/gateway-cli.ts"), "utf8");
    expect(gatewayCli).toContain('process.once("SIGUSR1"');
    expect(gatewayCli).toContain("Runtime maintenance fence could not be inspected");
    expect(gatewayCli).toContain("loadInstalledAgentExtensionRegistry");
    expect(gatewayCli).toContain("DIRECT_LIVE_TOOL_DEFINITIONS");
    expect(gatewayCli.indexOf("access(maintenanceFence)")).toBeLessThan(gatewayCli.indexOf("gateway.runOnce"));
  });

  it("uses one root-visible maintenance fence and drains before masking archive-time activation", () => {
    expect(backup).toContain("/run/mc-agent/maintenance-state.json");
    expect(backup).not.toContain("/tmp/mc-maintenance.lock");
    expect(backup).toContain("executor-idle");
    expect(backup.indexOf("drain_executor")).toBeLessThan(backup.indexOf("systemctl mask --runtime"));
    expect(backup.indexOf("systemctl mask --runtime")).toBeLessThan(
      backup.indexOf("systemctl stop mc-agent-world-roots.service")
    );
    expect(backup).toContain("--agent-two-phase");
    expect(executorSocket).toContain("RemoveOnStop=true");
    expect(executor).toContain("After=minecraft.service systemd-tmpfiles-setup.service mc-agent-executor.socket");
    expect(executor).toContain("Requires=mc-agent-executor.socket");
    expect(executor).not.toContain("Requires=minecraft.service");
  });

  it("keeps runtime rollout writers fenced across snapshot, activation, and rollback", () => {
    expect(rollout).toContain("MC_MAINTENANCE_LOCK");
    expect(rollout).toContain('operation": "runtime-rollout"');
    expect(rollout).toContain("assert_runtime_fence");
    expect(rollout).toContain("fsync_mutable_state");
    expect(rollout).toContain('MC_MAINTENANCE_OWNER="$MAINTENANCE_OWNER"');
    expect(profileInstaller).toContain("assert_maintenance_fence");
    expect(installer).toContain("assert_maintenance_fence");
    expect(rollout.lastIndexOf("release_runtime_fence")).toBeGreaterThan(rollout.lastIndexOf("probe_readiness"));
    expect(rollout).toContain("assert_persistent_guard_prerequisite");
    expect(rollout).toContain("--recursive /opt/mc-agent/executor-root/usr");
    expect(rollout.indexOf("assert_persistent_guard_prerequisite\nif [[ -e")).toBeLessThan(
      rollout.lastIndexOf("acquire_or_adopt_maintenance\n")
    );
  });

  it("allows only the reviewed EC2 DNS resolver exception while metadata and link-local peers remain denied", () => {
    expect(gateway).toContain("IPAddressAllow=169.254.169.253/32");
    expect(gateway).toContain("IPAddressDeny=169.254.169.254/32");
    expect(effectiveIpv4Policy(gateway, "169.254.169.253")).toBe("allow");
    expect(effectiveIpv4Policy(gateway, "169.254.169.254")).toBe("deny");
    expect(effectiveIpv4Policy(gateway, "169.254.169.252")).toBe("deny");
  });

  it("keeps the trusted executor separate from Minecraft while denying network and gateway credentials", () => {
    expect(executor).toContain("User=mc-agent-executor");
    expect(executor).toContain("Group=mc-agent-executor");
    expect(executor).toContain(
      "SupplementaryGroups=mc-agent-executor-client mc-agent-gateway-client mc-agent-world-root-client mc-agent-workspace"
    );
    expect(executor).toContain("RootDirectory=/opt/mc-agent/executor-root");
    expect(executor).toContain("BindPaths=/opt/minecraft/server:/workspace");
    expect(executor).toContain("BindReadOnlyPaths=/run/mc-agent-download:/run/mc-agent-download");
    expect(executorConfig).toContain('"downloadSocketPath": "/run/mc-agent-download/download.sock"');
    expect(executorConfig).toContain('"statePath": "/scratch/executor-effect-journal.json"');
    expect(executorConfig).toContain('"journalCredentialName": "executor-journal-hmac"');
    expect(executorConfig).toContain('"backupFencePublicKeyPath": "/config/backup-fence-public.pem"');
    expect(executorConfig).toContain('"persistentWorldRoots": ["world", "world_nether", "world_the_end"]');
    expect(executor).toContain(
      "ExecStartPre=/usr/bin/python3 /usr/local/bin/mc-agent-world-roots.py verify --generation-dir /config"
    );
    expect(executor).not.toContain("mc-agent-workspace-dac.py reconcile");
    expect(executor).toContain("BindReadOnlyPaths=/usr/bin/python3:/usr/bin/python3");
    expect(installer).toContain('"$ROOT/executor-root"/{workspace,scratch,runtime,config,usr/bin,usr/local/bin');
    expect(profileInstaller).toContain("/opt/mc-agent/executor-root/usr/local/bin/mc-agent-world-roots.py");
    expect(executor).toContain("BindReadOnlyPaths=/etc/mc-agent/world-roots-current:/config");
    expect(gatewayConfig).toContain('"persistentWorldRoots": ["world", "world_nether", "world_the_end"]');
    expect(executor).toContain("StateDirectory=mc-agent-executor");
    expect(executor).toContain("RuntimeMaxSec=20min");
    expect(executor).toContain("TimeoutStopSec=30s");
    expect(executor).toContain("TimeoutStopFailureMode=kill");
    expect(executor).toContain("KillMode=control-group");
    expect(executor).toContain("SendSIGKILL=yes");
    expect(executor).toContain("FinalKillSignal=SIGKILL");
    expect(executor).toContain("BindPaths=/var/lib/mc-agent-executor:/scratch");
    expect(executor).toContain("BindReadOnlyPaths=/opt/mc-agent:/runtime");
    expect(executor).toContain(
      "BindReadOnlyPaths=/etc/mc-agent/backup-fence-public.pem:/config/backup-fence-public.pem"
    );
    expect(executor).toContain("RestrictAddressFamilies=AF_UNIX");
    expect(executor).toContain("PrivateNetwork=true");
    expect(executor).toContain("IPAddressDeny=any");
    expect(executor).toContain("InaccessiblePaths=");
    expect(executor).toContain("LoadCredential=executor-journal-hmac:/etc/mc-agent/executor-journal-hmac.key");
    expect(executor).toContain("LoadCredential=executor-receipt-private:/etc/mc-agent/executor-receipt-private.pem");
    expect(executor).toContain("LoadCredential=executor-clean-start-epoch:/etc/mc-agent/executor-clean-start-epoch");
    expect(executor.match(/^LoadCredential=/gm)).toHaveLength(3);
    expect(executor).not.toMatch(/runtime-bearer|provider-openrouter|AWS_/);
    expect(gateway).not.toMatch(/executor-receipt-private|executor-clean-start-epoch/);
    expect(minecraft).not.toMatch(/executor-receipt-private|executor-clean-start-epoch/);
    expect(executor).not.toContain("/usr/bin/find");
    expect(executorConfig).not.toContain('"find"');
    expect(executorConfig).toContain('"shellReadSocketPath": "/run/mc-agent/shell-read.sock"');
    expect(executorConfig).toContain('"shellWriteSocketPath": "/run/mc-agent/shell-write.sock"');
    expect(executor).not.toMatch(/BindReadOnlyPaths=\/usr\/bin\/(?:cmp|find|grep|ls|stat)/);
    expect(installer).toMatch(/useradd[^\n]*mc-agent-executor/);
    expect(installer).toMatch(/useradd[^\n]*mc-agent-tool/);
    expect(executor).not.toContain("/run/screen");
    expect(executor).not.toContain("/usr/bin/screen");
    expect(executorCli).toContain("readExecutorProtectedCredentials");
    expect(executorCli).toContain("journalCredentialPath: credentials.journal.path");
    expect(executorCli.indexOf("readExecutorProtectedCredentials")).toBeLessThan(
      executorCli.indexOf("ProductionDirectLiveHostEffects.create")
    );
    expect(executorCli).not.toMatch(/console\.(log|error).*journal/i);
  });

  it("isolates Minecraft from executor credentials, environment, and journal mounts", () => {
    expect(executor).toContain("PrivateUsers=true");
    expect(executor).toContain("PrivateMounts=true");
    expect(executor).toContain("PrivateIPC=true");
    expect(executor).toContain("ProtectProc=invisible");
    expect(executor).toContain("ProcSubset=pid");
    expect(minecraft).toContain("PrivateUsers=true");
    expect(minecraft).toContain("PrivateMounts=true");
    expect(minecraft).toContain("ProtectProc=ptraceable");
    expect(minecraft).toContain("ProcSubset=pid");
    expect(minecraft).toContain("RestrictNamespaces=true");
    expect(minecraft).toContain(
      "InaccessiblePaths=/etc/mc-agent /run/credentials /var/lib/mc-agent-executor /opt/mc-agent/executor-root"
    );
    expect(installer).toContain("openssl rand 32");
    expect(installer).toContain("root:root:400:32");
    expect(installer).toContain("rotate-clean-start-epoch --confirm-hard-stop");
    expect(installer).toContain("rotate-receipt-key --confirm-hard-stop");
    expect(installer).toContain("RECEIPT_ROTATION_JOURNAL");
    expect(installer).toContain("recover_receipt_key_rotation");
    expect(installer).toContain("executor-receipt-references");
    expect(installer).toContain("backup_receipt_private_key");
    expect(installer).toContain("write_receipt_rotation_journal committed");
    expect(installer).toContain("masked|masked-runtime");
    expect(rollout).not.toContain("rotate-clean-start-epoch");
    expect(rollout).not.toContain("rotate-receipt-key");
    expect(installer).not.toMatch(/chown[^\n]*minecraft[^\n]*executor-journal-hmac/);
    expect(executor).not.toMatch(/Environment=.*(?:hmac|key)/i);
    expect(executor).not.toMatch(/Bind(?:ReadOnly)?Paths=.*executor-journal-hmac/);
    expect(minecraft).not.toMatch(/^LoadCredential=/m);
    expect(minecraft).toContain("InaccessiblePaths=/etc/mc-agent /run/credentials");
  });

  it("provides two credentialless socket-activated runner boundaries", () => {
    for (const unit of [toolRead, toolWrite]) {
      expect(unit).toContain("User=mc-agent-tool");
      expect(unit).toContain("Group=mc-agent-tool");
      expect(unit).toContain("SupplementaryGroups=mc-agent-workspace\n");
      expect(unit).toContain("PrivateNetwork=true");
      expect(unit).toContain("RestrictAddressFamilies=AF_UNIX");
      expect(unit).toContain("IPAddressDeny=any");
      expect(unit).toContain("BindReadOnlyPaths=/opt/minecraft/server:/workspace");
      expect(unit).toContain("BindReadOnlyPaths=/opt/mc-agent/toolchain:/toolchain");
      expect(unit).toContain("KillMode=control-group");
      expect(unit).not.toContain("LoadCredential=");
    }
    expect(toolRead).toContain("shell-runner-cli.mjs --read-only");
    expect(installer).toContain("usermod --gid mc-agent-tool --groups mc-agent-workspace mc-agent-tool");
    expect(toolWrite).toContain("shell-runner-cli.mjs --staged-write");
    expect(toolWrite).toContain("TemporaryFileSystem=/changes:rw");
    expect(toolReadSocket).toContain("SocketGroup=mc-agent-executor-client");
    expect(toolWriteSocket).toContain("SocketGroup=mc-agent-executor-client");
    expect(toolReadSocket).toContain("ListenStream=/run/mc-agent/shell-read.sock");
    expect(toolWriteSocket).toContain("ListenStream=/run/mc-agent/shell-write.sock");
    expect(minecraft).not.toMatch(/^LoadCredential=/m);
  });

  it("keeps the executor identity socket root-owned and non-replaceable by the Minecraft UID", () => {
    expect(executorSocket).toContain("ListenStream=/run/mc-agent/executor.sock");
    expect(executorSocket).toContain("FileDescriptorName=executor");
    expect(executorSocket).toContain("SocketUser=root");
    expect(executorSocket).toContain("SocketGroup=mc-agent-gateway-client");
    expect(executorSocket).toContain("SocketMode=0660");
    expect(executorSocket).toContain("DirectoryMode=0755");
    expect(executorCli).toContain('listenFd: systemdSocketActivationFd("executor")');
    expect(executorCli).not.toMatch(/chmod\(config\.socketPath/);
    expect(installer).toContain("install -d -o root -g root -m 0755 /run/mc-agent");
    expect(installer).not.toMatch(/install -d -o minecraft[^\n]*\/run\/mc-agent(?:\s|$)/);
    expect(executor).not.toContain("ReadWritePaths=/run/mc-agent");
    expect(gateway).not.toContain("ReadWritePaths=/run/mc-agent\n");
  });

  it("recreates exact runtime parents before either socket can bind", () => {
    expect(tmpfiles).toContain("d /run/mc-agent 0755 root root -");
    // Socket creation must inherit the client group, not the gateway's private primary group.
    expect(tmpfiles).toContain("d /run/mc-agent-download 2750 mc-agent-gateway mc-agent-gateway-client -");
    expect(installer).toContain("-g mc-agent-gateway-client -m 2750 /run/mc-agent-download");
    expect(tmpfiles).toContain("d /run/mc-agent 0755 root root -");
    expect(tmpfiles).not.toMatch(/\/run\/mc-agent-download\s+0?7[0-7]{2}\s+minecraft/);
    expect(gateway).toContain("After=network-online.target systemd-tmpfiles-setup.service mc-agent-executor.socket");
    expect(executorSocket).toContain("After=systemd-tmpfiles-setup.service");
    expect(profileInstaller).toContain("systemd-tmpfiles --create /usr/lib/tmpfiles.d/mc-agent.conf");
  });

  it("uses bounded safe extraction, immutable releases, idempotent install, and atomic rollback", () => {
    expect(spawnSync("bash", ["-n", installerPath]).status).toBe(0);
    expect(installer).toContain("MAX_RUNTIME_ARCHIVE_BYTES");
    expect(installer).toContain("MAX_RUNTIME_EXPANDED_BYTES");
    expect(installer).toContain("O_NOFOLLOW");
    expect(installer).toContain("runtime bundle member checksum mismatch");
    expect(installer).toContain("runtime bundle manifest checksum mismatch");
    expect(installer).toContain('[[ "$bytes" == "$expected_bytes" ]]');
    expect(installer).toContain('[[ -d "$release" ]] && return');
    expect(installer).toContain("mv -Tf");
    expect(installer).toContain("previous release restored");
    expect(installer).toContain("rollback-transition");
    expect(installer).not.toContain('"$ROOT/runtime-previous"');
    expect(installer).toContain("mc-agent-world-roots.py verify");
    expect(installer).toContain("installed world-root verifier is missing");
    expect(installer).toContain("executor-root/usr/local/bin/mc-agent-world-roots.py");
    expect(installer).toContain("systemctl try-restart mc-agent-executor.service mc-agent-gateway.service");
    expect(installer).not.toContain("try-restart mc-agent-executor.socket");
    expect(installer).toMatch(/try-restart mc-agent-executor\.service mc-agent-gateway\.service[\s\S]*sleep 3/);
    expect(rollout).toContain("one complete, SSM-published host release");
    expect(rollout).toContain("profile_args=(--manifest-file");
    expect(rollout).toContain("--activate-quiesced");
    expect(profileInstaller).toContain("without mutating live host destinations");
    expect(rollout).toContain("install-runtime-only");
    expect(rollout).toContain("release-manifest");
    expect(rollout).toContain("mc-agent-world-roots.py verify");
    expect(rollout).toContain("aws ssm get-parameter --name /minecraft/server-profile-manifest");
    expect(rollout).not.toContain("--force-reinstall");
    expect(rollout).toContain("runtime-hashes.sha256");
    expect(rollout).toContain("mc-release-journal.py");
    expect(rollout).toContain("runtime_transition_changed");
    expect(rollout).not.toContain("mc-agent-install.sh rollback");
    expect(rollout).toContain("mcstatus 127.0.0.1:25565 status");
    expect(rollout).toContain("probe_unix_service /run/mc-agent/executor.sock");
    expect(rollout).toContain("probe_unix_service /run/mc-agent-download/download.sock");
    expect(rollout).not.toContain("systemctl start minecraft.service mc-agent-executor.socket");
    expect(rollout.indexOf("systemctl stop mc-agent-world-roots.service")).toBeLessThan(
      rollout.indexOf("profile_args=(--manifest-file")
    );
    expect(rollout.lastIndexOf('restore_services "$service_state"')).toBeGreaterThan(
      rollout.indexOf("install-runtime-only")
    );
    expect(installer).toContain("/etc/mc-agent/provider-*");
    expect(installer).toContain("openssl pkey -pubin -in /etc/mc-agent/backup-fence-public.pem");
    expect(installer).toContain("ensure-credentials [backup-fence-public-source]");
    expect(installer).not.toMatch(/npm|pnpm|yarn|dnf|yum/);
  });

  it("starts requested agent endpoints and activates the executor only after candidate Minecraft starts", () => {
    const enable = rollout.indexOf(
      "if (( ENABLE_AGENT == 1 )); then",
      rollout.indexOf('restore_services "$service_state"')
    );
    const startSocket = rollout.indexOf("systemctl start mc-agent-executor.socket", enable);
    const startGateway = rollout.indexOf("systemctl start mc-agent-gateway.service", startSocket);
    expect(enable).toBeGreaterThan(-1);
    expect(startSocket).toBeGreaterThan(enable);
    expect(startGateway).toBeGreaterThan(startSocket);
    expect(rollout.indexOf("systemctl start mc-agent-executor.service", enable)).toBe(-1);
    expect(rollout).toContain("probe_unix_service /run/mc-agent/executor.sock invalid-request");
    expect(rollout).toContain("probe_readiness");
    expect(rollout).toContain("rollback_attempt");
    expect(rollout).toContain("start_candidate_minecraft");
    expect(rollout).toContain("stop_candidate_minecraft");
  });

  it("retains the transaction and rolls back when requested agent startup or readiness fails", () => {
    const firstStart = rollout.indexOf("systemctl start mc-agent-executor.socket");
    const readiness = rollout.indexOf("run_readiness_and_restore_state", firstStart);
    const rollback = rollout.indexOf("rollback_attempt");
    expect(firstStart).toBeGreaterThan(-1);
    expect(readiness).toBeGreaterThan(firstStart);
    expect(rollback).toBeGreaterThan(-1);
    expect(rollout).toContain("journal_started=1");
    expect(rollout).toContain("Host release rollback failed; the attempt journal is retained");
    expect(rollout).toContain('systemctl mask --runtime "${SERVICE_UNITS[@]}"');
    expect(rollout).toContain("restore_agent_target_wants_for_not_found");
    expect(rollout).toContain("snapshot_agent_target_wants_record");
  });

  it("requires the exact executor credential set and stages config before reconciliation", () => {
    expect(executor.match(/^LoadCredential=/gm)).toHaveLength(3);
    expect(executor).toContain("LoadCredential=executor-journal-hmac:/etc/mc-agent/executor-journal-hmac.key");
    expect(executor).toContain("LoadCredential=executor-receipt-private:/etc/mc-agent/executor-receipt-private.pem");
    expect(executor).toContain("LoadCredential=executor-clean-start-epoch:/etc/mc-agent/executor-clean-start-epoch");
    expect(executor).toContain(
      "BindReadOnlyPaths=/etc/mc-agent/backup-fence-public.pem:/config/backup-fence-public.pem"
    );
    expect(installer).toContain("ensure-credentials [backup-fence-public-source]");
    const stage = profileInstaller.indexOf('config_stage="$work/config-stage"');
    const reconcile = profileInstaller.indexOf('"$WORLD_ROOTS_HELPER" reconcile');
    const finalVerify = profileInstaller.indexOf("reconciled gateway config was not created");
    expect(stage).toBeGreaterThan(-1);
    expect(stage).toBeLessThan(reconcile);
    expect(finalVerify).toBeGreaterThan(reconcile);
  });

  it("keeps fresh, disabled-existing, and explicit upgrade paths executable without secret logging", () => {
    const userData = readFileSync(path.join(ec2, "user_data.sh"), "utf8");
    const upgrade = readFileSync(path.resolve(process.cwd(), "scripts/aws/upgrade-existing-host.ts"), "utf8");
    expect(spawnSync("bash", ["-n", path.join(ec2, "user_data.sh")]).status).toBe(0);
    expect(spawnSync("bash", ["-n", path.join(ec2, "mc-runtime-rollout.sh")]).status).toBe(0);
    expect(userData).toContain('mc-profile-install.sh" --bootstrap --release-root');
    expect(profileInstaller).toContain("ENABLE_AGENT=0");
    expect(upgrade).toContain("--enable-agent");
    expect(upgrade).toContain("--gateway-credential-source");
    expect(upgrade).toContain("deriveBackupFencePublicKeyPem");
    expect(profileInstaller).toContain("gateway credential source contains missing or extra credentials");
    expect(profileInstaller).not.toMatch(/printf[^\n]*(runtime-bearer|provider-openrouter)/);
    expect(userData).not.toMatch(
      /printf[^\n]*(?:MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8|runtime-bearer|provider-openrouter)/
    );
  });

  it("retains borrowed host-replacement maintenance ownership on rollout failure", () => {
    const rollout = readFileSync(path.join(ec2, "mc-runtime-rollout.sh"), "utf8");
    const profileInstaller = readFileSync(path.join(ec2, "mc-profile-install.sh"), "utf8");
    const agentInstaller = readFileSync(path.join(ec2, "mc-agent-install.sh"), "utf8");
    expect(rollout).toContain("preserve_borrowed_maintenance=1");
    expect(rollout).toContain("(( preserve_borrowed_maintenance == 0 )) || return 0");
    expect(rollout).toContain("preserve_borrowed_maintenance == 1 || RETAIN_SUCCESSFUL_MAINTENANCE == 1");
    expect(rollout).toContain("allowed = {adopted_operation}");
    expect(rollout).toContain('MC_MAINTENANCE_PARENT_OPERATION="$ADOPT_MAINTENANCE_OPERATION"');
    expect(profileInstaller).toContain('MAINTENANCE_PARENT_OPERATION" == "host-replacement"');
    expect(agentInstaller).toContain('MAINTENANCE_PARENT_OPERATION" == "host-replacement"');
    expect(profileInstaller).toContain("allowed = {parent_operation}");
    expect(agentInstaller).toContain("allowed = {parent_operation}");
    expect(rollout).toContain("executor journal checkpoint must be a non-negative integer");
    expect(rollout.indexOf('for target_wants in "${AGENT_TARGET_WANTS[@]}"')).toBeLessThan(
      rollout.indexOf('"$profile_installer" "${profile_args[@]}"')
    );
    expect(rollout.indexOf("start_candidate_minecraft")).toBeLessThan(rollout.indexOf("probe_readiness"));
    const resume = readFileSync(path.join(ec2, "mc-resume.sh"), "utf8");
    const resumeReadiness = resume.indexOf("mc-wait-ready.sh raw_ip");
    expect(resumeReadiness).toBeLessThan(resume.indexOf("\nrelease_maintenance_fence", resumeReadiness));
    expect(resume).toContain('PARENT_MAINTENANCE_OPERATION" != "host-replacement"');
    expect(resume).toContain("parent maintenance ownership remains held for outer commit");
    expect(backup).not.toContain('BACKUP_UPLOADED" == "1" && "$exit_code" == "0"');
    expect(backup).toContain('MAINTENANCE_OPERATION="host-replacement"');
  });

  it("fails the production effects adapter closed outside the real executor OS sandbox", async () => {
    await expect(ProductionDirectLiveHostEffects.create()).rejects.toThrow(/Executor/);
    const source = readFileSync(path.resolve(process.cwd(), "agent-runtime/src/pinned-https.ts"), "utf8");
    expect(source).toContain("validated.addresses");
    expect(source).toContain('redirect: "manual"');
    expect(source).toContain("next.origin !== initialOrigin");
    expect(source).toContain("lookup:");
    const relay = readFileSync(path.resolve(process.cwd(), "agent-runtime/src/download-relay.ts"), "utf8");
    expect(relay).toContain('"accept-encoding": "identity"');
    expect(relay).toContain("GatewayDownloadRelayAuthorizer");
    const effects = readFileSync(path.resolve(process.cwd(), "agent-runtime/src/live-host-effects.ts"), "utf8");
    expect(effects).toContain("UnixShellRunnerClient");
    expect(effects).toContain("Reviewed shell runner returned untrusted command data.");
    expect(effects).toContain("Minecraft console bridge is unavailable under the separated executor identity.");
    expect(effects).toContain('request.cwd !== "/workspace"');
    expect(effects).toContain("request.mode");
  });

  it("routes every production HTTP path through the injectable pinned transport", () => {
    const runtimeSource = path.resolve(process.cwd(), "agent-runtime/src");
    const gatewayCli = readFileSync(path.join(runtimeSource, "gateway-cli.ts"), "utf8");
    const pinned = readFileSync(path.join(runtimeSource, "pinned-https.ts"), "utf8");
    const responseGuard = readFileSync(path.join(runtimeSource, "provider-response-guard.ts"), "utf8");
    const directUndiciImports = readdirSync(runtimeSource)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .filter((name) => /from ["']undici["']/.test(readFileSync(path.join(runtimeSource, name), "utf8")));
    expect(directUndiciImports).toEqual(["pinned-https.ts"]);
    expect(gatewayCli).not.toMatch(/from ["']undici["']/);
    expect(gatewayCli).toContain("const transport = new PinnedHttpsTransport()");
    expect(gatewayCli.match(/fetch: transport\.fetch/g)).toHaveLength(2);
    expect(gatewayCli).toContain("new ProviderResponseGuard({ fetch: transport.fetch })");
    expect(gatewayCli).toContain("fetch: providerResponseGuard.fetch");
    expect(gatewayCli).toContain("providerResponseLimitSignal: providerResponseGuard.signal");
    expect(gatewayCli).toContain("transport,");
    expect(gatewayCli).toContain("boundProviderCredentials");
    expect(gatewayCli).toContain("providerSystemdCredentialPath");
    expect(gatewayCli).not.toMatch(/apiKey:\s*runtimeBearer/);
    expect(pinned).toContain("request?: UndiciFetch");
    expect(pinned).toContain("options.request ?? undiciFetch");
    expect(responseGuard).toContain('headers.set("accept-encoding", "identity")');
    expect(responseGuard).toContain("budget?.accept(next.value)");
    expect(responseGuard).toContain("reader.cancel(new ProviderResponseLimitError())");
  });
});
