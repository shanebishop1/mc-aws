import { quotePosixShellArgument } from "./posix-shell.js";

const BOOTSTRAP_MARKER = "/var/lib/mc-aws/bootstrap-complete";
const RESUME_SCRIPT = "/usr/local/bin/mc-resume.sh";
// Allow cloud-init package installation to finish while preserving time for restore inside the SSM budget.
const BOOTSTRAP_WAIT_ATTEMPTS = 48;
const BOOTSTRAP_WAIT_SECONDS = 5;

export function buildResumeInvocation(restoreStrategy) {
  const argumentsByMode = {
    fresh: ["fresh"],
    latest: ["latest"],
    named: ["named", restoreStrategy.backupArchiveName],
  };
  const arguments_ = argumentsByMode[restoreStrategy.mode];
  if (!arguments_ || arguments_.some((argument) => typeof argument !== "string" || !argument)) {
    throw new Error("Cannot build resume command for an invalid restore strategy");
  }

  return [RESUME_SCRIPT, ...arguments_].map(quotePosixShellArgument).join(" ");
}

export function buildResumeCommand(restoreStrategy) {
  const invocation = buildResumeInvocation(restoreStrategy);
  const script = [
    "set -euo pipefail",
    "attempt=0",
    `while (( attempt < ${BOOTSTRAP_WAIT_ATTEMPTS} )); do`,
    `  if [[ -f ${quotePosixShellArgument(BOOTSTRAP_MARKER)} && -x ${quotePosixShellArgument(RESUME_SCRIPT)} ]]; then`,
    `    exec ${invocation}`,
    "  fi",
    "  attempt=$((attempt + 1))",
    `  sleep ${BOOTSTRAP_WAIT_SECONDS}`,
    "done",
    'printf "%s\\n" "ERROR: bootstrap did not become ready for resume within the bounded wait" >&2',
    "exit 1",
  ].join("\n");

  return `bash -lc ${quotePosixShellArgument(script)}`;
}
