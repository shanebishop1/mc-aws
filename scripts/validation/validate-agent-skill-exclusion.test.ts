import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LOCAL_SKILL_CONTENT_MARKER, validateAgentSkillExclusion } from "./validate-agent-skill-exclusion";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function artifact(): string {
  const root = mkdtempSync(path.join(tmpdir(), "mc-aws-panel-artifact-"));
  roots.push(root);
  writeFileSync(path.join(root, "server.mjs"), "export const panel = true;\n");
  return root;
}

describe("agent local-skill package boundary", () => {
  it("accepts generated panel artifacts without local developer guidance", () => {
    expect(() => validateAgentSkillExclusion([artifact()])).not.toThrow();
  });

  it("rejects both .agents paths and copied local skill content", () => {
    const pathLeak = artifact();
    mkdirSync(path.join(pathLeak, ".agents", "skills"), { recursive: true });
    expect(() => validateAgentSkillExclusion([pathLeak])).toThrow(".agents path entered");

    const contentLeak = artifact();
    writeFileSync(path.join(contentLeak, "renamed.txt"), LOCAL_SKILL_CONTENT_MARKER);
    expect(() => validateAgentSkillExclusion([contentLeak])).toThrow("Local skill content entered");
  });

  it("rejects repository state, environment, credential, and mock-state names", () => {
    for (const name of [".git", ".env.production", ".local-artifacts", "mock-state.json", "credentials.json"]) {
      const root = artifact();
      mkdirSync(path.join(root, name), { recursive: true });
      expect(() => validateAgentSkillExclusion([root])).toThrow("Forbidden packaged path entered");
    }
  });

  it("rejects secret-like content but accepts benign lookalike text", () => {
    const benign = artifact();
    writeFileSync(path.join(benign, "credentialing.txt"), "oauth2-compatible=true\nSecureStringProvider=local\n");
    expect(() => validateAgentSkillExclusion([benign])).not.toThrow();

    const secret = artifact();
    writeFileSync(path.join(secret, "config.txt"), '{"oauth_token":"leaked"}\n');
    expect(() => validateAgentSkillExclusion([secret])).toThrow("Secret-like content entered");
  });

  it("stream-scans extensionless, binary, and formerly oversized regular files", () => {
    const root = artifact();
    const prefix = Buffer.alloc(10 * 1024 * 1024 + 17, 0);
    writeFileSync(path.join(root, "opaque-artifact"), Buffer.concat([prefix, Buffer.from(LOCAL_SKILL_CONTENT_MARKER)]));
    expect(() => validateAgentSkillExclusion([root])).toThrow("Local skill content entered");
  });

  it("detects the content marker split across scanner chunks", () => {
    const root = artifact();
    const boundaryPrefix = Buffer.alloc(64 * 1024 - 10, 0);
    writeFileSync(
      path.join(root, "binary.blob"),
      Buffer.concat([boundaryPrefix, Buffer.from(LOCAL_SKILL_CONTENT_MARKER)])
    );
    expect(() => validateAgentSkillExclusion([root])).toThrow("Local skill content entered");
  });

  it("rejects unexpected symlinks instead of following or skipping them", () => {
    const root = artifact();
    symlinkSync(path.join(root, "server.mjs"), path.join(root, "linked-output"));
    expect(() => validateAgentSkillExclusion([root])).toThrow("Unexpected symlink entered");
  });
});
