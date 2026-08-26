import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveServerProfileDirectory, validatePluginLock, validateServerProfile } from "./server-profile";

const temporaryDirectories: string[] = [];
const profile = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mc-profile-test-"));
  temporaryDirectories.push(directory);
  fs.writeFileSync(path.join(directory, "server.properties"), "motd=test\n");
  fs.writeFileSync(path.join(directory, "plugins.lock.json"), '{"version":1,"plugins":[]}');
  return directory;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("server profile validation", () => {
  it("accepts regular profile files and strict player JSON", () => {
    const directory = profile();
    fs.writeFileSync(
      path.join(directory, "whitelist.json"),
      '[{"uuid":"123e4567-e89b-42d3-a456-426614174000","name":"Player_1"}]'
    );
    expect(validateServerProfile(directory)).toMatchObject({ fileCount: 3, plugins: [] });
  });

  it.each([".env", ".env.production", "id_rsa", "secret.pem", "rclone.conf", "credentials.json", "plugin.jar"])(
    "rejects sensitive filename %s",
    (name) => {
      const directory = profile();
      fs.writeFileSync(path.join(directory, name), "secret");
      expect(() => validateServerProfile(directory)).toThrow("Forbidden profile entry");
    }
  );

  it("rejects symlink entries and profile roots", () => {
    const root = profile();
    const outside = profile();
    fs.symlinkSync(path.join(outside, "server.properties"), path.join(root, "linked"));
    expect(() => validateServerProfile(root)).toThrow("regular files or directories");
    const rootLink = path.join(path.dirname(root), `${path.basename(root)}-link`);
    temporaryDirectories.push(rootLink);
    fs.symlinkSync(outside, rootLink);
    expect(() => resolveServerProfileDirectory(root, rootLink)).toThrow("must not be a symlink");
    expect(() => resolveServerProfileDirectory(root, ".")).toThrow("subdirectory");
  });

  it("accepts an explicit external profile subdirectory", () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "mc-worktree-test-"));
    temporaryDirectories.push(worktree);
    fs.mkdirSync(path.join(worktree, "config"));
    fs.writeFileSync(path.join(worktree, "config", "server.properties"), "motd=default\n");
    const privateRepository = fs.mkdtempSync(path.join(os.tmpdir(), "mc-private-profile-repo-"));
    temporaryDirectories.push(privateRepository);
    const external = path.join(privateRepository, "profiles", "production");
    fs.mkdirSync(external, { recursive: true });
    fs.writeFileSync(path.join(external, "server.properties"), "motd=private\n");

    expect(resolveServerProfileDirectory(worktree, external)).toBe(fs.realpathSync(external));
    expect(validateServerProfile(external).fileCount).toBe(1);
  });

  it("selects an existing ignored local profile before tracked config", () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "mc-profile-selection-test-"));
    temporaryDirectories.push(worktree);
    fs.mkdirSync(path.join(worktree, "config"));
    fs.writeFileSync(path.join(worktree, "config", "server.properties"), "motd=default\n");
    const local = path.join(worktree, "server-profile");
    fs.mkdirSync(local);
    fs.writeFileSync(path.join(local, "server.properties"), "motd=local\n");

    expect(resolveServerProfileDirectory(worktree, "")).toBe(fs.realpathSync(local));
    expect(resolveServerProfileDirectory(worktree, "config")).toBe(fs.realpathSync(path.join(worktree, "config")));
  });

  it("rejects an empty profile", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mc-empty-profile-test-"));
    temporaryDirectories.push(directory);
    expect(() => validateServerProfile(directory)).toThrow("at least one regular file");
  });

  it("scans complete files for credential signatures", () => {
    const directory = profile();
    fs.writeFileSync(
      path.join(directory, "late-secret.txt"),
      `${"x".repeat(70 * 1024)}\n-----BEGIN PRIVATE KEY-----\n`
    );
    expect(() => validateServerProfile(directory)).toThrow("Credential or private-key content is forbidden");
  });

  it("rejects malformed whitelist and ops entries", () => {
    const directory = profile();
    fs.writeFileSync(path.join(directory, "whitelist.json"), '[{"uuid":"../../bad","name":"player"}]');
    expect(() => validateServerProfile(directory)).toThrow("uuid is invalid");
    fs.writeFileSync(path.join(directory, "whitelist.json"), "[]");
    expect(() => validateServerProfile(directory)).toThrow("whitelist.json is empty");
    expect(() => validateServerProfile(directory, { allowEmptyWhitelist: true })).not.toThrow();
    fs.writeFileSync(
      path.join(directory, "whitelist.json"),
      '[{"uuid":"123e4567-e89b-42d3-a456-426614174000","name":"player"}]'
    );
    fs.writeFileSync(
      path.join(directory, "ops.json"),
      '[{"uuid":"123e4567-e89b-42d3-a456-426614174000","name":"player","level":9,"bypassesPlayerLimit":false}]'
    );
    expect(() => validateServerProfile(directory)).toThrow("invalid operator fields");
  });
});

describe("plugins.lock.json validation", () => {
  const plugin = {
    name: "Example",
    destination: "example.jar",
    url: "https://plugins.example.org/releases/example.jar",
    sha256: "a".repeat(64),
  };

  it("accepts exact checksum-pinned HTTPS plugins", () => {
    expect(validatePluginLock({ version: 1, plugins: [plugin] }).plugins).toEqual([plugin]);
  });

  it.each([
    ["traversal", { ...plugin, destination: "../evil.jar" }],
    ["credentials", { ...plugin, url: "https://user:password@plugins.example.org/a.jar" }],
    ["query", { ...plugin, url: "https://plugins.example.org/a.jar?token=secret" }],
    ["insecure transport", { ...plugin, url: "http://plugins.example.org/a.jar" }],
    ["uppercase checksum", { ...plugin, sha256: "A".repeat(64) }],
  ])("rejects %s", (_name, malicious) => {
    expect(() => validatePluginLock({ version: 1, plugins: [malicious] })).toThrow();
  });

  it("rejects duplicate names and destinations case-insensitively", () => {
    expect(() =>
      validatePluginLock({
        version: 1,
        plugins: [plugin, { ...plugin, name: "example", destination: "other.jar", sha256: "b".repeat(64) }],
      })
    ).toThrow("Duplicate plugin name");
    expect(() =>
      validatePluginLock({
        version: 1,
        plugins: [plugin, { ...plugin, name: "Other", destination: "EXAMPLE.jar", sha256: "b".repeat(64) }],
      })
    ).toThrow("Duplicate plugin destination");
  });
});
