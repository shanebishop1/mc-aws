import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = path.resolve(process.cwd(), "infra/src/ec2/mc-profile-install.sh");
const script = readFileSync(scriptPath, "utf8");

describe("profile installer", () => {
  it("is valid Bash", () => {
    expect(spawnSync("bash", ["-n", scriptPath]).status).toBe(0);
  });

  it("hard-limits and verifies plugin downloads before checksumming", () => {
    expect(script).toContain("readonly MAX_PLUGIN_BYTES=$((32 * 1024 * 1024))");
    expect(script).toContain("ulimit -f");
    expect(script).toContain('--max-filesize "$MAX_PLUGIN_BYTES"');
    expect(script).toContain('[[ -f "$temporary" && ! -L "$temporary" ]]');
    expect(script).toContain('plugin_bytes="$(stat -c \'%s\' -- "$temporary")"');
    const pluginBlock = script.slice(script.indexOf('plugin_bytes="'));
    expect(pluginBlock.indexOf("plugin_bytes=")).toBeLessThan(pluginBlock.indexOf("sha256sum --check"));
  });

  it("checks downloaded asset archive bytes against the manifest digest", () => {
    expect(script).toContain('set(item) != {"uri", "sha256"}');
    expect(script).toContain('local kind="$1" uri="$2" expected_hash="$3"');
    expect(script).toContain('download_and_extract runtime "$runtime_uri" "$runtime_hash"');
    expect(script).toContain('download_and_extract profile "$profile_uri" "$profile_hash"');
    expect(script).toContain('printf \'%s  %s\\n\' "$expected_hash" "$archive"');
    expect(script).toContain('sha256sum --check --status || fail "$kind asset archive checksum mismatch"');
    expect(script).not.toContain('"${kind}_hash"');
    expect(script).not.toContain('item["hash"] not in item["uri"]');
  });

  it("installs the graceful stop helper with the runtime scripts", () => {
    expect(script).toContain("mc-stop.sh");
  });

  it("applies profile and plugin files through no-follow directory descriptors", () => {
    expect(script).toContain('directory_flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0)');
    expect(script).toContain("dir_fd=target_fd");
    expect(script).toContain("src_dir_fd=target_fd, dst_dir_fd=target_fd");
    expect(script).toContain('plugins_fd = os.open("plugins", directory_flags, dir_fd=server_fd)');
    expect(script).toContain("src_dir_fd=plugins_fd, dst_dir_fd=plugins_fd");
    expect(script).not.toContain('temporary="$SERVER_ROOT/plugins/');
    expect(script).not.toContain('chown -R minecraft:minecraft "$SERVER_ROOT"');
  });
});
