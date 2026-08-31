import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertBootstrapUserDataMatches, validateBootstrapPins } from "./bootstrap-pins";

const root = process.cwd();
const config = JSON.parse(readFileSync(path.join(root, "config/bootstrap-pins.json"), "utf8")) as unknown;
const userData = readFileSync(path.join(root, "infra/src/ec2/user_data.sh"), "utf8");
const runtimeRollout = readFileSync(path.join(root, "infra/src/ec2/mc-runtime-rollout.sh"), "utf8");

interface MutablePin extends Record<string, unknown> {
  build?: unknown;
  sha256?: unknown;
  url?: unknown;
}

interface MutableConfig extends Record<string, unknown> {
  artifacts: Record<"paper" | "rclone" | "mcstatus" | "asyncioDgram" | "dnspython", MutablePin>;
}

function cloneConfig(): MutableConfig {
  return JSON.parse(JSON.stringify(config)) as MutableConfig;
}

describe("reviewed bootstrap pins contract", () => {
  it("requires every exact version, URL, checksum source, and non-placeholder SHA-256", () => {
    const pins = validateBootstrapPins(config);
    expect(() => assertBootstrapUserDataMatches(userData, pins)).not.toThrow();
    expect(() => assertBootstrapUserDataMatches(runtimeRollout, pins)).not.toThrow();
    expect(runtimeRollout).toContain("mcstatus-12.0.2-py3-none-any.whl");
    expect(runtimeRollout).toContain("asyncio_dgram-2.2.0-py3-none-any.whl");
    expect(runtimeRollout).toContain("dnspython-2.7.0-py3-none-any.whl");
  });

  it("rejects absent and placeholder pins", () => {
    const absent = cloneConfig();
    const { sha256: _removedSha256, ...rcloneWithoutSha256 } = absent.artifacts.rclone;
    absent.artifacts.rclone = rcloneWithoutSha256;
    expect(() => validateBootstrapPins(absent)).toThrow(/exactly|sha256/);

    const placeholder = cloneConfig();
    placeholder.artifacts.mcstatus.sha256 = "0".repeat(64);
    expect(() => validateBootstrapPins(placeholder)).toThrow(/reviewed SHA-256/);

    const mutable = cloneConfig();
    mutable.artifacts.rclone.url = "https://downloads.rclone.org/rclone-current-linux-arm64.zip";
    expect(() => validateBootstrapPins(mutable)).toThrow(/mutable or a placeholder/);
  });

  it("rejects Paper version/build/url mismatch and user-data drift", () => {
    const mismatchedPaper = cloneConfig();
    mismatchedPaper.artifacts.paper.build = 131;
    expect(() => validateBootstrapPins(mismatchedPaper)).toThrow(/Paper version\/build\/url pins do not match/);

    const mismatchedChecksum = cloneConfig();
    mismatchedChecksum.artifacts.paper.sha256 = "ab".repeat(32);
    expect(() => validateBootstrapPins(mismatchedChecksum)).toThrow(/Paper version\/build\/url pins do not match/);

    const pins = validateBootstrapPins(config);
    expect(() =>
      assertBootstrapUserDataMatches(userData.replace('readonly PAPER_BUILD="132"', 'readonly PAPER_BUILD="131"'), pins)
    ).toThrow(/does not match reviewed bootstrap pins/);
  });

  it("keeps setup validation wired to both reusable deployment env files", () => {
    const setup = readFileSync(path.join(root, "setup.sh"), "utf8");
    expect(setup).toContain("scripts/setup/pin-bootstrap-artifacts.ts check");
    expect(setup).toContain('--env-file "$PRODUCTION_ENV_FILE"');
    expect(setup).toContain('--env-file "$LOCAL_ENV_FILE"');
  });
});
