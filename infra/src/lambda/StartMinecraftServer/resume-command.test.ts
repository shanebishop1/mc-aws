import { describe, expect, it } from "vitest";

import { buildResumeCommand, buildResumeInvocation } from "./resume-command.js";

describe("resume bootstrap command", () => {
  it("waits boundedly for both bootstrap artifacts", () => {
    const command = buildResumeCommand({ mode: "latest" });

    expect(command).toContain("attempt < 48");
    expect(command).toContain("/var/lib/mc-aws/bootstrap-complete");
    expect(command).toContain("-x ");
    expect(command).toContain("/usr/local/bin/mc-resume.sh");
    expect(command).toContain("exec ");
  });

  it("quotes a named backup as one POSIX shell argument", () => {
    const invocation = buildResumeInvocation({
      mode: "named",
      backupArchiveName: "backup'$(touch /tmp/pwned).tar.gz",
    });

    expect(invocation).toContain(`'backup'"'"'$(touch /tmp/pwned).tar.gz'`);
    expect(invocation).not.toContain("mc-resume.sh named backup'$(touch");
  });

  it("rejects incomplete named strategies", () => {
    expect(() => buildResumeCommand({ mode: "named" })).toThrow("invalid restore strategy");
  });
});
