import { createHmac } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GetParameterCommand, PutParameterCommand } from "@aws-sdk/client-ssm";
import { afterEach, describe, expect, it } from "vitest";
import { adoptBackupRecoveryCapsule } from "./adopt-backup-recovery-capsule";

const directories: string[] = [];
const serverId = "arn:aws:cloudformation:us-west-1:111111111111:stack/MinecraftStack/stable-id";
const material = Buffer.alloc(32, 7).toString("base64");
const keyring = {
  schemaVersion: 1,
  currentKeyId: "key-old",
  keys: [{ keyId: "key-old", secretBase64: material, status: "active" }],
};

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, child) => {
    if (!child || typeof child !== "object" || Array.isArray(child)) return child;
    return Object.fromEntries(Object.entries(child).sort(([left], [right]) => left.localeCompare(right)));
  });

const state = (kind: "backup-generation" | "restore-floor", generation: number, backupId: string): string => {
  const payload = {
    format: "mc-aws-backup-state",
    schemaVersion: 3,
    source: { serverId },
    state: { backupId, generation, kind, updatedAt: "2026-09-04T00:00:00Z" },
  };
  const tag = createHmac("sha256", Buffer.alloc(32, 7)).update(canonical(payload)).digest("hex");
  return canonical({ ...payload, authentication: { algorithm: "HMAC-SHA256", keyId: "key-old", tag } });
};

const makeCapsule = (
  checkpoint = state("backup-generation", 7, "7".repeat(32)),
  floor = state("restore-floor", 5, "5".repeat(32))
) => {
  const payload = {
    checkpoint,
    format: "mc-aws-recovery-capsule",
    keyring,
    restoreFloor: floor,
    schemaVersion: 3,
    serverId,
    verifier: {
      algorithm: "HMAC-SHA256",
      keyIds: ["key-old"],
      manifestFormat: "mc-aws-drive-backup",
      manifestSchemaVersion: 3,
      stateFormat: "mc-aws-backup-state",
      stateSchemaVersion: 3,
    },
  };
  const tag = createHmac("sha256", Buffer.alloc(32, 7)).update(canonical(payload)).digest("hex");
  return { ...payload, authentication: { algorithm: "HMAC-SHA256", keyId: "key-old", tag } };
};

const harness = (initial: Record<string, { Type: string; Value: string }> = {}) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mc-recovery-adoption-"));
  directories.push(directory);
  const capsule = path.join(directory, "capsule.json");
  writeFileSync(capsule, `${canonical(makeCapsule())}\n`, { mode: 0o600 });
  chmodSync(capsule, 0o600);
  const values = new Map(Object.entries(initial));
  const versions = new Map([...values.keys()].map((name) => [name, 1]));
  const send = async (command: GetParameterCommand | PutParameterCommand) => {
    const name = command.input.Name!;
    if (command instanceof GetParameterCommand) {
      const value = values.get(name);
      if (!value) throw Object.assign(new Error("missing"), { name: "ParameterNotFound" });
      return { Parameter: { ...value, Version: versions.get(name) } };
    }
    if (command.input.Overwrite === false && values.has(name))
      throw Object.assign(new Error("exists"), { name: "ParameterAlreadyExists" });
    values.set(name, { Type: command.input.Type!, Value: command.input.Value! });
    versions.set(name, (versions.get(name) ?? 0) + 1);
    return {};
  };
  return {
    capsule,
    values,
    versions,
    send,
    acquireLock: async () => ({ lockId: "adoption-lock", fencingToken: 1, leaseGeneration: 1 }),
    releaseLock: async () => true,
  };
};

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("authenticated recovery capsule adoption", () => {
  it("imports the complete keyring and all authoritative recovery records", async () => {
    const test = harness();
    const result = await adoptBackupRecoveryCapsule(
      test.send,
      test.capsule,
      "111111111111",
      "us-west-1",
      "MinecraftStack",
      { acquireLock: test.acquireLock, releaseLock: test.releaseLock }
    );
    expect(result.split("\t").slice(0, 7)).toEqual([serverId, "7", "5", "7", "5", "key-old", expect.any(String)]);
    expect(test.values.get("/minecraft/backup-auth-keyring")?.Value).toBe(canonical(keyring));
    expect(test.values.get("/minecraft/backup-server-identity")?.Value).toBe(serverId);
    expect(test.values.get("/minecraft/backup-generation-checkpoint")?.Value).toBe(
      state("backup-generation", 7, "7".repeat(32))
    );
    expect(test.values.get("/minecraft/restore-generation-floor")?.Value).toBe(
      state("restore-floor", 5, "5".repeat(32))
    );
    expect(test.values.has("/minecraft/backup-verifier-metadata")).toBe(true);
    expect(readFileSync(test.capsule, "utf8")).not.toContain("Recovery capsule adoption failed");
  });

  it("claims a retained SSM lock before the lifecycle table exists and safely reruns the same capsule", async () => {
    const test = harness();
    const first = await adoptBackupRecoveryCapsule(
      test.send,
      test.capsule,
      "111111111111",
      "us-west-1",
      "MinecraftStack"
    );
    const second = await adoptBackupRecoveryCapsule(
      test.send,
      test.capsule,
      "111111111111",
      "us-west-1",
      "MinecraftStack"
    );
    expect(first.split("\t")[10]).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
    expect(test.values.has("/minecraft/backup-recovery-adoption-lock")).toBe(true);
  });

  it("fails a concurrent adoption for a different authenticated capsule", async () => {
    const test = harness();
    await adoptBackupRecoveryCapsule(test.send, test.capsule, "111111111111", "us-west-1", "MinecraftStack");
    const competingCapsule = path.join(path.dirname(test.capsule), "competing-capsule.json");
    writeFileSync(
      competingCapsule,
      `${canonical(makeCapsule(state("backup-generation", 8, "8".repeat(32)), state("restore-floor", 5, "5".repeat(32))))}\n`,
      { mode: 0o600 }
    );
    await expect(
      adoptBackupRecoveryCapsule(test.send, competingCapsule, "111111111111", "us-west-1", "MinecraftStack")
    ).rejects.toThrow("recovery adoption lock conflicts");
  });

  it("preserves a newer authenticated state instead of rolling it back", async () => {
    const checkpoint = state("backup-generation", 9, "9".repeat(32));
    const floor = state("restore-floor", 8, "8".repeat(32));
    const test = harness({
      "/minecraft/backup-generation-checkpoint": { Type: "String", Value: checkpoint },
      "/minecraft/restore-generation-floor": { Type: "String", Value: floor },
    });
    const result = await adoptBackupRecoveryCapsule(
      test.send,
      test.capsule,
      "111111111111",
      "us-west-1",
      "MinecraftStack",
      { acquireLock: test.acquireLock, releaseLock: test.releaseLock }
    );
    expect(result.split("\t").slice(3, 5)).toEqual(["9", "8"]);
    expect(test.values.get("/minecraft/backup-generation-checkpoint")?.Value).toBe(checkpoint);
    expect(test.values.get("/minecraft/restore-generation-floor")?.Value).toBe(floor);
  });

  it("advances the retained adoption lock to newer effective monotonic state and reruns exactly", async () => {
    const checkpoint = state("backup-generation", 9, "9".repeat(32));
    const floor = state("restore-floor", 8, "8".repeat(32));
    const test = harness({
      "/minecraft/backup-generation-checkpoint": { Type: "String", Value: checkpoint },
      "/minecraft/restore-generation-floor": { Type: "String", Value: floor },
    });

    const first = await adoptBackupRecoveryCapsule(
      test.send,
      test.capsule,
      "111111111111",
      "us-west-1",
      "MinecraftStack"
    );
    const retainedLock = JSON.parse(test.values.get("/minecraft/backup-recovery-adoption-lock")?.Value ?? "null");
    expect(retainedLock).toMatchObject({ checkpointGeneration: 9, floorGeneration: 8 });
    expect(first.split("\t").slice(3, 5)).toEqual(["9", "8"]);

    const second = await adoptBackupRecoveryCapsule(
      test.send,
      test.capsule,
      "111111111111",
      "us-west-1",
      "MinecraftStack"
    );
    expect(second).toBe(first);
  });

  it("never lowers retained effective checkpoint or floor expectations", async () => {
    const test = harness({
      "/minecraft/backup-generation-checkpoint": {
        Type: "String",
        Value: state("backup-generation", 9, "9".repeat(32)),
      },
      "/minecraft/restore-generation-floor": { Type: "String", Value: state("restore-floor", 8, "8".repeat(32)) },
    });
    await adoptBackupRecoveryCapsule(test.send, test.capsule, "111111111111", "us-west-1", "MinecraftStack");
    test.values.set("/minecraft/backup-generation-checkpoint", {
      Type: "String",
      Value: state("backup-generation", 8, "8".repeat(32)),
    });
    test.values.set("/minecraft/restore-generation-floor", {
      Type: "String",
      Value: state("restore-floor", 7, "7".repeat(32)),
    });

    await expect(
      adoptBackupRecoveryCapsule(test.send, test.capsule, "111111111111", "us-west-1", "MinecraftStack")
    ).rejects.toThrow("behind the retained monotonic adoption lock");
    expect(JSON.parse(test.values.get("/minecraft/backup-recovery-adoption-lock")?.Value ?? "null")).toMatchObject({
      checkpointGeneration: 9,
      floorGeneration: 8,
    });
  });

  it("adopts the UNINITIALIZED verifier sentinel but rejects a real conflicting verifier", async () => {
    const sentinel = harness({ "/minecraft/backup-verifier-metadata": { Type: "String", Value: "UNINITIALIZED" } });
    await adoptBackupRecoveryCapsule(sentinel.send, sentinel.capsule, "111111111111", "us-west-1", "MinecraftStack", {
      acquireLock: sentinel.acquireLock,
      releaseLock: sentinel.releaseLock,
    });
    expect(sentinel.values.get("/minecraft/backup-verifier-metadata")?.Value).not.toBe("UNINITIALIZED");

    const conflict = harness({ "/minecraft/backup-verifier-metadata": { Type: "String", Value: "real-verifier" } });
    await expect(
      adoptBackupRecoveryCapsule(conflict.send, conflict.capsule, "111111111111", "us-west-1", "MinecraftStack", {
        acquireLock: conflict.acquireLock,
        releaseLock: conflict.releaseLock,
      })
    ).rejects.toThrow("existing verifier metadata");
  });

  it.each(["wrong account", "tampered capsule", "schema mismatch"])("rejects %s before any SSM write", async (kind) => {
    const test = harness();
    if (kind === "tampered capsule")
      writeFileSync(
        test.capsule,
        `${canonical({ ...makeCapsule(), serverId: "arn:aws:cloudformation:us-west-1:222222222222:stack/MinecraftStack/stable-id" })}\n`
      );
    if (kind === "schema mismatch")
      writeFileSync(test.capsule, `${canonical({ ...makeCapsule(), schemaVersion: 2 })}\n`);
    await expect(
      adoptBackupRecoveryCapsule(
        test.send,
        test.capsule,
        kind === "wrong account" ? "222222222222" : "111111111111",
        "us-west-1",
        "MinecraftStack",
        { acquireLock: test.acquireLock, releaseLock: test.releaseLock }
      )
    ).rejects.toThrow();
    expect(test.values.size).toBe(0);
  });

  it("rolls back newly-created records after a partial SSM failure", async () => {
    const test = harness();
    let puts = 0;
    const send = async (command: GetParameterCommand | PutParameterCommand) => {
      if (command instanceof GetParameterCommand) return test.send(command);
      puts += 1;
      if (puts === 3) throw new Error("simulated partial failure");
      return test.send(command);
    };
    await expect(
      adoptBackupRecoveryCapsule(send, test.capsule, "111111111111", "us-west-1", "MinecraftStack", {
        acquireLock: test.acquireLock,
        releaseLock: test.releaseLock,
      })
    ).rejects.toThrow(/rolled back/);
    expect(test.values.size).toBe(2);
  });

  it("releases the migration lock when the secondary adoption lock cannot be acquired", async () => {
    const test = harness();
    let released = false;
    await expect(
      adoptBackupRecoveryCapsule(test.send, test.capsule, "111111111111", "us-west-1", "MinecraftStack", {
        acquireMigrationLock: async () => ({ lockId: "migration", fencingToken: 1, value: "migration" }),
        releaseMigrationLock: async () => {
          released = true;
          return true;
        },
        acquireLock: async () => {
          throw new Error("secondary lock unavailable");
        },
      })
    ).rejects.toThrow("secondary lock unavailable");
    expect(released).toBe(true);
  });

  it("preserves a concurrent N-to-N+1 backup and retries adoption from the monotonic maximum", async () => {
    const test = harness();
    let advanced = false;
    const send = async (command: GetParameterCommand | PutParameterCommand) => {
      const result = await test.send(command);
      if (
        command instanceof PutParameterCommand &&
        command.input.Name === "/minecraft/backup-generation-checkpoint" &&
        !advanced
      ) {
        advanced = true;
        await test.send(
          new PutParameterCommand({
            Name: "/minecraft/backup-generation-checkpoint",
            Type: "String",
            Value: state("backup-generation", 8, "8".repeat(32)),
            Overwrite: true,
          })
        );
      }
      return result;
    };
    const result = await adoptBackupRecoveryCapsule(send, test.capsule, "111111111111", "us-west-1", "MinecraftStack", {
      acquireLock: test.acquireLock,
      releaseLock: test.releaseLock,
    });
    expect(result.split("\t").slice(3, 5)).toEqual(["8", "5"]);
    expect(test.values.get("/minecraft/backup-generation-checkpoint")?.Value).toBe(
      state("backup-generation", 8, "8".repeat(32))
    );
  });

  it.each([1, 2, 3, 4, 5])("rolls back safely when write %s fails", async (failureWrite) => {
    const test = harness();
    let writes = 0;
    const send = async (command: GetParameterCommand | PutParameterCommand) => {
      if (command instanceof PutParameterCommand) {
        writes += 1;
        if (command instanceof PutParameterCommand && writes === failureWrite) throw new Error("write failed");
      }
      return test.send(command);
    };
    await expect(
      adoptBackupRecoveryCapsule(send, test.capsule, "111111111111", "us-west-1", "MinecraftStack", {
        acquireLock: test.acquireLock,
        releaseLock: test.releaseLock,
      })
    ).rejects.toThrow();
    expect(test.values.size).toBe(failureWrite - 1);
  });

  it("never rolls back a parameter changed by a later writer", async () => {
    const test = harness();
    const concurrentKeyring = canonical({
      ...keyring,
      currentKeyId: "key-new",
      keys: [{ keyId: "key-new", secretBase64: Buffer.alloc(32, 8).toString("base64"), status: "active" }],
    });
    let failed = false;
    const send = async (command: GetParameterCommand | PutParameterCommand) => {
      if (
        command instanceof PutParameterCommand &&
        command.input.Name === "/minecraft/backup-auth-keyring" &&
        !failed
      ) {
        await test.send(command);
        test.values.set("/minecraft/backup-auth-keyring", { Type: "SecureString", Value: concurrentKeyring });
        test.versions.set("/minecraft/backup-auth-keyring", 99);
        failed = true;
        throw new Error("failure after concurrent replacement");
      }
      return test.send(command);
    };
    await expect(
      adoptBackupRecoveryCapsule(send, test.capsule, "111111111111", "us-west-1", "MinecraftStack", {
        acquireLock: test.acquireLock,
        releaseLock: test.releaseLock,
      })
    ).rejects.toThrow();
    expect(test.values.get("/minecraft/backup-auth-keyring")?.Value).toBe(concurrentKeyring);
  });

  it("does not touch SSM when the global migration lock conflicts", async () => {
    const test = harness();
    const acquireLock = async () => {
      throw new Error("lock conflict");
    };
    await expect(
      adoptBackupRecoveryCapsule(sendWithCount(test), test.capsule, "111111111111", "us-west-1", "MinecraftStack", {
        acquireLock,
        releaseLock: test.releaseLock,
      })
    ).rejects.toThrow("lock conflict");
    expect(test.values.size).toBe(0);
  });
});

function sendWithCount(test: ReturnType<typeof harness>) {
  return async (command: GetParameterCommand | PutParameterCommand) => test.send(command);
}
