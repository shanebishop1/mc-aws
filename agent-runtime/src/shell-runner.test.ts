import { type ChildProcess, spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ChildExecutionResult,
  type ChildSpawn,
  type ChildSpawnOptions,
  type ProcessStateReader,
  assertInaccessible,
  assertStagedChangesMount,
  classifyRunMount,
  createChildSpawn,
  runShellCommand,
} from "./shell-runner";

/** Explicit local test context: this is subprocess behavior, not an OS sandbox qualification. */
const localSpawn: ChildSpawn = async (
  shellPath: string,
  command: string,
  options: ChildSpawnOptions
): Promise<ChildExecutionResult> =>
  await new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(shellPath, ["-c", command], {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv,
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    const kill = (): void => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const abort = (): void => {
      kill();
      if (!settled) reject(new DOMException("test child cancelled", "AbortError"));
    };
    const finish = (error?: Error, code = -1): void => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve({ exitCode: code, cleanupVerified: true });
    };
    child.stdout?.on("data", options.onOutput);
    child.stderr?.on("data", options.onOutput);
    child.once("error", (error) => finish(error));
    child.once("close", (code) => finish(undefined, code ?? -1));
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
  });

function disappearingDescendantReader(): ProcessStateReader {
  const snapshots = [[process.pid], [process.pid, 99999], [process.pid]];
  let snapshotIndex = 0;
  return {
    cgroupPath: async () => "/test/cgroup.procs",
    cgroupPids: async () => snapshots[Math.min(snapshotIndex++, snapshots.length - 1)] ?? [],
    processStartTime: async (pid) => {
      if (pid === process.pid) return "runner-start";
      const error = new Error("process exited before stat");
      Object.assign(error, { code: "ENOENT" });
      throw error;
    },
  };
}

function permissionFailureReader(): ProcessStateReader {
  let baseline = true;
  return {
    cgroupPath: async () => "/test/cgroup.procs",
    cgroupPids: async () => {
      if (baseline) {
        baseline = false;
        return [process.pid];
      }
      const error = new Error("permission denied reading cgroup membership");
      Object.assign(error, { code: "EACCES" });
      throw error;
    },
    processStartTime: async () => "runner-start",
  };
}

describe("shell runner", () => {
  const stagedChangesMount = (
    options: string,
    filesystem = "tmpfs",
    superOptions = "rw,size=8192k,mode=700,uid=995,gid=995,inode64"
  ): string => `42 35 0:39 / /changes ${options} - ${filesystem} tmpfs ${superOptions}\n`;

  it("accepts staged tmpfs VFS restrictions from the per-mount options field", () => {
    expect(() => assertStagedChangesMount(stagedChangesMount("rw,nosuid,nodev,noexec,relatime"))).not.toThrow();
  });

  it.each(["rw", "nosuid", "nodev", "noexec"])(
    "rejects a staged tmpfs missing the %s per-mount option even if super options contain it",
    (missing) => {
      const options = ["rw", "nosuid", "nodev", "noexec", "relatime"].filter((option) => option !== missing);
      expect(() =>
        assertStagedChangesMount(stagedChangesMount(options.join(","), "tmpfs", "rw,nosuid,nodev,noexec,size=8192k"))
      ).toThrow("Shell runner changes mount is unsafe.");
    }
  );

  it("rejects a non-tmpfs staged changes mount", () => {
    expect(() => assertStagedChangesMount(stagedChangesMount("rw,nosuid,nodev,noexec,relatime", "ext4"))).toThrow(
      "Shell runner changes mount is unsafe."
    );
  });

  it("classifies /run mount identity and VFS flags without retaining raw metadata", () => {
    const runMount = (root: string, options: string, filesystem = "tmpfs", id = "42", point = "/run"): string =>
      `${id} 35 0:39 ${root} ${point} ${options} - ${filesystem} private-source rw,size=4096k,mode=755\n`;

    const stackedMounts =
      runMount("/", "rw,nosuid,nodev", "tmpfs", "41") + runMount("/systemd/inaccessible/dir", "ro,nosuid,nodev,noexec");
    expect(classifyRunMount(stackedMounts, "42")).toEqual({
      root: "systemd-inaccessible",
      filesystem: "tmpfs",
      access: "ro",
      suid: "nosuid",
      devices: "nodev",
      execution: "noexec",
    });
    expect(classifyRunMount(runMount("/", "rw,nosuid,nodev", "tmpfs"), "42")).toEqual({
      root: "filesystem-root",
      filesystem: "tmpfs",
      access: "rw",
      suid: "nosuid",
      devices: "nodev",
      execution: "exec",
    });
    expect(classifyRunMount(runMount("/host-private-path", "rw", "ext4"), "42")).toEqual({
      root: "other",
      filesystem: "other",
      access: "rw",
      suid: "suid",
      devices: "dev",
      execution: "exec",
    });
    expect(classifyRunMount("", "42")).toEqual({
      root: "missing",
      filesystem: "unknown",
      access: "unknown",
      suid: "unknown",
      devices: "unknown",
      execution: "unknown",
    });
    expect(classifyRunMount("42 malformed\n", "42")).toEqual({
      root: "malformed",
      filesystem: "unknown",
      access: "unknown",
      suid: "unknown",
      devices: "unknown",
      execution: "unknown",
    });
    expect(classifyRunMount(runMount("/", "ro,nosuid,nodev,noexec", "tmpfs", "42", "/"), "42").root).toBe(
      "not-mountpoint"
    );
    expect(classifyRunMount(runMount("/", "rw,nosuid,nodev"))).toEqual({
      root: "unresolved",
      filesystem: "unknown",
      access: "unknown",
      suid: "unknown",
      devices: "unknown",
      execution: "unknown",
    });
  });

  it("tests path access rather than mount-point metadata for systemd inaccessible paths", async () => {
    for (const code of ["EACCES", "ENOENT"]) {
      const denied = new Error("path unavailable");
      Object.assign(denied, { code });
      await expect(
        assertInaccessible("/masked", async () => {
          throw denied;
        })
      ).resolves.toBeUndefined();
    }

    const symlink = new Error("symbolic link rejected");
    Object.assign(symlink, { code: "ELOOP" });
    await expect(
      assertInaccessible("/masked", async () => {
        throw symlink;
      })
    ).rejects.toMatchObject({ code: "ELOOP" });

    let closed = false;
    let openFlags = 0;
    await expect(
      assertInaccessible("/exposed", async (_value, flags) => {
        openFlags = flags;
        return {
          close: async () => {
            closed = true;
          },
        };
      })
    ).rejects.toThrow("Runner namespace exposes /exposed.");
    expect(closed).toBe(true);
    expect(openFlags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
  });

  it("reconciles a descendant that exits between cgroup membership and identity reads", async () => {
    const response = await runShellCommand(
      "/bin/sh",
      { mode: "read-only", command: ":", timeoutMs: 1_000, maxOutputBytes: 1024 },
      createChildSpawn(disappearingDescendantReader()),
      "/changes",
      undefined,
      { workspaceRoot: process.cwd(), changesRoot: "/changes" }
    );
    expect(response).toMatchObject({ exitCode: 0 });
  });

  it("rejects cleanup when cgroup I/O loses permission instead of leaving execution pending", async () => {
    await expect(
      runShellCommand(
        "/bin/sh",
        { mode: "read-only", command: ":", timeoutMs: 1_000, maxOutputBytes: 1024 },
        createChildSpawn(permissionFailureReader()),
        "/changes",
        undefined,
        { workspaceRoot: process.cwd(), changesRoot: "/changes" }
      )
    ).rejects.toMatchObject({ code: "EACCES" });
  });

  it("runs a real local POSIX composition while stripping transport fields before contract parsing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mc-shell-runner-"));
    try {
      const workspace = path.join(root, "workspace");
      const changes = path.join(root, "changes");
      await Promise.all([mkdir(workspace), mkdir(changes)]);
      const response = await runShellCommand(
        "/bin/sh",
        { mode: "read-only", command: "printf 'left'; printf 'right' >&2", timeoutMs: 1_000, maxOutputBytes: 1024 },
        localSpawn,
        changes,
        undefined,
        { workspaceRoot: workspace, changesRoot: changes }
      );
      expect(response.exitCode).toBe(0);
      expect(response.output).toBe("leftright");
      expect(response.outputBytes).toBe(9);
      expect(response.truncated).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns only a validated replacement stage and does not require one for staged deletion", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mc-shell-runner-"));
    try {
      const workspace = path.join(root, "workspace");
      const changes = path.join(root, "changes");
      await Promise.all([mkdir(workspace), mkdir(changes)]);
      const replacement = await runShellCommand(
        "/bin/sh",
        {
          mode: "staged-write",
          command: "printf 'updated' > \"$TMPDIR/result\"",
          timeoutMs: 1_000,
          maxOutputBytes: 1024,
          change: { operation: "replace", path: "status.txt" },
        },
        localSpawn,
        changes,
        undefined,
        { workspaceRoot: workspace, changesRoot: changes }
      );
      expect(await readFile(path.join(changes, "result"), "utf8")).toBe("updated");
      expect(replacement.stagedResult?.bytes).toEqual(Buffer.from("updated"));

      const deletion = await runShellCommand(
        "/bin/sh",
        {
          mode: "staged-write",
          command: ":",
          timeoutMs: 1_000,
          maxOutputBytes: 1024,
          change: { operation: "delete", path: "status.txt" },
        },
        localSpawn,
        changes,
        undefined,
        { workspaceRoot: workspace, changesRoot: changes }
      );
      expect(deletion.stagedResult).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an executable staged result", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mc-shell-runner-"));
    try {
      const workspace = path.join(root, "workspace");
      const changes = path.join(root, "changes");
      await Promise.all([mkdir(workspace), mkdir(changes)]);
      await expect(
        runShellCommand(
          "/bin/sh",
          {
            mode: "staged-write",
            command: 'printf updated > "$TMPDIR/result"; /usr/bin/chmod +x "$TMPDIR/result"',
            timeoutMs: 1_000,
            maxOutputBytes: 1024,
            change: { operation: "replace", path: "status.txt" },
          },
          localSpawn,
          changes,
          undefined,
          { workspaceRoot: workspace, changesRoot: changes }
        )
      ).rejects.toThrow("Shell staged result is not a bounded regular file.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops a byte flood instead of retaining output with quadratic accounting", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mc-shell-runner-"));
    try {
      const workspace = path.join(root, "workspace");
      const changes = path.join(root, "changes");
      await Promise.all([mkdir(workspace), mkdir(changes)]);
      await expect(
        runShellCommand(
          "/bin/sh",
          {
            mode: "read-only",
            command: "i=0; while [ $i -lt 100000 ]; do printf x; i=$((i+1)); done",
            timeoutMs: 1_000,
            maxOutputBytes: 1024,
          },
          localSpawn,
          changes,
          undefined,
          { workspaceRoot: workspace, changesRoot: changes }
        )
      ).rejects.toThrow("Shell output exceeded its bound.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
