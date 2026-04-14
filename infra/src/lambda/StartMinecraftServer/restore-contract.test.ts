import { describe, expect, it } from "vitest";

import { normalizeBackupArchiveName, resolveResumeRestoreStrategy } from "./restore-contract.js";

describe("restore-contract", () => {
  it("normalizes backup names to archive filenames", () => {
    expect(normalizeBackupArchiveName("nightly-2026")).toBe("nightly-2026.tar.gz");
    expect(normalizeBackupArchiveName("nightly-2026.tar.gz")).toBe("nightly-2026.tar.gz");
    expect(normalizeBackupArchiveName("nightly-2026.gz")).toBe("nightly-2026.gz");
  });

  it("selects exactly one resume restore strategy", () => {
    expect(resolveResumeRestoreStrategy({})).toEqual({ mode: "fresh" });
    expect(resolveResumeRestoreStrategy({ restoreMode: "latest" })).toEqual({ mode: "latest" });
    expect(resolveResumeRestoreStrategy({ args: ["my-backup"] })).toEqual({
      mode: "named",
      backupArchiveName: "my-backup.tar.gz",
    });
  });

  it("rejects inconsistent restore strategy inputs", () => {
    expect(() => resolveResumeRestoreStrategy({ restoreMode: "fresh", args: ["backup.tar.gz"] })).toThrow(
      "Restore mode 'fresh' cannot be used with backup args"
    );
    expect(() => resolveResumeRestoreStrategy({ restoreMode: "named" })).toThrow(
      "Backup name is required when restore mode is 'named'"
    );
  });
});
