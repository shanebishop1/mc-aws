#!/usr/bin/env node
import { systemdSocketActivationFd } from "./protocol";
import { assertShellRunnerSandbox } from "./shell-runner";
import { createShellRunnerServer } from "./shell-runner-server";
import {
  type ShellRunnerRunMountDiagnostic,
  type ShellRunnerSandboxPhase,
  type ShellRunnerStartupPhase,
  shellRunnerSafeErrno,
  shellRunnerUnavailableMessage,
} from "./shell-runner-startup";
import { loadReviewedShellToolchain } from "./shell-toolchain";

const mode =
  process.argv.length === 3 && (process.argv[2] === "--read-only" || process.argv[2] === "--staged-write")
    ? (process.argv[2].slice(2) as "read-only" | "staged-write")
    : undefined;
let startupPhase: ShellRunnerStartupPhase = "mode-validation";
let sandboxPhase: ShellRunnerSandboxPhase | undefined;
let runMountDiagnostic: ShellRunnerRunMountDiagnostic | undefined;

async function main(): Promise<void> {
  if (!mode) throw new Error("Shell runner mode is fixed by its service unit.");
  startupPhase = "sandbox-validation";
  await assertShellRunnerSandbox(mode, (phase, runMount) => {
    sandboxPhase = phase;
    runMountDiagnostic = runMount;
  });
  startupPhase = "toolchain-validation";
  const toolchain = await loadReviewedShellToolchain();
  const shellPath = toolchain.executables[0].path;
  startupPhase = "server-initialization";
  const runner = createShellRunnerServer({ mode, shellPath });
  startupPhase = "socket-activation";
  const fd = systemdSocketActivationFd(mode === "read-only" ? "shell-read" : "shell-write");
  startupPhase = "socket-listen";
  await runner.listen({ fd });
  startupPhase = "request-serving";
  process.once("SIGTERM", () => void runner.stop());
  process.once("SIGINT", () => void runner.stop());
  await runner.completion;
}

main().catch((error: unknown) => {
  process.stderr.write(
    shellRunnerUnavailableMessage(startupPhase, sandboxPhase, shellRunnerSafeErrno(error), runMountDiagnostic)
  );
  process.exitCode = 1;
});
