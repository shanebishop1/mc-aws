import { describe, expect, it } from "vitest";

import { buildResumeCommand, buildResumeInvocation } from "./resume-command.js";

describe("resume bootstrap command", () => {
  const operationId = "resume-operation-1";

  it("waits boundedly for both bootstrap artifacts", () => {
    const command = buildResumeCommand({ mode: "latest" }, operationId);

    expect(command).toContain("attempt < 48");
    expect(command).toContain("/var/lib/mc-aws/bootstrap-complete");
    expect(command).toContain("-x ");
    expect(command).toContain("/usr/local/bin/mc-resume.sh");
    expect(command).toContain("exec ");
    expect(command).toContain("MC_RESUME_OPERATION_ID");
  });

  it("quotes a named backup as one POSIX shell argument", () => {
    const invocation = buildResumeInvocation(
      {
        mode: "named",
        backupArchiveName: "backup'$(touch /tmp/pwned).tar.gz",
      },
      operationId
    );

    expect(invocation).toContain(`'backup'"'"'$(touch /tmp/pwned).tar.gz'`);
    expect(invocation).not.toContain("mc-resume.sh named backup'$(touch");
  });

  it("rejects incomplete named strategies", () => {
    expect(() => buildResumeCommand({ mode: "named" }, operationId)).toThrow("invalid restore strategy");
    expect(() => buildResumeCommand({ mode: "latest" }, "bad operation id")).toThrow("invalid restore strategy");
  });
});
