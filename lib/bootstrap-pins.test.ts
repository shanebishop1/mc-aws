import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertBootstrapReleaseManifestMatches,
  assertBootstrapRuntimeRolloutMatches,
  assertBootstrapUserDataMatches,
  bootstrapPinsFingerprint,
  validateBootstrapPins,
} from "./bootstrap-pins";

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
  artifacts: Record<"paper" | "rclone" | "nodeArm64" | "mcstatus" | "asyncioDgram" | "dnspython", MutablePin>;
}

function cloneConfig(): MutableConfig {
  return JSON.parse(JSON.stringify(config)) as MutableConfig;
}

describe("reviewed bootstrap pins contract", () => {
  it("requires every exact version, URL, checksum source, and non-placeholder SHA-256", () => {
    const pins = validateBootstrapPins(config);
    expect(() => assertBootstrapUserDataMatches(userData, pins)).not.toThrow();
    expect(() => assertBootstrapRuntimeRolloutMatches(runtimeRollout, pins)).not.toThrow();
    expect(runtimeRollout).toContain(`readonly MC_BOOTSTRAP_PINS_SHA256="${bootstrapPinsFingerprint(pins)}"`);
    expect(userData).toContain('readonly NODE_VERSION="22.19.0"');
    expect(userData).toContain(
      'readonly NODE_ARM64_SHA256="0b2d9f564b6594222a62c82e1df2efe119dd4a4aff29644f4dd325bf360b6bcc"'
    );
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

  it("rejects a host release pin mismatch and accepts the current canonical pin", () => {
    const pins = validateBootstrapPins(config);
    const releaseManifest = {
      bootstrapPins: { manifest: pins, sha256: bootstrapPinsFingerprint(pins) },
    };
    expect(() => assertBootstrapReleaseManifestMatches(releaseManifest, pins)).not.toThrow();
    const stale = JSON.parse(JSON.stringify(releaseManifest)) as typeof releaseManifest;
    stale.bootstrapPins.manifest.artifacts.paper.minecraftVersion = "1.21.10";
    expect(() => assertBootstrapReleaseManifestMatches(stale, pins)).toThrow(/do not match reviewed bootstrap pins/);
    expect(() =>
      assertBootstrapRuntimeRolloutMatches(
        runtimeRollout.replace(`"${bootstrapPinsFingerprint(pins)}"`, `"${"0".repeat(64)}"`),
        pins
      )
    ).toThrow(/digest does not match/);
  });

  it("keeps setup validation wired to both reusable deployment env files", () => {
    const setup = readFileSync(path.join(root, "setup.sh"), "utf8");
    expect(setup).toContain("scripts/setup/pin-bootstrap-artifacts.ts check");
    expect(setup).toContain('--env-file "$PRODUCTION_ENV_FILE"');
    expect(setup).toContain('--env-file "$LOCAL_ENV_FILE"');
  });
});
