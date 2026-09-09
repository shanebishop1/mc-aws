import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { UnixShellRunnerClient } from "./shell-client";
import { createShellRunnerServer } from "./shell-runner-server";

describe("shell runner socket framing", () => {
  it("keeps the request writable side open until the delayed response is framed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mc-shell-client-"));
    const socketPath = path.join(root, "runner.sock");
    const output = "delayed response";
    const server = createShellRunnerServer({
      mode: "read-only",
      shellPath: "/bin/sh",
      run: async (_shellPath, request, signal) => {
        expect(signal.aborted).toBe(false);
        expect(request.command).toBe("printf test");
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          schemaVersion: 1,
          exitCode: 0,
          output,
          outputBytes: Buffer.byteLength(output),
          outputSha256: createHash("sha256").update(output).digest("hex"),
          truncated: false,
        };
      },
    });
    try {
      await server.listen({ path: socketPath });
      const client = new UnixShellRunnerClient(socketPath, { allowNonProductionSocketPath: true });
      await expect(
        client.execute(
          { mode: "read-only", command: "printf test", timeoutMs: 1_000, maxOutputBytes: 1024 },
          new AbortController().signal
        )
      ).resolves.toMatchObject({ output });
      await server.completion;
    } finally {
      await server.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a second request because the service is one-request-lived", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mc-shell-client-"));
    const socketPath = path.join(root, "runner.sock");
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const server = createShellRunnerServer({
      mode: "read-only",
      shellPath: "/bin/sh",
      run: async () => {
        startedResolve();
        await new Promise((resolve) => setTimeout(resolve, 40));
        return {
          schemaVersion: 1,
          exitCode: 0,
          output: "ok",
          outputBytes: 2,
          outputSha256: createHash("sha256").update("ok").digest("hex"),
          truncated: false,
        };
      },
    });
    try {
      await server.listen({ path: socketPath });
      const first = new UnixShellRunnerClient(socketPath, { allowNonProductionSocketPath: true }).execute(
        { mode: "read-only", command: ":", timeoutMs: 1_000, maxOutputBytes: 1024 },
        new AbortController().signal
      );
      await started;
      await new Promise<void>((resolve) => {
        const socket = connect(socketPath, () => {
          socket.write(
            '{"schemaVersion":1,"requestId":"second","mode":"read-only","command":":","timeoutMs":1000,"maxOutputBytes":1024}\n'
          );
        });
        socket.once("close", () => resolve());
        socket.once("error", () => resolve());
      });
      await expect(first).resolves.toMatchObject({ output: "ok" });
      await server.completion;
    } finally {
      await server.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
