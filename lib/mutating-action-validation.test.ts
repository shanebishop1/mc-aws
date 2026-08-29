import {
  MutatingActionPayloadValidationError,
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

    it("returns an empty object only for an absent or empty body", async () => {
      const emptyRequest = createMockNextRequest("http://localhost/api/backup", {
        method: "POST",
        body: "",
      });
      const whitespaceRequest = createMockNextRequest("http://localhost/api/backup", {
        method: "POST",
        body: "  \n ",
      });

      await expect(parseOptionalMutatingJsonBody(emptyRequest)).resolves.toEqual({});
      await expect(parseOptionalMutatingJsonBody(whitespaceRequest)).resolves.toEqual({});
    });

    it("throws typed validation errors for malformed and non-object JSON", async () => {
      const invalidRequest = createMockNextRequest("http://localhost/api/backup", {
        method: "POST",
        body: "{invalid",
      });
      const arrayRequest = createMockNextRequest("http://localhost/api/backup", {
        method: "POST",
        body: JSON.stringify(["nightly"]),
      });

      await expect(parseOptionalMutatingJsonBody(invalidRequest)).rejects.toMatchObject({
        name: "MutatingActionPayloadValidationError",
        code: "invalid_payload",
        reason: "malformed_json",
      });
      await expect(parseOptionalMutatingJsonBody(arrayRequest)).rejects.toMatchObject({
        name: "MutatingActionPayloadValidationError",
        code: "invalid_payload",
        reason: "non_object_json",
      });
      await expect(parseOptionalMutatingJsonBody(arrayRequest)).rejects.toBeInstanceOf(
        MutatingActionPayloadValidationError
      );
    });
  });

  describe("normalizeAndSanitizeBackupName", () => {
    it("supports either backup name alias and trims values", () => {
      expect(normalizeAndSanitizeBackupName({ backupName: "  new-name  " })).toBe("new-name");
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

    it("rejects present non-string aliases and conflicting aliases", () => {
      expect(() => normalizeAndSanitizeBackupName({ backupName: 42 })).toThrow("backupName must be a string");
      expect(() => normalizeAndSanitizeBackupName({ backupName: "one", name: "two" })).toThrow(
        "backupName and name must not conflict"
      );
      expect(normalizeAndSanitizeBackupName({ backupName: "same", name: " same " })).toBe("same");
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
        body: JSON.stringify({ backupName: "resume-point", restoreMode: "named" }),
      });

      await expect(parseMutatingActionRequestPayload(backupRequest, "backup")).resolves.toEqual({
        backupName: "nightly",
      });
      await expect(parseMutatingActionRequestPayload(restoreRequest, "restore")).resolves.toEqual({
        backupName: "restore-point",
      });
      await expect(parseMutatingActionRequestPayload(resumeRequest, "resume")).resolves.toEqual({
        backupName: "resume-point",
        restoreMode: "named",
      });
    });

    it("defaults resume payload to no backup and no explicit mode", async () => {
      const resumeRequest = createMockNextRequest("http://localhost/api/resume", {
        method: "POST",
        body: JSON.stringify({}),
      });

      await expect(parseMutatingActionRequestPayload(resumeRequest, "resume")).resolves.toEqual({
        backupName: undefined,
        restoreMode: undefined,
      });
    });

    it("rejects invalid resume restore mode values", async () => {
      const resumeRequest = createMockNextRequest("http://localhost/api/resume", {
        method: "POST",
        body: JSON.stringify({ restoreMode: "random" }),
      });

      await expect(parseMutatingActionRequestPayload(resumeRequest, "resume")).rejects.toThrow(
        "Restore mode must be one of: fresh, latest, named"
      );
    });

    it("returns empty payload for no-arg mutating actions", async () => {
      const request = createMockNextRequest("http://localhost/api/hibernate", {
        method: "POST",
        body: "",
      });

      await expect(parseMutatingActionRequestPayload(request, "hibernate")).resolves.toEqual({});
    });

    it.each([
      ["start", { instanceId: "i-attacker" }],
      ["stop", { backupName: "unexpected" }],
      ["backup", { restoreMode: "latest" }],
      ["restore", { extra: true }],
      ["hibernate", { mode: "fresh" }],
    ] as const)("rejects fields inappropriate for %s", async (action, body) => {
      const request = createMockNextRequest(`http://localhost/api/${action}`, {
        method: "POST",
        body: JSON.stringify(body),
      });

      await expect(parseMutatingActionRequestPayload(request, action)).rejects.toMatchObject({
        code: "invalid_payload",
        reason: "unknown_field",
      });
    });

    it("rejects wrong-typed fields and conflicting resume aliases", async () => {
      const wrongType = createMockNextRequest("http://localhost/api/resume", {
        method: "POST",
        body: JSON.stringify({ backupName: null }),
      });
      const conflict = createMockNextRequest("http://localhost/api/resume", {
        method: "POST",
        body: JSON.stringify({ restoreMode: "fresh", mode: "latest" }),
      });

      await expect(parseMutatingActionRequestPayload(wrongType, "resume")).rejects.toMatchObject({
        reason: "invalid_field_type",
      });
      await expect(parseMutatingActionRequestPayload(conflict, "resume")).rejects.toMatchObject({
        reason: "conflicting_aliases",
      });
    });

    it.each([{ backupName: "" }, { backupName: "   " }, { name: "" }, { name: "\n\t" }])(
      "rejects an explicitly blank restore backup alias: %j",
      async (body) => {
        const request = createMockNextRequest("http://localhost/api/restore", {
          method: "POST",
          body: JSON.stringify(body),
        });

        await expect(parseMutatingActionRequestPayload(request, "restore")).rejects.toMatchObject({
          message: "Backup name cannot be empty",
          reason: "invalid_field_value",
        });
      }
    );

    it("continues to treat an omitted restore backup name as latest", async () => {
      const request = createMockNextRequest("http://localhost/api/restore", {
        method: "POST",
        body: JSON.stringify({}),
      });
      await expect(parseMutatingActionRequestPayload(request, "restore")).resolves.toEqual({
        backupName: undefined,
      });
    });
  });
});
