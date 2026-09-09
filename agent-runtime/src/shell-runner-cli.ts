#!/usr/bin/env node
import { systemdSocketActivationFd } from "./protocol";
import { assertShellRunnerSandbox } from "./shell-runner";
import { createShellRunnerServer } from "./shell-runner-server";
import { loadReviewedShellToolchain } from "./shell-toolchain";

const mode =
  process.argv.length === 3 && (process.argv[2] === "--read-only" || process.argv[2] === "--staged-write")
    ? (process.argv[2].slice(2) as "read-only" | "staged-write")
    : undefined;

async function main(): Promise<void> {
  if (!mode) throw new Error("Shell runner mode is fixed by its service unit.");
  await assertShellRunnerSandbox(mode);
  const toolchain = await loadReviewedShellToolchain();
  const shellPath = toolchain.executables[0].path;
  const runner = createShellRunnerServer({ mode, shellPath });
  const fd = systemdSocketActivationFd(mode === "read-only" ? "shell-read" : "shell-write");
  await runner.listen({ fd });
  process.once("SIGTERM", () => void runner.stop());
  process.once("SIGINT", () => void runner.stop());
  await runner.completion;
}

main().catch(() => {
  process.stderr.write("mc-agent shell runner unavailable.\n");
  process.exitCode = 1;
});
