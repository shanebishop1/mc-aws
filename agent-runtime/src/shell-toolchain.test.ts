import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  REVIEWED_BUSYBOX_APPLETS,
  REVIEWED_SHELL_TOOLCHAIN_EXECUTABLE,
  REVIEWED_SHELL_TOOLCHAIN_LOCK,
  REVIEWED_SHELL_TOOLCHAIN_MANIFEST,
  parseReviewedShellToolchainManifest,
} from "./shell-toolchain";

const valid = {
  schemaVersion: 1,
  platform: "linux-arm64",
  source: {
    path: "/toolchain/src/busybox-1.38.0.tar.bz2",
    bytes: 12,
    sha256: "a".repeat(64),
    url: "https://busybox.net/downloads/busybox-1.38.0.tar.bz2",
    signature: {
      path: "/toolchain/src/busybox-1.38.0.tar.bz2.sig",
      bytes: 12,
      sha256: "b".repeat(64),
      url: "https://busybox.net/downloads/busybox-1.38.0.tar.bz2.sig",
      signerFingerprint: "C9E9416F76E610DBD09D040F47B70C55ACC9965B",
    },
    publicKey: {
      path: "/toolchain/src/vda_pubkey.gpg",
      bytes: 12,
      sha256: "c".repeat(64),
      url: "https://busybox.net/~vda/vda_pubkey.gpg",
    },
    license: "GPL-2.0-only",
  },
  build: {
    version: "1.38.0",
    compiler: "gcc 13.3.0",
    libc: "glibc 2.39",
    binutils: "binutils 2.42",
    configPath: "/toolchain/build/busybox-1.38.0.config",
    configBytes: 12,
    configSha256: "d".repeat(64),
    configFragmentPath: "/toolchain/build/busybox-1.38.0.config.fragment",
    configFragmentBytes: 12,
    configFragmentSha256: "e".repeat(64),
    recipePath: "/toolchain/build/build-shell-toolchain.sh",
    recipeBytes: 12,
    recipeSha256: "f".repeat(64),
    static: true,
    standaloneApplets: true,
    licenseStatus: "local-disposable-testing-only;-public-distribution-blocked",
    licenseNote: "BusyBox source is retained; static glibc corresponding-source obligations are not staged.",
  },
  applets: REVIEWED_BUSYBOX_APPLETS,
  executables: [{ name: "sh", path: "/toolchain/bin/sh", bytes: 12, sha256: "a".repeat(64), mode: "0755" }],
};

describe("reviewed shell toolchain contract", () => {
  it("keeps the runtime pins aligned with the repository lock", () => {
    const lock = JSON.parse(readFileSync(new URL("../shell-toolchain-lock.json", import.meta.url), "utf8"));
    expect(lock.manifest).toEqual(REVIEWED_SHELL_TOOLCHAIN_MANIFEST);
    expect(lock.executable).toEqual({
      path: "bin/sh",
      bytes: REVIEWED_SHELL_TOOLCHAIN_EXECUTABLE.bytes,
      sha256: REVIEWED_SHELL_TOOLCHAIN_EXECUTABLE.sha256,
    });
    expect(REVIEWED_SHELL_TOOLCHAIN_LOCK.path).toBe("/toolchain/build/shell-toolchain-lock.json");
  });
  it("accepts exactly one reviewed ARM64 sh executable", () => {
    expect(parseReviewedShellToolchainManifest(valid)).toMatchObject(valid);
  });

  it.each([
    { ...valid, platform: "linux-x64" },
    { ...valid, executables: [{ ...valid.executables[0], mode: "0644" }] },
    { ...valid, source: { ...valid.source, path: "/runtime/sh" } },
    { ...valid, applets: [...valid.applets, "mount"] },
  ])("rejects an unreviewed toolchain shape", (manifest) => {
    expect(() => parseReviewedShellToolchainManifest(manifest)).toThrow();
  });
});
