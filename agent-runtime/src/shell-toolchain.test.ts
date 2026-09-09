import { describe, expect, it } from "vitest";
import { parseReviewedShellToolchainManifest } from "./shell-toolchain";

const valid = {
  schemaVersion: 1,
  platform: "linux-arm64",
  source: { path: "/toolchain/bin/sh", bytes: 12, sha256: "a".repeat(64) },
  executables: [{ name: "sh", path: "/toolchain/bin/sh", bytes: 12, sha256: "a".repeat(64), mode: "0755" }],
};

describe("reviewed shell toolchain contract", () => {
  it("accepts exactly one reviewed ARM64 sh executable", () => {
    expect(parseReviewedShellToolchainManifest(valid)).toMatchObject(valid);
  });

  it.each([
    { ...valid, platform: "linux-x64" },
    { ...valid, executables: [{ ...valid.executables[0], mode: "0644" }] },
    { ...valid, source: { ...valid.source, path: "/runtime/sh" } },
  ])("rejects an unreviewed toolchain shape", (manifest) => {
    expect(() => parseReviewedShellToolchainManifest(manifest)).toThrow();
  });
});
