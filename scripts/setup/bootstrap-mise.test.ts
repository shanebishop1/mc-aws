import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = process.cwd();
const cleanup: string[] = [];

function harness(checksumMatches: boolean) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mc-aws-mise-bootstrap-"));
  cleanup.push(directory);
  const home = path.join(directory, "home");
  const bin = path.join(directory, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  const binary = path.join(directory, "mise-release");
  writeFileSync(
    binary,
    `#!/usr/bin/env bash
[[ "\${0##*/}" == "mise" ]] || exit 2
printf 'mise 2099.1.2 test-platform\\n' || exit 141
for ((i = 0; i < 20000; i++)); do
  printf 'mise update warning with enough trailing output to expose early pipe closure\\n' || exit 141
done
`,
    { mode: 0o755 }
  );
  chmodSync(binary, 0o755);
  const digest = createHash("sha256").update(readFileSync(binary)).digest("hex");
  const platform =
    process.platform === "darwin"
      ? process.arch === "arm64"
        ? "darwin-arm64"
        : "darwin-x64"
      : process.arch === "arm64"
        ? "linux-arm64"
        : "linux-x64";
  const assets = Object.fromEntries(
    ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"].map((name) => [
      name,
      {
        url: `https://github.com/jdx/mise/releases/download/v2099.1.2/mise-v2099.1.2-${name.replace("darwin", "macos")}`,
        sha256: name === platform && checksumMatches ? digest : "a".repeat(64),
      },
    ])
  );
  const config = path.join(directory, "mise-pins.json");
  writeFileSync(
    config,
    JSON.stringify({
      schemaVersion: 1,
      version: "2099.1.2",
      releaseTag: "v2099.1.2",
      reviewedAt: "2099-01-02",
      assets,
      checksumSource: "https://github.com/jdx/mise/releases/download/v2099.1.2/SHASUMS256.txt",
    })
  );
  const curl = path.join(bin, "curl");
  writeFileSync(
    curl,
    `#!/usr/bin/env bash
set -euo pipefail
output=""
while (( $# )); do
  if [[ "$1" == "--output" ]]; then output="$2"; shift 2; else shift; fi
done
cp ${JSON.stringify(binary)} "$output"
`,
    { mode: 0o755 }
  );
  chmodSync(curl, 0o755);
  const result = spawnSync("bash", ["scripts/setup/bootstrap-mise.sh", "install"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      MC_AWS_MISE_PINS_FILE: config,
    },
  });
  return { result, home };
}

afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("pinned mise bootstrap", () => {
  it("runs before any credential environment file is loaded and has no mutable curl pipe", () => {
    const setup = readFileSync(path.join(root, "setup.sh"), "utf8");
    const main = setup.slice(setup.indexOf("main()"));
    expect(main.indexOf("scripts/setup/bootstrap-mise.sh install")).toBeGreaterThan(-1);
    expect(main.indexOf("scripts/setup/bootstrap-mise.sh install")).toBeLessThan(
      main.indexOf("maybe_confirm_existing_credentials")
    );
    expect(main.indexOf("mise install")).toBeLessThan(main.indexOf("maybe_confirm_existing_credentials"));
    expect(main.indexOf("pnpm install --frozen-lockfile")).toBeLessThan(
      main.indexOf("maybe_confirm_existing_credentials")
    );
    expect(main.indexOf("scripts/setup/bootstrap-mise.sh install")).toBeLessThan(
      main.indexOf('load_env_file "$PRODUCTION_ENV_FILE"')
    );
    expect(main).toContain('env -i HOME="$HOME" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}"');
    expect(setup).not.toContain("curl https://mise.run | sh");
  });

  it("installs only a binary matching the exact release checksum", () => {
    const { result, home } = harness(true);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(path.join(home, ".local/bin/mise"), "utf8")).toContain("mise 2099.1.2");
  });

  it("does not install a checksum-mismatched release", () => {
    const { result, home } = harness(false);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("checksum mismatch");
    expect(() => readFileSync(path.join(home, ".local/bin/mise"))).toThrow();
  });
});
