import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeOwnedStaleUnixSocket } from "./unix-socket";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function socketPath(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-aws-stale-socket-"));
  roots.push(root);
  return path.join(root, "service.sock");
}

describe("owned stale Unix socket cleanup", () => {
  it("removes an owned stale socket left by a terminated process", async () => {
    const socket = await socketPath();
    const child = spawnSync(
      process.execPath,
      ["-e", "require('node:net').createServer().listen(process.argv[1], () => process.exit(0))", socket],
      { timeout: 5_000 }
    );
    expect(child.status).toBe(0);
    expect(existsSync(socket)).toBe(true);
    await removeOwnedStaleUnixSocket(socket);
    expect(existsSync(socket)).toBe(false);
  });

  it("refuses active sockets, regular files, and symlinks", async () => {
    const activePath = await socketPath();
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(activePath, resolve));
    await expect(removeOwnedStaleUnixSocket(activePath)).rejects.toThrow(/active Unix socket/);
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const regularPath = await socketPath();
    await writeFile(regularPath, "not a socket");
    await expect(removeOwnedStaleUnixSocket(regularPath)).rejects.toThrow(/non-socket/);

    const linkPath = await socketPath();
    await symlink(regularPath, linkPath);
    await expect(removeOwnedStaleUnixSocket(linkPath)).rejects.toThrow(/non-socket/);
  });
});
