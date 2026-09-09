import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IndeterminateHostEffectError } from "../../lib/agent/executor/types";
import {
  HostBrokerClient,
  canonicalizeDescriptorConfinedPath,
  classifyDescriptorDeletionPath,
  commitAtomicRename,
  dispatchMinecraftConsole,
  ensureOwnedSessionDirectory,
  validateDescriptorConfinedDeletion,
} from "./live-host-effects";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratchRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-agent-session-scratch-"));
  roots.push(root);
  return root;
}

describe("production session scratch setup", () => {
  it("is idempotent only for the same owned confined mode-0700 directory", async () => {
    const root = await scratchRoot();
    await ensureOwnedSessionDirectory(root, "session-safe");
    await expect(ensureOwnedSessionDirectory(root, "session-safe")).resolves.toBeUndefined();
  });

  it("rejects an existing directory with a permissive mode", async () => {
    const root = await scratchRoot();
    const candidate = path.join(root, "session-permissive");
    await mkdir(candidate, { mode: 0o700 });
    await chmod(candidate, 0o750);
    await expect(ensureOwnedSessionDirectory(root, "session-permissive")).rejects.toThrow(
      /ownership, mode, or confinement/
    );
  });

  it("rejects an EEXIST symlink instead of following it", async () => {
    const root = await scratchRoot();
    const outside = await scratchRoot();
    await symlink(outside, path.join(root, "session-link"));
    await expect(ensureOwnedSessionDirectory(root, "session-link")).rejects.toThrow();
  });
});

describe("production descriptor path canonicalization", () => {
  it("accepts configured roots themselves and descriptor-verifies confined descendants", async () => {
    const workspace = await scratchRoot();
    const scratch = await scratchRoot();
    await mkdir(path.join(workspace, "plugins"));
    await writeFile(path.join(workspace, "plugins", "safe.jar"), "safe");

    await expect(canonicalizeDescriptorConfinedPath(workspace, [workspace, scratch])).resolves.toEqual({
      path: workspace,
      kind: "directory",
    });
    await expect(canonicalizeDescriptorConfinedPath(scratch, [workspace, scratch])).resolves.toEqual({
      path: scratch,
      kind: "directory",
    });
    await expect(
      canonicalizeDescriptorConfinedPath(path.join(workspace, "plugins", "safe.jar"), [workspace, scratch])
    ).resolves.toEqual({ path: path.join(workspace, "plugins", "safe.jar"), kind: "file" });
    await expect(
      canonicalizeDescriptorConfinedPath(path.join(workspace, "plugins", "missing.jar"), [workspace, scratch])
    ).resolves.toEqual({ path: path.join(workspace, "plugins", "missing.jar"), kind: "missing" });
  });

  it("keeps descendants confined when a component is a symlink or outside every configured root", async () => {
    const workspace = await scratchRoot();
    const scratch = await scratchRoot();
    const outside = await scratchRoot();
    await symlink(outside, path.join(workspace, "escape"));

    await expect(
      canonicalizeDescriptorConfinedPath(path.join(workspace, "escape", "secret"), [workspace, scratch])
    ).rejects.toThrow();
    await expect(
      canonicalizeDescriptorConfinedPath(path.join(outside, "secret"), [workspace, scratch])
    ).rejects.toThrow(/outside configured roots/);
  });
});

describe("descriptor-confined recursive deletion preflight", () => {
  it("classifies every protected descendant and rejects before any deletion", async () => {
    const workspace = await scratchRoot();
    const scratch = await scratchRoot();
    const target = path.join(workspace, "plugins");
    await mkdir(path.join(target, "nested"), { recursive: true });
    await writeFile(path.join(target, "nested", "Example.jar"), "immutable");
    await writeFile(path.join(target, "safe.txt"), "must remain");

    await expect(
      validateDescriptorConfinedDeletion(target, [workspace, scratch], new AbortController().signal, workspace)
    ).rejects.toThrow(/immutable asset/);
    await expect(readFile(path.join(target, "safe.txt"), "utf8")).resolves.toBe("must remain");
    await expect(readFile(path.join(target, "nested", "Example.jar"), "utf8")).resolves.toBe("immutable");
  });

  it("does not promote canonical protected names from lookalike paths", async () => {
    const workspace = await scratchRoot();
    const scratch = await scratchRoot();
    const target = path.join(workspace, "profiled");
    await mkdir(target);
    await writeFile(path.join(target, "launcher"), "ordinary");

    expect(classifyDescriptorDeletionPath(path.join(workspace, "profiled", "launcher"), workspace)).toBe("mutable");
    await expect(
      validateDescriptorConfinedDeletion(target, [workspace, scratch], new AbortController().signal, workspace)
    ).resolves.toBeUndefined();
  });

  it("rejects a symlink swap and leaves the outside sentinel untouched", async () => {
    const workspace = await scratchRoot();
    const scratch = await scratchRoot();
    const outside = await scratchRoot();
    const target = path.join(workspace, "delete-me");
    await mkdir(target);
    await writeFile(path.join(outside, "sentinel"), "outside");
    await symlink(outside, path.join(target, "swapped"));

    await expect(
      validateDescriptorConfinedDeletion(target, [workspace, scratch], new AbortController().signal, workspace)
    ).rejects.toThrow(/unsafe|symlink/i);
    await expect(readFile(path.join(outside, "sentinel"), "utf8")).resolves.toBe("outside");
  });
});

describe("atomic mutation cancellation commit point", () => {
  it("cancels immediately before rename without committing", async () => {
    const root = await scratchRoot();
    const source = path.join(root, "temporary");
    const destination = path.join(root, "target");
    await writeFile(source, "new");
    await writeFile(destination, "old");
    const controller = new AbortController();

    await expect(
      commitAtomicRename(source, destination, controller.signal, {
        beforeCommit: () => controller.abort(),
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(readFile(destination, "utf8")).resolves.toBe("old");
  });

  it("returns a committed result when cancellation arrives after rename", async () => {
    const root = await scratchRoot();
    const source = path.join(root, "temporary");
    const destination = path.join(root, "target");
    await writeFile(source, "new");
    await writeFile(destination, "old");
    const controller = new AbortController();

    await expect(
      commitAtomicRename(source, destination, controller.signal, {
        afterCommit: () => controller.abort(),
      })
    ).resolves.toEqual({ committed: true, point: "atomic-rename" });
    expect(controller.signal.aborted).toBe(true);
    await expect(readFile(destination, "utf8")).resolves.toBe("new");
  });

  it("prevents a hung pre-commit filesystem operation from committing after its renewable fence is lost", async () => {
    const root = await scratchRoot();
    const source = path.join(root, "temporary-hung");
    const destination = path.join(root, "target-hung");
    await writeFile(source, "new");
    await writeFile(destination, "old");
    let resume: (() => void) | undefined;
    const hung = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let fenceOwned = true;
    const operation = commitAtomicRename(source, destination, new AbortController().signal, {
      beforeCommit: async () => await hung,
      assertFenceOwned: async () => {
        if (!fenceOwned) throw new Error("lease generation is no longer owned");
      },
    });

    // Deterministically model a syscall/preparation stall beyond every prior timer horizon.
    fenceOwned = false;
    resume?.();
    await expect(operation).rejects.toThrow(/lease generation/i);
    await expect(readFile(destination, "utf8")).resolves.toBe("old");
  });
});

describe("Minecraft console dispatch commit point", () => {
  it("cancels before dispatch without invoking the screen transport", async () => {
    const controller = new AbortController();
    let deliveries = 0;

    await expect(
      dispatchMinecraftConsole(
        "list",
        1_000,
        controller.signal,
        async () => {
          deliveries++;
          return { summary: "unexpected", output: { exitCode: 0 }, evidence: [] };
        },
        { beforeDispatch: () => controller.abort() }
      )
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(deliveries).toBe(0);
  });

  it("reports successful dispatch as committed even when cancellation arrives after delivery starts", async () => {
    const controller = new AbortController();
    const result = await dispatchMinecraftConsole("list", 1_000, controller.signal, async (request) => {
      expect(request.executable).toBe("/usr/bin/screen");
      expect(request.args.at(-1)).toBe("list\r");
      controller.abort();
      return { summary: "screen accepted", output: { exitCode: 0 }, evidence: [] };
    });

    expect(result).toMatchObject({
      output: { accepted: true, committed: true, commitPoint: "console-dispatch" },
      mutationCommit: { committed: true, point: "console-dispatch" },
    });
  });

  it.each(["timeout", "socket loss"])("reports %s after dispatch begins as indeterminate", async (message) => {
    await expect(
      dispatchMinecraftConsole("list", 1_000, new AbortController().signal, async () => {
        throw new Error(message);
      })
    ).rejects.toMatchObject({
      name: "IndeterminateHostEffectError",
      point: "console-dispatch",
    } satisfies Partial<IndeterminateHostEffectError>);
  });
});

describe("authenticated host broker effect truth", () => {
  async function brokerResponse(response?: Record<string, unknown>, holdOpen = false) {
    const root = await scratchRoot();
    const socketPath = path.join(root, "broker.sock");
    const server = createServer((socket) => {
      socket.once("data", () => {
        if (response) socket.end(`${JSON.stringify(response)}\n`);
        else if (!holdOpen) socket.destroy();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    return {
      client: new HostBrokerClient(Buffer.alloc(32, 3), socketPath, 50),
      close: async () => await new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  const request = {
    schemaVersion: 1 as const,
    operation: "console.execute" as const,
    invocation: {
      schemaVersion: 1 as const,
      runtimeId: "runtime-1",
      leaseId: "lease-1",
      leaseGeneration: 1,
      taskId: "task-1",
      sessionId: "session-1",
      invocationId: "invocation-1",
      invocationDigest: "a".repeat(64),
    },
    command: "minecraft:list",
    timeoutMs: 1_000,
  };

  it("preserves an authenticated pre-entry rejection as proven no-effect", async () => {
    const fixture = await brokerResponse({
      schemaVersion: 1,
      ok: false,
      effectState: "not-entered",
      verification: "not-required",
      error: "authority rejected",
      output: {},
    });
    await expect(fixture.client.execute(request, new AbortController().signal)).rejects.toMatchObject({
      name: "Error",
      message: "Host broker rejected the request before effect entry.",
    });
    await fixture.close();
  });

  it.each([
    [
      "committed response with unresolved verification",
      {
        schemaVersion: 1,
        ok: false,
        effectState: "committed",
        verification: "unresolved",
        output: {},
      },
    ],
    [
      "explicit unknown response",
      {
        schemaVersion: 1,
        ok: false,
        effectState: "unknown",
        verification: "unresolved",
        output: {},
      },
    ],
  ])("maps %s to indeterminate instead of false failure", async (_name, response) => {
    const fixture = await brokerResponse(response);
    await expect(fixture.client.execute(request, new AbortController().signal)).rejects.toMatchObject({
      name: "IndeterminateHostEffectError",
      point: "console-dispatch",
    });
    await fixture.close();
  });

  it("treats response loss or timeout after request delivery as indeterminate", async () => {
    const lost = await brokerResponse();
    await expect(lost.client.execute(request, new AbortController().signal)).rejects.toMatchObject({
      name: "IndeterminateHostEffectError",
    });
    await lost.close();

    const timedOut = await brokerResponse(undefined, true);
    await expect(timedOut.client.execute(request, new AbortController().signal)).rejects.toMatchObject({
      name: "IndeterminateHostEffectError",
    });
    await timedOut.close();
  });
});
