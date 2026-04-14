import {
  normalizeAndSanitizeBackupName,
  normalizeMutatingActionArgs,
  normalizeMutatingActionType,
  parseMutatingActionRequestPayload,
  parseOptionalMutatingJsonBody,
} from "@/lib/mutating-action-validation";
import { createMockNextRequest } from "@/tests/utils";
import { describe, expect, it } from "vitest";

describe("mutating-action-validation", () => {
  describe("normalizeMutatingActionType", () => {
    it("normalizes known mutating action commands", () => {
      expect(normalizeMutatingActionType(" START ")).toBe("start");
      expect(normalizeMutatingActionType("restore")).toBe("restore");
    });

    it("returns null for unknown or invalid command values", () => {
      expect(normalizeMutatingActionType("refreshBackups")).toBeNull();
      expect(normalizeMutatingActionType(42)).toBeNull();
    });
  });

  describe("normalizeMutatingActionArgs", () => {
    it("returns trimmed non-empty string args", () => {
      expect(normalizeMutatingActionArgs([" nightly ", "", "  ", "latest"])).toEqual(["nightly", "latest"]);
    });

    it("drops non-string and nullish args", () => {
      expect(normalizeMutatingActionArgs(["foo", 123, null, undefined])).toEqual(["foo"]);
      expect(normalizeMutatingActionArgs("not-an-array")).toEqual([]);
    });
  });

  describe("parseOptionalMutatingJsonBody", () => {
    it("returns parsed object body when valid JSON object is provided", async () => {
      const request = createMockNextRequest("http://localhost/api/backup", {
        method: "POST",
        body: JSON.stringify({ backupName: "nightly" }),
      });

      await expect(parseOptionalMutatingJsonBody(request)).resolves.toEqual({ backupName: "nightly" });
    });

    it("returns empty object for invalid, empty, or non-object JSON bodies", async () => {
      const invalidRequest = createMockNextRequest("http://localhost/api/backup", {
        method: "POST",
        body: "{invalid",
      });
      const emptyRequest = createMockNextRequest("http://localhost/api/backup", {
        method: "POST",
        body: "",
      });
      const arrayRequest = createMockNextRequest("http://localhost/api/backup", {
        method: "POST",
        body: JSON.stringify(["nightly"]),
      });

      await expect(parseOptionalMutatingJsonBody(invalidRequest)).resolves.toEqual({});
      await expect(parseOptionalMutatingJsonBody(emptyRequest)).resolves.toEqual({});
      await expect(parseOptionalMutatingJsonBody(arrayRequest)).resolves.toEqual({});
    });
  });

  describe("normalizeAndSanitizeBackupName", () => {
    it("prefers backupName over legacy name and trims values", () => {
      expect(normalizeAndSanitizeBackupName({ backupName: "  new-name  ", name: "old-name" })).toBe("new-name");
      expect(normalizeAndSanitizeBackupName({ name: "  legacy-name  " })).toBe("legacy-name");
    });

    it("returns undefined for empty or missing names", () => {
      expect(normalizeAndSanitizeBackupName({ backupName: "   " })).toBeUndefined();
      expect(normalizeAndSanitizeBackupName({})).toBeUndefined();
    });

    it("throws when backup name contains invalid characters", () => {
      expect(() => normalizeAndSanitizeBackupName({ backupName: "bad;rm -rf /" })).toThrow(
        "Backup name contains invalid characters"
      );
    });
  });

  describe("parseMutatingActionRequestPayload", () => {
    it("returns sanitized backup payload for backup/restore/resume", async () => {
      const backupRequest = createMockNextRequest("http://localhost/api/backup", {
        method: "POST",
        body: JSON.stringify({ name: "  nightly  " }),
      });
      const restoreRequest = createMockNextRequest("http://localhost/api/restore", {
        method: "POST",
        body: JSON.stringify({ backupName: "restore-point" }),
      });
      const resumeRequest = createMockNextRequest("http://localhost/api/resume", {
        method: "POST",
        body: JSON.stringify({ backupName: "resume-point" }),
      });

      await expect(parseMutatingActionRequestPayload(backupRequest, "backup")).resolves.toEqual({
        backupName: "nightly",
      });
      await expect(parseMutatingActionRequestPayload(restoreRequest, "restore")).resolves.toEqual({
        backupName: "restore-point",
      });
      await expect(parseMutatingActionRequestPayload(resumeRequest, "resume")).resolves.toEqual({
        backupName: "resume-point",
      });
    });

    it("returns empty payload for no-arg mutating actions", async () => {
      const request = createMockNextRequest("http://localhost/api/hibernate", {
        method: "POST",
        body: "",
      });

      await expect(parseMutatingActionRequestPayload(request, "hibernate")).resolves.toEqual({});
    });
  });
});
