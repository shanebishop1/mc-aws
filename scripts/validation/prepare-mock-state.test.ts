import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LEGACY_MOCK_STATE_MIGRATION_FLAG, prepareMockState } from "./prepare-mock-state";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(path.join(tmpdir(), "mc-aws-mock-state-prepare-"));
  roots.push(root);
  return root;
}

describe("legacy mock state preparation", () => {
  it("fails production builds without deleting the legacy file", () => {
    const root = repository();
    const legacy = path.join(root, ".mock-state.json");
    writeFileSync(legacy, '{"credential":"preserve-me"}');

    expect(() => prepareMockState(root, { NODE_ENV: "production" })).toThrow("Production build refused");
    expect(existsSync(legacy)).toBe(true);
  });

  it("requires an explicit mock development migration and preserves content", () => {
    const root = repository();
    const legacy = path.join(root, ".mock-state.json");
    writeFileSync(legacy, '{"credential":"preserve-me"}');

    expect(() => prepareMockState(root, { NODE_ENV: "development", MC_BACKEND_MODE: "mock" })).toThrow(
      "No data was changed"
    );
    expect(
      prepareMockState(root, {
        NODE_ENV: "development",
        MC_BACKEND_MODE: "mock",
        [LEGACY_MOCK_STATE_MIGRATION_FLAG]: "true",
      })
    ).toBe("migrated");
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(path.join(root, ".local-artifacts/mock-state.json"))).toBe(true);
  });

  it("does not overwrite an existing destination or follow a legacy symlink", () => {
    const root = repository();
    const local = path.join(root, ".local-artifacts");
    mkdirSync(local);
    writeFileSync(path.join(local, "mock-state.json"), "destination");
    writeFileSync(path.join(root, ".mock-state.json"), "legacy");
    expect(() =>
      prepareMockState(root, {
        MC_BACKEND_MODE: "mock",
        [LEGACY_MOCK_STATE_MIGRATION_FLAG]: "true",
      })
    ).toThrow("already exists");

    const symlinkRoot = repository();
    symlinkSync(path.join(root, ".mock-state.json"), path.join(symlinkRoot, ".mock-state.json"));
    expect(() =>
      prepareMockState(symlinkRoot, {
        MC_BACKEND_MODE: "mock",
        [LEGACY_MOCK_STATE_MIGRATION_FLAG]: "true",
      })
    ).toThrow("regular file");
  });
});
