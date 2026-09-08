import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  vi.restoreAllMocks();
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
    const approvedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-private-profile-repo-"));
    temporaryDirectories.push(approvedRoot);
    const external = path.join(approvedRoot, "profiles", "production");
    fs.mkdirSync(external, { recursive: true });
    fs.chmodSync(path.join(approvedRoot, "profiles"), 0o755);
    fs.chmodSync(external, 0o755);
    fs.writeFileSync(path.join(external, "server.properties"), "motd=private\n");

    expect(() => resolveServerProfileDirectory(worktree, external)).toThrow("explicit operator approval");
    expect(resolveServerProfileDirectory(worktree, external, approvedRoot)).toBe(fs.realpathSync(external));
    expect(validateServerProfile(external).fileCount).toBe(1);
  });

  it("rejects arbitrary profile pointers outside the approved external tree", () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "mc-profile-pointer-test-"));
    temporaryDirectories.push(worktree);
    fs.mkdirSync(path.join(worktree, "config"));
    fs.writeFileSync(path.join(worktree, "config", "server.properties"), "motd=default\n");
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "mc-approved-profile-test-"));
    const approvedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-approved-root-test-"));
    temporaryDirectories.push(external, approvedRoot);
    fs.writeFileSync(path.join(external, "server.properties"), "motd=external\n");

    expect(() => resolveServerProfileDirectory(worktree, external, approvedRoot)).toThrow("within");
    expect(() => resolveServerProfileDirectory(worktree, path.dirname(external))).toThrow("explicit operator approval");
  });

  it("accepts a secure temporary parent but rejects insecure parents and children", () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "mc-profile-secure-parent-test-"));
    temporaryDirectories.push(worktree);
    fs.mkdirSync(path.join(worktree, "config"));
    const approvedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-approved-tree-test-"));
    temporaryDirectories.push(approvedRoot);
    const parent = path.join(approvedRoot, "profiles");
    const external = path.join(parent, "production");
    fs.mkdirSync(external, { recursive: true });
    fs.chmodSync(parent, 0o755);
    fs.chmodSync(external, 0o755);
    fs.writeFileSync(path.join(external, "server.properties"), "motd=external\n");

    expect(resolveServerProfileDirectory(worktree, external, approvedRoot)).toBe(fs.realpathSync(external));

    fs.chmodSync(parent, 0o775);
    expect(() => resolveServerProfileDirectory(worktree, external, approvedRoot)).toThrow("insecure writable parent");
    fs.chmodSync(parent, 0o755);
    fs.chmodSync(external, 0o775);
    expect(() => resolveServerProfileDirectory(worktree, external, approvedRoot)).toThrow("insecure writable parent");
  });

  it("rejects a symlink escape from an approved external root", () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "mc-profile-symlink-test-"));
    temporaryDirectories.push(worktree);
    fs.mkdirSync(path.join(worktree, "config"));
    const approvedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-approved-symlink-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mc-profile-symlink-outside-"));
    temporaryDirectories.push(approvedRoot, outside);
    const escaped = path.join(outside, "production");
    fs.mkdirSync(escaped);
    fs.writeFileSync(path.join(escaped, "server.properties"), "motd=escaped\n");
    const link = path.join(approvedRoot, "profiles");
    fs.symlinkSync(outside, link);

    expect(() => resolveServerProfileDirectory(worktree, path.join(link, "production"), approvedRoot)).toThrow();
  });

  it("rejects an approved external tree with a wrong operator owner", () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "mc-profile-owner-test-"));
    temporaryDirectories.push(worktree);
    fs.mkdirSync(path.join(worktree, "config"));
    const approvedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-approved-owner-root-"));
    temporaryDirectories.push(approvedRoot);
    const external = path.join(approvedRoot, "production");
    fs.mkdirSync(external);
    fs.writeFileSync(path.join(external, "server.properties"), "motd=wrong-owner\n");
    const uid = process.getuid?.() ?? 0;
    vi.spyOn(process, "getuid").mockReturnValue(uid + 1);

    expect(() => resolveServerProfileDirectory(worktree, external, approvedRoot)).toThrow("owned by the operator");
  });

  it("rejects nested developer/mock state paths and secret-like OAuth/SecureString content", () => {
    const directory = profile();
    fs.mkdirSync(path.join(directory, "config", ".agents", "mock"), { recursive: true });
    fs.writeFileSync(path.join(directory, "config", ".agents", "mock", "state.json"), "oauth_token: leaked\n");
    expect(() => validateServerProfile(directory)).toThrow("Forbidden profile entry: .agents");

    fs.rmSync(path.join(directory, "config", ".agents"), { recursive: true, force: true });
    fs.writeFileSync(
      path.join(directory, "config", "operator-notes.json"),
      '{"oauth_token":"leaked","SecureString":"secret"}\n'
    );
    expect(() => validateServerProfile(directory)).toThrow("Credential or private-key content");
  });

  it("accepts lookalike benign names without treating substrings as secrets", () => {
    const directory = profile();
    fs.mkdirSync(path.join(directory, "config"));
    fs.writeFileSync(
      path.join(directory, "config", "credentialing.txt"),
      "oauth2-compatible=true\nSecureStringProvider=local\naccess_tokenizer=word\n"
    );
    expect(validateServerProfile(directory).fileCount).toBe(3);
  });

  it("accepts a valid allowlisted Minecraft profile tree", () => {
    const directory = profile();
    fs.mkdirSync(path.join(directory, "plugins", "Example"), { recursive: true });
    fs.mkdirSync(path.join(directory, "datapacks", "example", "data", "example", "function"), { recursive: true });
    fs.writeFileSync(path.join(directory, "plugins", "Example", "config.yml"), "enabled: true\n");
    fs.writeFileSync(
      path.join(directory, "datapacks", "example", "pack.mcmeta"),
      '{"pack":{"pack_format":48,"description":"Example"}}\n'
    );
    fs.writeFileSync(
      path.join(directory, "datapacks", "example", "data", "example", "function", "start.mcfunction"),
      "say hello\n"
    );
    expect(validateServerProfile(directory).fileCount).toBe(5);
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

  it("rejects FIFO/device-like entries before packaging", () => {
    const directory = profile();
    const fifo = path.join(directory, "config");
    fs.mkdirSync(fifo);
    const pipe = path.join(fifo, "pipe.txt");
    execFileSync("mkfifo", [pipe]);
    expect(() => validateServerProfile(directory)).toThrow("regular files or directories");
  });

  it("rejects non-Minecraft profile paths and extensions", () => {
    const directory = profile();
    fs.writeFileSync(path.join(directory, "unreviewed.bin"), "data");
    expect(() => validateServerProfile(directory)).toThrow("allowlisted Minecraft path");
    fs.rmSync(path.join(directory, "unreviewed.bin"));
    fs.mkdirSync(path.join(directory, "config"));
    fs.writeFileSync(path.join(directory, "config", "unreviewed.bin"), "data");
    expect(() => validateServerProfile(directory)).toThrow("extension is not allowlisted");
  });

  it("scans complete files for credential signatures", () => {
    const directory = profile();
    fs.mkdirSync(path.join(directory, "config"));
    fs.writeFileSync(
      path.join(directory, "config", "late-secret.txt"),
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
    ["non-JAR provenance URL", { ...plugin, url: "https://plugins.example.org/releases/example.zip" }],
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
