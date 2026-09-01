import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanRepositoryArtifacts, parseArtifactGroup } from "./clean-local-artifacts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("local artifact cleanup", () => {
  it("removes only allowlisted reproducible repository outputs", () => {
    const root = temporaryDirectory("mc-local-clean-root-");
    for (const relativePath of [
      ".next/cache/item",
      ".open-next/worker.js",
      ".wrangler/state/item",
      "coverage/index.html",
      "playwright-report/index.html",
      "test-results/result.json",
      "artifacts/summary.md",
      "infra/cdk.out/mc-asset-archives/archive.zip",
      ".local-artifacts/build-tmp/interrupted-build",
      ".local-artifacts/test-tmp/interrupted-test",
      ".local-artifacts/cdk-tmp/interrupted-synth",
    ]) {
      const filePath = path.join(root, relativePath);
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, "generated");
    }
    for (const relativePath of [".env.production", ".mc-aws-deployment.json", ".mock-state.json"]) {
      writeFileSync(path.join(root, relativePath), "preserve");
    }
    const external = temporaryDirectory("mc-local-clean-external-");
    writeFileSync(path.join(external, "preserve"), "outside");
    symlinkSync(external, path.join(root, "unrecognized-link"));

    cleanRepositoryArtifacts(root, "all");

    expect(existsSync(path.join(root, ".next"))).toBe(false);
    expect(existsSync(path.join(root, "infra/cdk.out"))).toBe(false);
    expect(existsSync(path.join(root, ".env.production"))).toBe(true);
    expect(existsSync(path.join(root, ".mc-aws-deployment.json"))).toBe(true);
    expect(existsSync(path.join(root, ".mock-state.json"))).toBe(true);
    expect(existsSync(path.join(root, "unrecognized-link"))).toBe(true);
    expect(existsSync(path.join(external, "preserve"))).toBe(true);
  });

  it("keeps artifact groups independent", () => {
    const root = temporaryDirectory("mc-local-clean-groups-");
    mkdirSync(path.join(root, ".next"));
    mkdirSync(path.join(root, ".open-next"));
    mkdirSync(path.join(root, "test-results"));
    mkdirSync(path.join(root, "infra/cdk.out"), { recursive: true });

    cleanRepositoryArtifacts(root, "next");

    expect(existsSync(path.join(root, ".next"))).toBe(false);
    expect(existsSync(path.join(root, ".open-next"))).toBe(true);
    expect(existsSync(path.join(root, "test-results"))).toBe(true);
    expect(existsSync(path.join(root, "infra/cdk.out"))).toBe(true);
  });

  it("refuses an allowlisted path beneath a symbolic-link ancestor", () => {
    const root = temporaryDirectory("mc-local-clean-symlink-root-");
    const external = temporaryDirectory("mc-local-clean-symlink-external-");
    mkdirSync(path.join(external, "build-tmp"));
    writeFileSync(path.join(external, "build-tmp/preserve"), "outside");
    symlinkSync(external, path.join(root, ".local-artifacts"));

    expect(() => cleanRepositoryArtifacts(root, "build")).toThrow("symbolic link");
    expect(existsSync(path.join(external, "build-tmp/preserve"))).toBe(true);
  });

  it("rejects unsupported cleanup groups", () => {
    expect(() => parseArtifactGroup("dependencies")).toThrow("Usage:");
  });
});
