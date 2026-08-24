import { describe, expect, it } from "vitest";
import { compareVersions, parseStableSemver, resolveReleaseVersion } from "./prepare-release";

describe("release version contract", () => {
  it.each([
    ["major", "2.0.0"],
    ["minor", "1.3.0"],
    ["patch", "1.2.4"],
    ["3.4.5", "3.4.5"],
  ])("resolves %s bumps", (input, expected) => {
    expect(resolveReleaseVersion("1.2.3", input)).toBe(expected);
  });

  it.each(["v1.2.3", "1.2", "01.2.3", "1.2.3-beta.1", "1.2.3+build", "1.2.3\n"])(
    "rejects non-stable SemVer %j",
    (version) => {
      expect(() => parseStableSemver(version)).toThrow(/stable SemVer/);
    }
  );

  it("requires exact versions to increase monotonically", () => {
    expect(() => resolveReleaseVersion("2.0.0", "2.0.0")).toThrow(/must be greater/);
    expect(() => resolveReleaseVersion("2.0.0", "1.99.99")).toThrow(/must be greater/);
    expect(compareVersions("10.0.0", "9.99.99")).toBe(1);
  });
});
