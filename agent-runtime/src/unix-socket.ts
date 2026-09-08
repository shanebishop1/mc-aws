import { lstat, realpath, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";

async function assertSocketIsStale(socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Refusing to remove a Unix socket with unknown liveness."));
    }, 1_000);
    timer.unref();
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error("Refusing to remove an active Unix socket."));
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      socket.destroy();
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve();
      else reject(error);
    });
  });
}

/** Removes only a stale Unix socket owned by this process user in a non-symlink parent. */
export async function removeOwnedStaleUnixSocket(socketPath: string): Promise<void> {
  if (!path.isAbsolute(socketPath) || typeof process.getuid !== "function") {
    throw new Error("Unix socket cleanup requires an absolute Linux path.");
  }
  const parent = path.dirname(socketPath);
  if ((await realpath(parent)) !== parent) throw new Error("Unix socket parent must not be a symlink.");
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!metadata.isSocket() || metadata.isSymbolicLink() || metadata.uid !== process.getuid()) {
    throw new Error("Refusing to remove an unowned or non-socket Unix path.");
  }
  await assertSocketIsStale(socketPath);
  await unlink(socketPath);
}
