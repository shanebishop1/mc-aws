import { createHash } from "node:crypto";
import type {
  AgentApproval,
  AgentCapability,
  BackupMode,
  EvidenceReference,
  JsonObject,
  PermissionDecision,
  TargetScope,
  ToolInvocation,
} from "@/lib/agent/contracts";
import { createDirectLiveExecutor } from "@/lib/agent/executor/executor";
import {
  inspectMinecraftCommand,
  isGenericImmutableAssetMutation,
  isMinecraftAccessControlPath,
  riskFacts,
} from "@/lib/agent/executor/guards";
import type {
  ApprovalConsumer,
  CanonicalPath,
  DirectLiveHostEffects,
  HostEffectResult,
} from "@/lib/agent/executor/types";
import { IndeterminateHostEffectError } from "@/lib/agent/executor/types";
import { isImmutableAgentAssetPath } from "@/lib/agent/immutable-assets";
import {
  canonicalPersistentWorldRoots,
  isPersistentWorldMutation,
  isPersistentWorldPath,
  isRootServerPropertiesMutation,
  serverPropertiesSecurityKeys,
} from "@/lib/agent/minecraft-security";
import { networkDownloadApprovalScope } from "@/lib/agent/network-download";
import {
  classifyRisk,
  createInvocationDigest,
  createInvocationSummaryDigest,
  createProposedInvocationSummary,
} from "@/lib/agent/policy";
import { createCustomPolicy, createPolicyFromPreset } from "@/lib/agent/presets";
import { describe, expect, it, vi } from "vitest";

const NOW = "2026-09-02T12:00:00.000Z";
const WORKSPACE = "/fixture/server";
const SCRATCH = "/fixture/scratch";

function evidence(kind: EvidenceReference["kind"] = "file"): EvidenceReference {
  return {
    schemaVersion: 1,
    evidenceId: `evidence-${kind}`,
    kind,
    uri: `agent-evidence://session-1/${kind}`,
    description: `${kind} evidence`,
  };
}

function hostResult(summary = "completed", kind: EvidenceReference["kind"] = "file"): HostEffectResult {
  return { summary, output: { changed: true }, evidence: [evidence(kind)] };
}

function fakeEffects(overrides: Partial<DirectLiveHostEffects> = {}): DirectLiveHostEffects & { calls: string[] } {
  const calls: string[] = [];
  const effect =
    (name: string, kind: EvidenceReference["kind"] = "file") =>
    async () => {
      calls.push(name);
      return hostResult(name, kind);
    };
  return {
    calls,
    securityCapabilities: {
      descriptorRelativeWorkspaceConfinement: true,
      workspaceRootedCommandBoundary: true,
      pinnedDnsRedirectEgressEnforcement: true,
    },
    async canonicalize(value): Promise<CanonicalPath> {
      if (value === WORKSPACE || value === SCRATCH || value === `${SCRATCH}/session-1`)
        return { path: value, kind: "directory" };
      return { path: value, kind: value.endsWith("new.txt") || value.endsWith("download.jar") ? "missing" : "file" };
    },
    readFile: effect("read"),
    writeFile: effect("write", "diff"),
    deletePath: effect("delete", "diff"),
    executeProcess: effect("shell", "command-output"),
    executeConsole: effect("console", "console-output"),
    download: effect("download"),
    requestBackup: async () => {
      calls.push("backup");
      return { summary: "backup", output: { status: "succeeded" }, evidence: [evidence("backup")] };
    },
    loadExtension: effect("extension"),
    ...overrides,
  };
}

function scope(kind: TargetScope["kind"], normalizedTarget: string): TargetScope {
  return { schemaVersion: 1, kind, normalizedTarget };
}

function invocation(
  toolId: string,
  capability: AgentCapability,
  targetScope: TargetScope,
  args: JsonObject,
  invocationId = "invocation-1"
): ToolInvocation {
  return {
    schemaVersion: 1,
    invocationId,
    sessionId: "session-1",
    toolId,
    capability,
    targetScope,
    arguments: toolId === "network.download" ? { expectedSha256: "a".repeat(64), expectedBytes: 1, ...args } : args,
    requestedAt: NOW,
  };
}

function policy(decision: PermissionDecision = "allow", backupMode: BackupMode = "never") {
  const base = createPolicyFromPreset("autopilot", "executor-policy");
  return createCustomPolicy(
    base,
    "executor-custom",
    2,
    Object.fromEntries(base.rules.map((rule) => [rule.capability, decision])),
    backupMode
  );
}

async function approvalFor(
  item: ToolInvocation,
  risk: "risky" | "destructive" = "risky",
  overrides: Partial<AgentApproval> = {}
): Promise<AgentApproval> {
  const initialSummary = await createProposedInvocationSummary(item, risk);
  const result: AgentApproval = {
    schemaVersion: 1,
    approvalId: "approval-1",
    actorId: "operator-1",
    sessionId: "session-1",
    policyId: "executor-custom",
    policyRevision: 2,
    invocationDigest: await createInvocationDigest(item),
    invocationSummary: initialSummary,
    invocationSummaryDigest: await createInvocationSummaryDigest(initialSummary),
    scope: {
      schemaVersion: 1,
      kind: "single-invocation",
      capability: item.capability,
      targetScope: item.targetScope,
      risk,
    },
    expiresAt: "2099-09-02T12:00:00.000Z",
    decision: "approved",
    reason: "approved",
    decidedAt: NOW,
    ...overrides,
  };
  if (!overrides.invocationSummary) {
    result.invocationSummary = {
      ...result.invocationSummary,
      targetScope: result.scope.targetScope,
      risk: result.scope.risk,
    };
    result.invocationSummaryDigest = await createInvocationSummaryDigest(result.invocationSummary);
  }
  return result;
}

function executor(effects: DirectLiveHostEffects, consumer?: ApprovalConsumer) {
  return createDirectLiveExecutor(
    effects,
    {
      workspaceRoot: WORKSPACE,
      scratchRoot: SCRATCH,
      allowedExecutables: { grep: "/usr/bin/grep", ls: "/usr/bin/ls" },
      maxTimeoutMs: 1000,
    },
    consumer
  );
}

async function run(
  effects: DirectLiveHostEffects,
  item: ToolInvocation,
  overrides: Partial<Parameters<ReturnType<typeof executor>["execute"]>[0]> = {},
  consumer?: ApprovalConsumer
) {
  return executor(effects, consumer).execute({
    actorId: "operator-1",
    invocation: item,
    policy: policy(),
    approvals: [],
    ...overrides,
  });
}

describe("direct-live executor immutable boundary", () => {
  it.each([
    "paper.jar",
    "plugins/Example.jar",
    "plugins/nested/native.so",
    "scripts/start.sh",
    "lib/libnative.so.1.2",
    "profile/launcher",
    "runtime/agent",
    "systemd/minecraft.service",
  ])("identifies canonical protected executable asset %s", (target) => {
    expect(isImmutableAgentAssetPath(target)).toBe(true);
  });

  it.each([
    "paper.jar.bak",
    "Paper.jar",
    "plugins/Example.JAR",
    "plugins-extra/Example.jar",
    "Plugins/Example.jar",
    "plugins//Example.jar",
    "plugins/../Example.jar",
    "scripts/start.sh.bak",
    "lib/libnative.so.backup",
    "systemdX/minecraft.service",
    "profiled/launcher",
  ])("does not treat a lookalike or non-canonical asset path %s as protected", (target) => {
    expect(isImmutableAgentAssetPath(target)).toBe(false);
  });

  it.each([
    ["workspace.write", "workspace.write", "paper.jar", { path: "paper.jar", content: "unreviewed" }],
    ["workspace.delete", "workspace.delete", "plugins/Example.jar", { path: "plugins/Example.jar" }],
    [
      "network.download",
      "network.outbound",
      "scripts/start.sh",
      {
        url: "https://downloads.example.invalid/start.sh",
        destination: "scripts/start.sh",
      },
    ],
    [
      "workspace.write",
      "workspace.write",
      "world/datapacks/example/data/example/functions/load.mcfunction",
      { path: "world/datapacks/example/data/example/functions/load.mcfunction", content: "function" },
    ],
  ] as const)("marks generic protected asset mutation %s as immutable", (toolId, capability, target, args) => {
    const item = invocation(toolId, capability, scope("workspace", target), args as JsonObject);
    expect(isGenericImmutableAssetMutation(item)).toBe(true);
  });

  it("denies protected generic mutations even when policy and exact approval would otherwise allow them", async () => {
    const effects = fakeEffects();
    const item = invocation("workspace.write", "workspace.write", scope("workspace", "paper.jar"), {
      path: "paper.jar",
      content: "unreviewed",
    });
    const approval = await approvalFor(item, "risky");
    const output = await run(effects, item, {
      policy: policy("ask-once"),
      approvals: [approval],
    });
    expect(output).toMatchObject({
      status: "failed",
      output: { code: "denied", decision: { immutableBoundary: "an immutable runtime or profile asset" } },
    });
    expect(effects.calls).toEqual([]);
  });

  it.each([
    "../outside",
    "nested/../../outside",
    "nested/../server.properties",
    "/fixture/server/nested/../server.properties",
    "/etc/passwd",
  ])("rejects traversal or unrelated path %s before effects", async (target) => {
    const effects = fakeEffects();
    const output = await run(
      effects,
      invocation("workspace.read", "workspace.read", scope("workspace", target), { path: target })
    );
    expect(output.status).toBe("failed");
    expect(effects.calls).toEqual([]);
  });

  it.each([
    ["workspace.read", "workspace.read", scope("workspace", "server.properties"), { path: "server.properties" }, {}],
    [
      "shell.execute",
      "shell.execute",
      scope("workspace", "."),
      { mode: "read-only", command: "grep motd server.properties", timeoutMs: 1_000 },
      { descriptorRelativeWorkspaceConfinement: true },
    ],
    [
      "network.download",
      "network.outbound",
      scope("workspace", "download.jar"),
      { url: "https://example.invalid/plugin.jar", destination: "download.jar" },
      { descriptorRelativeWorkspaceConfinement: true },
    ],
  ] as const)(
    "disables dangerous %s when the adapter cannot attest required security",
    async (toolId, capability, target, args, securityCapabilities) => {
      const effects = fakeEffects({ securityCapabilities });
      const output = await run(effects, invocation(toolId, capability, target, args as JsonObject));
      expect(output).toMatchObject({ status: "failed", output: { code: "immutable-boundary" } });
      expect(effects.calls).toEqual([]);
    }
  );

  it("rejects a canonical symlink escape before effects", async () => {
    const effects = fakeEffects({
      async canonicalize(value) {
        if (value === WORKSPACE || value === SCRATCH || value === `${SCRATCH}/session-1`)
          return { path: value, kind: "directory" };
        return { path: "/etc/shadow", kind: "file" };
      },
    });
    const output = await run(
      effects,
      invocation("workspace.read", "workspace.read", scope("workspace", "link"), { path: "link" })
    );
    expect(output).toMatchObject({ status: "failed", output: { code: "immutable-boundary" } });
    expect(effects.calls).toEqual([]);
  });

  it.each([
    ["/usr/bin/sudo", ["ls"]],
    ["/usr/bin/systemctl", ["restart", "minecraft"]],
    ["/usr/bin/apt-get", ["install", "curl"]],
    ["/usr/bin/curl", ["http://169.254.169.254/latest/meta-data"]],
    ["/usr/bin/aws", ["s3", "ls"]],
    ["/usr/bin/grep", ["secret", "/etc/minecraft/runtime.env"]],
    ["/usr/bin/grep", ["secret", "/tmp/unrelated"]],
    ["/usr/bin/grep", ["secret", "../scratch/session-other/private.txt"]],
    ["/usr/bin/grep", ["secret", "/fixture/scratch/session-other/private.txt"]],
    ["/usr/bin/screen", ["-S", "mc-server", "-X", "stuff", "op attacker"]],
  ])("rejects forbidden command %s", async (executable, args) => {
    const effects = fakeEffects();
    const output = await run(
      effects,
      invocation("shell.execute", "shell.execute", scope("workspace", "."), { executable, args })
    );
    expect(output.status).toBe("failed");
    expect(effects.calls).toEqual([]);
  });

  it.each([
    [[".", "-delete"]],
    [[".", "-exec", "/usr/bin/screen", "{}", ";"]],
    [[".", "-execdir", "/bin/sh", "-c", "id", ";"]],
    [[".", "-fprint", "changed.txt"]],
    [[".", "-fprintf", "changed.txt", "%p\\n"]],
  ])("rejects dangerous find action %j even if find is configured", async (args) => {
    const effects = fakeEffects();
    const output = await createDirectLiveExecutor(effects, {
      workspaceRoot: WORKSPACE,
      scratchRoot: SCRATCH,
      allowedExecutables: { find: "/usr/bin/find" },
    }).execute({
      actorId: "operator-1",
      invocation: invocation("shell.execute", "shell.execute", scope("workspace", "."), {
        executable: "/usr/bin/find",
        args,
      }),
      policy: policy(),
      approvals: [],
    });
    expect(output).toMatchObject({ status: "failed", output: { code: "denied" } });
    expect(effects.calls).toEqual([]);
  });

  it.each(["https://169.254.169.254/latest", "https://ssm.us-east-1.amazonaws.com/"])(
    "rejects forbidden outbound target %s",
    async (url) => {
      const effects = fakeEffects();
      const output = await run(
        effects,
        invocation("network.download", "network.outbound", scope("workspace", "download.jar"), {
          url,
          destination: "download.jar",
        })
      );
      expect(output).toMatchObject({ status: "failed", output: { code: "immutable-boundary" } });
      expect(effects.calls).toEqual([]);
    }
  );
});

describe("direct-live executor policy, backup, and cancellation", () => {
  it("requires exact destructive approval before a staged shell replacement and validates its result", async () => {
    const stagedBytes = new TextEncoder().encode("updated");
    const effects = fakeEffects({
      async executeProcess() {
        effects.calls.push("shell");
        return {
          summary: "runner",
          output: { exitCode: 0 },
          evidence: [],
          stagedResult: {
            regularFile: true,
            noLink: true,
            bytes: stagedBytes,
            sha256: createHash("sha256").update(stagedBytes).digest("hex"),
          },
        };
      },
    });
    const item = invocation("shell.execute", "shell.execute", scope("workspace", "status.txt"), {
      mode: "staged-write",
      command: 'printf updated > "$TMPDIR/result"',
      timeoutMs: 1_000,
      change: { operation: "replace", path: "status.txt" },
    });
    const consumer = { consume: vi.fn().mockResolvedValue(true) };
    const executorWithConsumer = executor(effects, consumer);
    const pending = await executorWithConsumer.execute({
      actorId: "operator-1",
      invocation: item,
      policy: policy(),
      approvals: [],
    });
    expect(pending).toMatchObject({ status: "failed", output: { code: "approval-required" } });
    expect(effects.calls).toEqual([]);

    const approval = await approvalFor(item, "destructive");
    const completed = await executorWithConsumer.execute({
      actorId: "operator-1",
      invocation: item,
      policy: policy(),
      approvals: [approval],
    });
    expect(completed.status).toBe("succeeded");
    expect(effects.calls).toEqual(["shell", "write"]);
  });

  it("does not require a staged result for a shell delete and blocks delayed code targets", async () => {
    const effects = fakeEffects({
      async executeProcess() {
        effects.calls.push("shell");
        return { summary: "runner", output: { exitCode: 0 }, evidence: [] };
      },
    });
    const deletion = invocation("shell.execute", "shell.execute", scope("workspace", "status.txt"), {
      mode: "staged-write",
      command: ":",
      timeoutMs: 1_000,
      change: { operation: "delete", path: "status.txt" },
    });
    const approval = await approvalFor(deletion, "destructive");
    const output = await executor(effects, { consume: vi.fn().mockResolvedValue(true) }).execute({
      actorId: "operator-1",
      invocation: deletion,
      policy: policy(),
      approvals: [approval],
    });
    expect(output.status).toBe("succeeded");
    expect(effects.calls).toEqual(["shell", "delete"]);

    const delayedCode = invocation(
      "shell.execute",
      "shell.execute",
      scope("workspace", "datapacks/example/data/example/functions/load.mcfunction"),
      {
        mode: "staged-write",
        command: ":",
        timeoutMs: 1_000,
        change: { operation: "replace", path: "datapacks/example/data/example/functions/load.mcfunction" },
      }
    );
    const denied = await run(effects, delayedCode);
    expect(denied).toMatchObject({ status: "failed", output: { code: "denied" } });
  });

  it.each(["plugins/example.jar", "paper.jar", "scripts/start.sh", "runtime/agent", "server.properties"])(
    "requires an operator content identity for executable/runtime/config target %s",
    async (target) => {
      const item = invocation("network.download", "network.outbound", scope("workspace", target), {
        url: `https://downloads.example.invalid/${target}`,
        destination: target,
      });
      item.arguments = { url: item.arguments.url, destination: item.arguments.destination };
      const effects = fakeEffects();
      const output = await run(effects, item);
      expect(output).toMatchObject({ status: "failed", output: { code: "immutable-boundary" } });
      expect(effects.calls).toEqual([]);
    }
  );

  it.each([
    "ops.json",
    "whitelist.json",
    "banned-players.json",
    "banned-ips.json",
    "usercache.json",
    "permissions.yml",
    "plugins/LuckPerms/config.yml",
    "plugins/LuckPerms/luckperms-h2-v2.mv.db",
    "plugins/PermissionsEx/permissions.yml",
    "plugins/GroupManager/worlds/world/groups.yml",
  ])("classifies a write to Minecraft access-control path %s as destructive", (target) => {
    const item = invocation("workspace.write", "workspace.write", scope("workspace", target), {
      path: target,
      content: "[]",
    });
    expect(isMinecraftAccessControlPath(target)).toBe(true);
    const facts = riskFacts(item);
    expect(facts.permissionChange).toBe(true);
    expect(classifyRisk(item.capability, facts)).toBe("destructive");
  });

  it.each([
    ["workspace.delete", "workspace.delete", { path: "ops.json" }],
    [
      "network.download",
      "network.outbound",
      { url: "https://downloads.example.invalid/ops.json", destination: "ops.json" },
    ],
  ] as const)("marks %s targeting access control as a permission change", (toolId, capability, args) => {
    const item = invocation(toolId, capability, scope("workspace", "ops.json"), args);
    expect(riskFacts(item).permissionChange).toBe(true);
  });

  it.each([
    "notes/ops.json",
    "ops.json.backup",
    "my-whitelist.json",
    "OPS.JSON",
    "ops%2Ejson",
    "plugins/LuckPermsExtra/config.yml",
    "plugins/luckperms/config.yml",
    "plugins/LuckPerms-config.yml",
    "plugins//LuckPerms/config.yml",
    "plugins/LuckPerms/../Other/config.yml",
  ])("does not use substring, case-folded, encoded, or non-canonical matching for %s", (target) => {
    expect(isMinecraftAccessControlPath(target)).toBe(false);
  });

  it.each([
    ["workspace.write", "workspace.write", { path: "server.properties", content: "motd=Safe" }],
    ["workspace.delete", "workspace.delete", { path: "server.properties", recursive: false }],
    [
      "network.download",
      "network.outbound",
      { url: "https://downloads.example.invalid/server.properties", destination: "server.properties" },
    ],
    [
      "shell.execute",
      "shell.execute",
      { mode: "staged-write", change: { operation: "replace", path: "server.properties" } },
    ],
  ] as const)("classifies canonical root server.properties %s as destructive", (toolId, capability, args) => {
    const item = invocation(toolId, capability, scope("workspace", "server.properties"), args as JsonObject);
    expect(isRootServerPropertiesMutation(item)).toBe(true);
    expect(riskFacts(item).permissionChange).toBe(true);
    expect(classifyRisk(item.capability, riskFacts(item))).toBe("destructive");
  });

  it.each([
    "config/server.properties",
    "notes/server.properties",
    "server.properties.bak",
    "my-server.properties",
    "SERVER.PROPERTIES",
  ])("does not treat benign similarly named or nested target %s as root server.properties", (target) => {
    const item = invocation("workspace.write", "workspace.write", scope("workspace", target), {
      path: target,
      content: "online-mode=true",
    });
    expect(isRootServerPropertiesMutation(item)).toBe(false);
    expect(riskFacts(item).permissionChange).toBe(false);
    expect(classifyRisk(item.capability, riskFacts(item))).toBe("risky");
  });

  it.each([
    "world/level.dat",
    "world/region/r.0.0.mca",
    "world_nether/DIM-1/region/r.0.0.mca",
    "world_the_end/DIM1/entities/r.0.0.mca",
  ])("classifies default persistent dimension target %s as destructive", (target) => {
    const item = invocation("workspace.write", "workspace.write", scope("workspace", target), {
      path: target,
      content: "world-data",
    });
    expect(isPersistentWorldMutation(item)).toBe(true);
    expect(classifyRisk(item.capability, riskFacts(item))).toBe("destructive");
  });

  it.each([
    ["workspace.write", "workspace.write", { path: "world/level.dat", content: "data" }],
    ["workspace.delete", "workspace.delete", { path: "world_nether/DIM-1", recursive: true }],
    [
      "network.download",
      "network.outbound",
      { url: "https://downloads.example.invalid/level.dat", destination: "world_the_end/level.dat" },
    ],
  ] as const)("marks %s to any configured dimension as a world change", (toolId, capability, args) => {
    const target = "path" in args ? args.path : args.destination;
    const item = invocation(toolId, capability, scope("workspace", target), args);
    expect(riskFacts(item).worldChange).toBe(true);
    expect(classifyRisk(item.capability, riskFacts(item))).toBe("destructive");
  });

  it.each(["survival", "survival_nether", "survival_the_end", "dimensions/event-world"])(
    "uses an authoritative custom level root for %s",
    (target) => {
      const roots = ["survival", "survival_nether", "survival_the_end", "dimensions/event-world"];
      const item = invocation("network.download", "network.outbound", scope("workspace", `${target}/level.dat`), {
        url: "https://downloads.example.invalid/level.dat",
        destination: `${target}/level.dat`,
      });
      expect(isPersistentWorldMutation(item, roots)).toBe(true);
      expect(classifyRisk(item.capability, riskFacts(item, false, roots))).toBe("destructive");
    }
  );

  it.each([
    "myworld/level.dat",
    "world-copy/level.dat",
    "world_nether_backup/level.dat",
    "WORLD/level.dat",
    "notes/world/level.dat",
    "survival-copy/level.dat",
  ])("rejects world-root substring, lookalike, case, or nesting match %s", (target) => {
    expect(isPersistentWorldPath(target, ["world", "survival"])).toBe(false);
  });

  it.each(["../world", "/world", "world/../other", "world/", "world//region", "world\\region", ".", ""])(
    "rejects non-canonical configured world root %j",
    (root) => expect(() => canonicalPersistentWorldRoots([root])).toThrow(/world roots/i)
  );

  it("requires a before-destructive backup before a persistent-world write", async () => {
    const effects = fakeEffects();
    const item = invocation("workspace.write", "workspace.write", scope("workspace", "world/level.dat"), {
      path: "world/level.dat",
      content: "world-data",
    });
    const approval = await approvalFor(item, "destructive");
    const output = await run(
      effects,
      item,
      { policy: policy("allow", "before-destructive"), approvals: [approval] },
      { consume: vi.fn().mockResolvedValue(true) }
    );
    expect(output.status, JSON.stringify(output)).toBe("succeeded");
    expect(effects.calls).toEqual(["backup", "write"]);
    const summary = await createProposedInvocationSummary(item, "destructive");
    expect(summary.diffSummary).toContain("Destructive persistent-world mutation");
    expect(summary.diffSummary).toContain('configured world root "world"');
  });

  it("enforces a custom level-name root supplied by executor runtime configuration", async () => {
    const effects = fakeEffects();
    const item = invocation("workspace.write", "workspace.write", scope("workspace", "survival/level.dat"), {
      path: "survival/level.dat",
      content: "world-data",
    });
    const approval = await approvalFor(item, "destructive");
    const configured = createDirectLiveExecutor(
      effects,
      {
        workspaceRoot: WORKSPACE,
        scratchRoot: SCRATCH,
        persistentWorldRoots: ["survival", "survival_nether", "survival_the_end"],
        allowedExecutables: {},
      },
      { consume: vi.fn().mockResolvedValue(true) }
    );
    const output = await configured.execute({
      actorId: "operator-1",
      invocation: item,
      policy: policy("allow", "before-destructive"),
      approvals: [approval],
    });
    expect(output.status).toBe("succeeded");
    expect(effects.calls).toEqual(["backup", "write"]);
    expect(
      (
        await createProposedInvocationSummary(item, "destructive", {
          persistentWorldRoots: ["survival", "survival_nether", "survival_the_end"],
        })
      ).diffSummary
    ).toContain('configured world root "survival"');
  });

  it("names only exact security keys in the destructive approval explanation", async () => {
    const item = invocation("workspace.write", "workspace.write", scope("workspace", "server.properties"), {
      path: "server.properties",
      content: [
        "online-mode=true",
        "enforce-whitelist=true",
        "rcon.password=redacted-fixture",
        "online-mode-backup=false",
        "nested.rcon.password=benign",
      ].join("\n"),
    });
    expect(serverPropertiesSecurityKeys(item.arguments.content)).toEqual([
      "enforce-whitelist",
      "online-mode",
      "rcon.password",
    ]);
    const summary = await createProposedInvocationSummary(item, "destructive", {
      exactSecrets: ["redacted-fixture"],
    });
    expect(summary.diffSummary).toContain("Destructive permission/access-control configuration");
    expect(summary.diffSummary).toContain(
      "Security-sensitive keys in the proposed content: enforce-whitelist, online-mode, rcon.password."
    );
    expect(summary.diffSummary).not.toContain("redacted-fixture");
  });

  it("requires Autopilot approval and its destructive backup before an access-control write", async () => {
    const item = invocation("workspace.write", "workspace.write", scope("workspace", "ops.json"), {
      path: "ops.json",
      content: "[]",
    });
    const autopilot = createPolicyFromPreset("autopilot", "autopilot-policy");
    const effects = fakeEffects();
    const pending = await executor(effects).execute({
      actorId: "operator-1",
      invocation: item,
      policy: autopilot,
      approvals: [],
    });
    expect(pending).toMatchObject({
      status: "failed",
      output: { code: "approval-required", decision: { risk: "destructive", approvalKind: "ask-always" } },
    });
    expect(effects.calls).toEqual([]);

    const summary = await createProposedInvocationSummary(item, "destructive");
    const approved: AgentApproval = {
      schemaVersion: 1,
      approvalId: "approval-autopilot-ops",
      actorId: "operator-1",
      sessionId: item.sessionId,
      policyId: autopilot.policyId,
      policyRevision: autopilot.revision,
      invocationDigest: await createInvocationDigest(item),
      invocationSummary: summary,
      invocationSummaryDigest: await createInvocationSummaryDigest(summary),
      scope: {
        schemaVersion: 1,
        kind: "single-invocation",
        capability: item.capability,
        targetScope: item.targetScope,
        risk: "destructive",
      },
      expiresAt: "2099-09-02T13:00:00.000Z",
      decision: "approved",
      reason: "approved",
      decidedAt: NOW,
    };
    const completed = await executor(effects, { consume: vi.fn().mockResolvedValue(true) }).execute({
      actorId: "operator-1",
      invocation: item,
      policy: autopilot,
      approvals: [approved],
    });
    expect(completed.status).toBe("succeeded");
    expect(effects.calls).toEqual(["backup", "write"]);
  });

  it("atomically consumes exact approval and rejects replay or scope mismatch", async () => {
    const item = invocation("workspace.write", "workspace.write", scope("workspace", "new.txt"), {
      path: "new.txt",
      content: "safe",
    });
    const approval = await approvalFor(item);
    const decoy = await approvalFor({ ...item, invocationId: "invocation-decoy" }, "risky", {
      approvalId: "approval-decoy",
    });
    const consume = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const effects = fakeEffects();
    const request = {
      actorId: "operator-1",
      invocation: item,
      policy: policy("ask-always"),
      approvals: [decoy, approval],
    };
    expect((await executor(effects, { consume }).execute(request)).status).toBe("succeeded");
    expect(consume).toHaveBeenNthCalledWith(
      1,
      "approval-1",
      "session-1",
      approval.invocationDigest,
      expect.any(String)
    );
    expect((await executor(effects, { consume }).execute(request)).output).toMatchObject({ code: "approval-replay" });
    expect(
      (
        await executor(effects, { consume }).execute({
          ...request,
          approvals: [{ ...approval, scope: { ...approval.scope, targetScope: scope("workspace", "other.txt") } }],
        })
      ).output
    ).toMatchObject({ code: "executor-failed" });
    expect(effects.calls.filter((call) => call === "write")).toHaveLength(1);
  });

  it("pauses without mutation when a required backup fails", async () => {
    const effects = fakeEffects({
      requestBackup: async () => {
        effects.calls.push("backup");
        throw new Error("offline");
      },
    });
    const item = invocation("workspace.write", "workspace.write", scope("workspace", "new.txt"), {
      path: "new.txt",
      content: "safe",
    });
    const output = await run(effects, item, { policy: policy("allow", "before-risky") });
    expect(output).toMatchObject({ status: "failed", output: { code: "backup-paused" } });
    expect(effects.calls).toEqual(["backup"]);
  });

  it("binds network approval grants to the exact HTTPS resource and confined destination", async () => {
    const item = invocation("network.download", "network.outbound", scope("workspace", "download.jar"), {
      url: "https://downloads.example.invalid/v1/plugin.jar",
      destination: "download.jar",
    });
    const grant = await approvalFor(item, "risky", {
      scope: {
        schemaVersion: 1,
        kind: "session-capability",
        capability: "network.outbound",
        targetScope: networkDownloadApprovalScope(
          "https://downloads.example.invalid/v1/plugin.jar",
          scope("workspace", "download.jar"),
          {
            expectedSha256: item.arguments.expectedSha256 as string,
            expectedBytes: item.arguments.expectedBytes as number,
          }
        ),
        risk: "risky",
      },
    });
    const request = { actorId: "operator-1", invocation: item, policy: policy("ask-once"), approvals: [grant] };
    expect((await executor(fakeEffects()).execute(request)).status).toBe("succeeded");
    expect(
      (
        await executor(fakeEffects()).execute({
          ...request,
          invocation: { ...item, arguments: { ...item.arguments, url: "https://evil.example.invalid/plugin.jar" } },
        })
      ).output
    ).toMatchObject({ code: "approval-required" });
    expect(
      (
        await executor(fakeEffects()).execute({
          ...request,
          invocation: {
            ...item,
            arguments: { ...item.arguments, url: "https://downloads.example.invalid/v1/other.jar" },
          },
        })
      ).output
    ).toMatchObject({ code: "approval-required" });
    expect(
      (
        await executor(fakeEffects()).execute({
          ...request,
          invocation: {
            ...item,
            arguments: { ...item.arguments, expectedSha256: "b".repeat(64) },
          },
        })
      ).output
    ).toMatchObject({ code: "approval-required" });
    expect(
      (
        await executor(fakeEffects()).execute({
          ...request,
          invocation: {
            ...item,
            arguments: { ...item.arguments, expectedBytes: 2 },
          },
        })
      ).output
    ).toMatchObject({ code: "approval-required" });
    expect(
      (
        await executor(fakeEffects()).execute({
          ...request,
          invocation: {
            ...item,
            targetScope: scope("workspace", "other.jar"),
            arguments: { ...item.arguments, destination: "other.jar" },
          },
        })
      ).output
    ).toMatchObject({ code: "approval-required" });
  });

  it.each([
    "https://downloads.example.invalid/file.jar?token=secret",
    "https://downloads.example.invalid/file.jar#release",
    "https://user:secret@downloads.example.invalid/file.jar",
    "https://downloads.example.invalid/a/../file.jar",
    "https://downloads.example.invalid/%2e%2e/file.jar",
    "https://downloads.example.invalid/plugins%2ffile.jar",
  ])("rejects ambiguous or credential-bearing download URL %s", async (url) => {
    const effects = fakeEffects();
    const output = await run(
      effects,
      invocation("network.download", "network.outbound", scope("workspace", "download.jar"), {
        url,
        destination: "download.jar",
      })
    );
    expect(output.status).toBe("failed");
    expect(effects.calls).toEqual([]);
  });

  it.each(["list\nstop", "list\rstop", "list\0stop"])("rejects console command injection %j", async (command) => {
    const effects = fakeEffects();
    const output = await run(
      effects,
      invocation("console.execute", "console.execute", scope("console", "server"), { command })
    );
    expect(output).toMatchObject({ status: "failed", output: { code: "immutable-boundary" } });
    expect(effects.calls).toEqual([]);
  });

  it.each([
    "stop",
    "op player",
    "fill 0 0 0 10 10 10 air",
    "whitelist off",
    "/minecraft:stop",
    "execute as @a run minecraft:fill 0 0 0 10 10 10 air",
    "/minecraft:execute as @a run execute at @s run /minecraft:kill @s",
  ])("classifies destructive console command %s", (command) => {
    const item = invocation("console.execute", "console.execute", scope("console", "server"), { command });
    expect(classifyRisk(item.capability, riskFacts(item, true))).toBe("destructive");
  });

  it.each([
    "gamerule keepInventory true",
    "difficulty hard",
    "worldborder set 1000",
    "setworldspawn 0 64 0",
    "scoreboard objectives add deaths deathCount",
    "datapack enable file/custom",
    "place structure minecraft:village_plains",
    "function custom:reset",
    "plugins reload",
    "minecraft:reload",
    "execute as @a run list",
    "execute as @a run function custom:reset",
    "execute run datapack disable file/custom",
    "customplugin:list",
  ])("fails closed to destructive for persistent, nested, or plugin console command %s", (command) => {
    const inspection = inspectMinecraftCommand(command);
    const item = invocation("console.execute", "console.execute", scope("console", "server"), { command });
    expect(inspection.destructive).toBe(true);
    expect(classifyRisk(item.capability, riskFacts(item, !inspection.readOnly))).toBe("destructive");
  });

  it.each(["help", "/help 2", "list", "seed", "version", "tps", "minecraft:list", "/minecraft:seed"])(
    "keeps explicit benign read-only console command %s low risk",
    (command) => {
      const inspection = inspectMinecraftCommand(command);
      const item = invocation("console.execute", "console.execute", scope("console", "server"), { command });
      expect(inspection).toMatchObject({ readOnly: true, destructive: false });
      expect(classifyRisk(item.capability, riskFacts(item, false))).toBe("low");
    }
  );

  it.each(["say maintenance soon", "tell player hello", "particle minecraft:cloud 0 64 0"])(
    "keeps narrowly allowed ephemeral command %s risky, not low",
    (command) => {
      const inspection = inspectMinecraftCommand(command);
      const item = invocation("console.execute", "console.execute", scope("console", "server"), { command });
      expect(inspection).toMatchObject({ readOnly: false, destructive: false });
      expect(classifyRisk(item.capability, riskFacts(item, true))).toBe("risky");
    }
  );

  it("backs up destructive console mutations and explains the exact approval", async () => {
    const effects = fakeEffects();
    const item = invocation("console.execute", "console.execute", scope("console", "server"), {
      command: "gamerule keepInventory true",
    });
    const approval = await approvalFor(item, "destructive");
    const output = await run(
      effects,
      item,
      { policy: policy("allow", "before-destructive"), approvals: [approval] },
      { consume: vi.fn().mockResolvedValue(true) }
    );
    expect(output.status, JSON.stringify(output)).toBe("succeeded");
    expect(effects.calls).toEqual(["backup", "console"]);
    expect((await createProposedInvocationSummary(item, "destructive")).diffSummary).toContain(
      "Destructive Minecraft console mutation"
    );
  });

  it.each([
    "op player",
    "/op player",
    "minecraft:deop player",
    "/minecraft:execute as @a run minecraft:op player",
    "execute as @a run execute at @s run luckperms user player permission set * true",
  ])("immutably denies normalized or nested permission administration %s", async (command) => {
    const effects = fakeEffects();
    const output = await run(
      effects,
      invocation("console.execute", "console.execute", scope("console", "server"), { command })
    );
    expect(output).toMatchObject({ status: "failed", output: { code: "immutable-boundary" } });
    expect(effects.calls).toEqual([]);
  });

  it("does not expose arbitrary host-effect errors", async () => {
    const secret = "host adapter leaked secret material";
    const effects = fakeEffects({
      readFile: async () => {
        throw new Error(secret);
      },
    });
    const output = await run(
      effects,
      invocation("workspace.read", "workspace.read", scope("workspace", "server.properties"), {
        path: "server.properties",
      })
    );
    expect(JSON.stringify(output)).not.toContain(secret);
    expect(output).toMatchObject({ status: "failed", summary: "Executor failed closed." });
  });

  it("propagates an indeterminate committed host effect so the protocol journal fences retries", async () => {
    const effects = fakeEffects({
      writeFile: async () => {
        effects.calls.push("write");
        throw new IndeterminateHostEffectError();
      },
    });
    await expect(
      executor(effects).execute({
        actorId: "operator-1",
        invocation: invocation("workspace.write", "workspace.write", scope("workspace", "new.txt"), {
          path: "new.txt",
          content: "safe",
        }),
        policy: policy("allow", "never"),
        approvals: [],
      })
    ).rejects.toBeInstanceOf(IndeterminateHostEffectError);
    expect(effects.calls).toEqual(["write"]);
  });

  it("honors cancellation before any executable host effect", async () => {
    const controller = new AbortController();
    controller.abort();
    const effects = fakeEffects();
    const output = await run(
      effects,
      invocation("workspace.read", "workspace.read", scope("workspace", "server.properties"), {
        path: "server.properties",
      }),
      { signal: controller.signal }
    );
    expect(output.status).toBe("cancelled");
    expect(effects.calls).toEqual([]);
  });

  it.each([
    [
      "workspace.write",
      "workspace.write",
      scope("workspace", "new.txt"),
      { path: "new.txt", content: "safe" },
      "writeFile",
    ],
    ["workspace.delete", "workspace.delete", scope("workspace", "old.txt"), { path: "old.txt" }, "deletePath"],
    [
      "network.download",
      "network.outbound",
      scope("workspace", "download.jar"),
      { url: "https://downloads.example.invalid/file.jar", destination: "download.jar" },
      "download",
    ],
  ] as const)(
    "returns cancelled for %s when cancellation wins immediately before its commit point",
    async (toolId, capability, targetScope, args, effectName) => {
      const controller = new AbortController();
      let committed = false;
      const cancelledAtCommit = vi.fn(async () => {
        controller.abort();
        if (controller.signal.aborted) throw new DOMException("Invocation cancelled", "AbortError");
        committed = true;
        return hostResult("unexpected");
      });
      const effects = fakeEffects({ [effectName]: cancelledAtCommit });
      const item = invocation(toolId, capability, targetScope, args as unknown as JsonObject);
      const approvals = capability === "workspace.delete" ? [await approvalFor(item, "destructive")] : [];
      const output = await run(
        effects,
        item,
        { signal: controller.signal, approvals },
        { consume: vi.fn().mockResolvedValue(true) }
      );

      expect(cancelledAtCommit).toHaveBeenCalledOnce();
      expect(committed).toBe(false);
      expect(output).toMatchObject({ status: "cancelled", output: { code: "cancelled" } });
    }
  );

  it.each([
    [
      "workspace.write",
      "workspace.write",
      scope("workspace", "new.txt"),
      { path: "new.txt", content: "safe" },
      "writeFile",
      "atomic-rename",
    ],
    [
      "workspace.delete",
      "workspace.delete",
      scope("workspace", "old.txt"),
      { path: "old.txt" },
      "deletePath",
      "atomic-rename",
    ],
    [
      "network.download",
      "network.outbound",
      scope("workspace", "download.jar"),
      { url: "https://downloads.example.invalid/file.jar", destination: "download.jar" },
      "download",
      "atomic-rename",
    ],
    [
      "console.execute",
      "console.execute",
      scope("console", "server"),
      { command: "list", timeoutMs: 1_000 },
      "executeConsole",
      "console-dispatch",
    ],
  ] as const)(
    "does not overwrite a committed %s mutation with a later cancellation",
    async (toolId, capability, targetScope, args, effectName, commitPoint) => {
      const controller = new AbortController();
      const committed = vi.fn(async () => {
        controller.abort();
        return {
          summary: "Mutation committed.",
          output: { committed: true, commitPoint },
          evidence: [evidence("diff")],
          mutationCommit: { committed: true as const, point: commitPoint },
        };
      });
      const effects = fakeEffects({ [effectName]: committed });
      const item = invocation(toolId, capability, targetScope, args as unknown as JsonObject);
      const approvals = capability === "workspace.delete" ? [await approvalFor(item, "destructive")] : [];
      const output = await run(
        effects,
        item,
        { signal: controller.signal, approvals },
        { consume: vi.fn().mockResolvedValue(true) }
      );

      expect(committed).toHaveBeenCalledOnce();
      expect(output).toMatchObject({
        status: "succeeded",
        summary: "Mutation committed.",
        output: { committed: true, commitPoint },
        mutationCommit: { committed: true, point: commitPoint },
      });
      expect(output.evidence).toHaveLength(1);
    }
  );
});

describe("direct-live executor allowed operations", () => {
  it.each([
    [
      "workspace.read",
      "workspace.read",
      scope("workspace", "server.properties"),
      { path: "server.properties" },
      "read",
    ],
    [
      "workspace.write",
      "workspace.write",
      scope("workspace", "new.txt"),
      { path: "new.txt", content: "hello" },
      "write",
    ],
    ["workspace.delete", "workspace.delete", scope("workspace", "old.txt"), { path: "old.txt" }, "delete"],
    [
      "shell.execute",
      "shell.execute",
      scope("workspace", "."),
      { mode: "read-only", command: "grep motd server.properties", timeoutMs: 1_000 },
      "shell",
    ],
    ["console.execute", "console.execute", scope("console", "server"), { command: "list" }, "console"],
    [
      "network.download",
      "network.outbound",
      scope("workspace", "download.jar"),
      { url: "https://example.invalid/plugin.jar", destination: "download.jar" },
      "download",
    ],
    ["backup.request", "backup.create", scope("workspace", "."), { label: "manual" }, "backup"],
    ["extension.load", "extension.load", scope("workspace", "extension.json"), { path: "extension.json" }, "extension"],
  ] as const)(
    "runs guarded %s and retains bounded evidence",
    async (toolId, capability, target, args, expectedCall) => {
      const effects = fakeEffects();
      const progress: number[] = [];
      const item = invocation(toolId, capability, target, args as unknown as JsonObject);
      const approvals = capability === "workspace.delete" ? [await approvalFor(item, "destructive")] : [];
      const output = await run(
        effects,
        item,
        {
          approvals,
          onProgress: (event) => {
            progress.push(event.sequence);
          },
        },
        { consume: vi.fn().mockResolvedValue(true) }
      );
      expect(output.status).toBe("succeeded");
      expect(output.evidence).toHaveLength(1);
      expect(effects.calls).toContain(expectedCall);
      expect(progress).toEqual(progress.map((_, index) => index + 1));
    }
  );
});
