import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanRepositoryArtifacts } from "../operations/clean-local-artifacts";
import {
  NEXT_BUILD_DOTENV_FILES,
  NEXT_BUILD_ISOLATION_JOURNAL,
  NEXT_BUILD_ISOLATION_STATE_DIRECTORY,
  recoverNextBuildIsolation,
  restoreNextBuildIsolation,
  stageNextBuildIsolation,
  withNextBuildIsolation,
} from "./next-build-isolation";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const makeRoot = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), "mc-aws-next-build-isolation-"));
  roots.push(root);
  return root;
};

describe("Next production build dotenv isolation", () => {
  it("hides every Next dotenv candidate and restores exact contents and modes", () => {
    const root = makeRoot();
    const original = new Map<string, { contents: string; mode: number }>();
    for (const [index, relativePath] of NEXT_BUILD_DOTENV_FILES.entries()) {
      const filePath = path.join(root, relativePath);
      const contents = `AUTH_SECRET=hidden-canary-${index}\nVISIBLE_${index}=yes\n`;
      writeFileSync(filePath, contents, { mode: 0o640 });
      original.set(filePath, { contents, mode: statSync(filePath).mode & 0o777 });
    }

    stageNextBuildIsolation(root, { sourceEnvironmentFile: ".env.production" });
    expect(readFileSync(path.join(root, ".env.production.local"), "utf8")).not.toContain("hidden-canary");
    expect(existsSync(path.join(root, NEXT_BUILD_ISOLATION_STATE_DIRECTORY, NEXT_BUILD_ISOLATION_JOURNAL))).toBe(true);
    for (const filePath of original.keys()) {
      if (filePath !== path.join(root, ".env.production.local")) expect(existsSync(filePath)).toBe(false);
    }

    restoreNextBuildIsolation(root);
    for (const [filePath, expected] of original) {
      expect(readFileSync(filePath, "utf8")).toBe(expected.contents);
      expect(statSync(filePath).mode & 0o777).toBe(expected.mode);
    }
    expect(existsSync(path.join(root, NEXT_BUILD_ISOLATION_STATE_DIRECTORY, NEXT_BUILD_ISOLATION_JOURNAL))).toBe(false);
  });

  it("refuses concurrent staging and recovers an interrupted journal", () => {
    const root = makeRoot();
    const dotenvPath = path.join(root, ".env.production");
    writeFileSync(dotenvPath, "AUTH_SECRET=interrupted-canary\n", { mode: 0o600 });

    stageNextBuildIsolation(root, { sourceEnvironmentFile: ".env.production" });
    expect(() => stageNextBuildIsolation(root, { sourceEnvironmentFile: ".env.production" })).toThrow(
      "Another isolated Next build is active"
    );
    expect(() => recoverNextBuildIsolation(root)).toThrow("Another isolated Next build is active");
    restoreNextBuildIsolation(root);
    expect(readFileSync(dotenvPath, "utf8")).toBe("AUTH_SECRET=interrupted-canary\n");
  });

  it("restores files when the build callback fails", () => {
    const root = makeRoot();
    const dotenvPath = path.join(root, ".env");
    writeFileSync(dotenvPath, "AUTH_SECRET=callback-canary\n", { mode: 0o600 });

    expect(() =>
      withNextBuildIsolation(root, { sourceEnvironmentFile: ".env" }, () => {
        throw new Error("build failed");
      })
    ).toThrow("build failed");
    expect(readFileSync(dotenvPath, "utf8")).toBe("AUTH_SECRET=callback-canary\n");
    expect(existsSync(path.join(root, NEXT_BUILD_ISOLATION_STATE_DIRECTORY, NEXT_BUILD_ISOLATION_JOURNAL))).toBe(false);
  });

  it("keeps the journal and backups through the predeploy build cleanup", () => {
    const root = makeRoot();
    const dotenvPath = path.join(root, ".env.production");
    writeFileSync(dotenvPath, "AUTH_SECRET=cleanup-canary\n", { mode: 0o600 });

    stageNextBuildIsolation(root, { sourceEnvironmentFile: ".env.production" });
    cleanRepositoryArtifacts(root, "build");
    expect(existsSync(path.join(root, NEXT_BUILD_ISOLATION_STATE_DIRECTORY, NEXT_BUILD_ISOLATION_JOURNAL))).toBe(true);
    restoreNextBuildIsolation(root);
    expect(readFileSync(dotenvPath, "utf8")).toBe("AUTH_SECRET=cleanup-canary\n");
  });
});
