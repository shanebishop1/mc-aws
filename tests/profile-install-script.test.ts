import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = path.resolve(process.cwd(), "infra/src/ec2/mc-profile-install.sh");
const script = readFileSync(scriptPath, "utf8");

function embeddedPython(pattern: RegExp): string {
  const match = script.match(pattern);
  if (!match?.[1]) throw new Error("Could not locate the embedded release inventory contract");
  return match[1];
}

function releaseFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "mc-profile-contract-"));
  const manifest = path.join(root, "release-manifest.json");
  const inventory = path.join(root, "release-members");
  mkdirSync(inventory);
  const files = Array.from({ length: 23 }, (_, index) => ({
    destination: path.join(root, `member-${index}`),
  }));
  writeFileSync(manifest, JSON.stringify({ files }));
  return { root, manifest, inventory, files };
}

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
    expect(script).toContain(
      'expected_keys = {"uri", "sha256", "bytes", "releaseManifestSha256", "releaseManifestBytes"}'
    );
    expect(script).toContain('{"uri", "sha256", "fileCount", "totalBytes", "plugins"}');
    expect(script).toContain("profile archive count or expanded byte evidence mismatch");
    expect(script).toContain("profile plugin inventory does not match published evidence");
    expect(script).toContain('local kind="$1" uri="$2" expected_hash="$3"');
    expect(script).toContain('aws s3 cp --only-show-errors "$release_uri" "$work/host-release.zip"');
    expect(script).toContain('download_and_extract profile "$profile_uri" "$profile_hash"');
    expect(script).toContain('printf \'%s  %s\\n\' "$expected_hash" "$archive"');
    expect(script).toContain('sha256sum --check --status || fail "$kind asset archive checksum mismatch"');
    expect(script).toContain("release manifest digest or size mismatch");
    expect(script).not.toContain('"${kind}_hash"');
    expect(script).not.toContain('item["hash"] not in item["uri"]');
  });

  it("verifies the complete canonical bootstrap pin manifest before profile activation", () => {
    expect(script).toContain("--bootstrap-pins-sha256");
    expect(script).toContain('bootstrap["sha256"] != sys.argv[2]');
    expect(script).toContain('required={"paper","rclone","nodeArm64","mcstatus","asyncioDgram","dnspython"}');
    expect(script).toContain("MC_VERSION and Paper bootstrap pin do not match");
  });

  it("installs the graceful stop helper with the runtime scripts", () => {
    expect(script).toContain("mc-stop.sh");
    expect(script).toContain("mc-agent-install.sh");
    expect(script).toContain("mc-agent-gateway.service");
    expect(script).toContain("mc-agent-executor.service");
    expect(script).toContain("mc-agent-executor.socket");
    expect(script).toContain("mc-agent-world-roots.py");
    expect(script).toContain("replace_release_file");
    expect(script).toContain("mc-host-operation.py 0750");
    expect(script).toContain('rm -f -- "$destination"');
    expect(script).toContain("mc-backup-auth.py");
    expect(script).toContain("systemctl enable minecraft.service minecraft-dns.service");
    expect(script).toContain(
      "systemctl enable mc-agent-executor.socket mc-agent-gateway.service mc-agent-executor.service"
    );
    expect(script).toContain('MC_AGENT_ENABLE="$ENABLE_AGENT" python3');
    expect(script).toContain("enabled gateway configuration contains a packaged placeholder");
    expect(script).not.toContain("render_enabled_agent_config");
  });

  it("reconciles one canonical world-root source after profile application and verifies before service start", () => {
    expect(script).not.toContain(
      'install -o root -g root -m 0644 "$SETUP_ROOT/runtime/mc-agent-executor.json" /etc/mc-agent/executor.json'
    );
    expect(script).toContain('WORLD_ROOTS_HELPER="${MC_WORLD_ROOTS_HELPER:-/usr/local/bin/mc-agent-world-roots.py}"');
    expect(script).toContain('"$WORLD_ROOTS_HELPER" reconcile');
    expect(script).toContain('"$WORLD_ROOTS_HELPER" verify');
    expect(script.indexOf('"$WORLD_ROOTS_HELPER" reconcile')).toBeGreaterThan(
      script.indexOf("for root, directories, files in os.walk")
    );
    expect(script.indexOf('"$WORLD_ROOTS_HELPER" verify')).toBeLessThan(script.indexOf("systemctl daemon-reload"));
    expect(script.indexOf('"$WORLD_ROOTS_HELPER" verify')).toBeLessThan(
      script.indexOf("systemctl start minecraft.service")
    );
    expect(script).toContain("previous-server.properties");
    expect(script).toContain("--previous-server-properties");
    expect(script).toContain("executor world-root verifier staging failed");
    expect(script).toContain("SERVER_PROPERTIES_TRANSACTION_STARTED=1");
    expect(script).toContain("restore_server_properties_transaction");
    expect(script).toContain("restore_world_root_transaction");
    expect(script).toContain('WORLD_ROOT_GENERATION_BEFORE="$($WORLD_ROOTS_HELPER inspect --output generation)"');
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

  it("supports a restore-only staging target without starting or enabling services", () => {
    expect(script).toContain("--restore-staging <staged-server-root>");
    expect(script).toContain("RESTORE_STAGING=1");
    expect(script).toContain('SERVER_ROOT="$2"');
    expect(script).toContain("if (( RESTORE_STAGING == 0 )); then");
    expect(script.indexOf('SERVER_ROOT="$2"')).toBeLessThan(script.indexOf("for root, directories, files in os.walk"));
    expect(script).toContain('profile_source="$work/profile"');
    const globalActivation = script.search(/if \(\( RESTORE_STAGING == 0 \)\); then\n\s+install -d/);
    expect(globalActivation).toBeGreaterThan(-1);
    expect(script.indexOf("provision_executor_credentials")).toBeLessThan(globalActivation);
  });

  it("extends the attempt journal before activation with profile, plugin, setup, config, and runtime-link paths", () => {
    expect(script).toContain("MC_RELEASE_JOURNAL_ROOT");
    expect(script).toContain("--recursive /opt/setup --recursive /etc/mc-agent");
    expect(script).toContain('server / "plugins" / plugin["destination"]');
    expect(script).toContain('"/opt/mc-agent/runtime-previous"');
    expect(script.indexOf("release-journal-paths.json")).toBeLessThan(
      script.indexOf("\nprovision_executor_credentials\n")
    );
    expect(script).toContain('--recursive "$SERVER_ROOT/plugins"');
    expect(script).toContain('paths.add(str(server / "server.properties"))');
  });

  it("removes unreviewed plugin JARs while preserving explicitly allowed non-JAR data", () => {
    const python = embeddedPython(/python3 - "\$SERVER_ROOT" "\$plugin_list" <<'PY'\n([\s\S]*?)\nPY/);
    const root = mkdtempSync(path.join(tmpdir(), "mc-plugin-reconcile-"));
    const server = path.join(root, "server");
    const plugins = path.join(server, "plugins");
    const lock = path.join(root, "plugins.tsv");
    mkdirSync(plugins, { recursive: true });
    writeFileSync(path.join(plugins, "Reviewed.jar"), "reviewed");
    writeFileSync(path.join(plugins, "revoked.jar"), "revoked");
    mkdirSync(path.join(plugins, "data"));
    writeFileSync(path.join(plugins, "data", "config.yml"), "keep");
    writeFileSync(path.join(plugins, "data", "nested.jar"), "remove");
    writeFileSync(lock, `Reviewed\tReviewed.jar\thttps://example.invalid/Reviewed.jar\t${"a".repeat(64)}\n`);
    try {
      const result = spawnSync("python3", ["-c", python, server, lock], { encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(readdirSync(plugins).sort()).toEqual(["Reviewed.jar", "data"]);
      expect(readFileSync(path.join(plugins, "data", "config.yml"), "utf8")).toBe("keep");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records a complete rollback inventory before requiring any release member", () => {
    expect(script).toContain('release_members="$release_rollback/release-members"');
    expect(script).toContain(
      'install -o root -g root -m 0644 "$runtime_release/release-manifest.json" "$release_rollback/release-manifest.json"'
    );
    expect(script).toContain("len(expected) != len(items)");
    expect(script).toContain('"$ROLLBACK_FROM/release-manifest.json" "$ROLLBACK_FROM/release-members"');
    expect(script).not.toContain("len(os.listdir(backup)) < len(items)");
  });

  it("makes deferred mode validation-only and requires exact quiescence for activation", () => {
    const deferredCandidate = script.indexOf('SERVER_ROOT="$work/deferred-candidate/server"');
    const globalGuard = script.indexOf("if (( RESTORE_STAGING == 0 )); then", deferredCandidate);
    expect(deferredCandidate).toBeGreaterThan(script.indexOf("download_and_extract profile"));
    expect(script.indexOf("RESTORE_STAGING=1", deferredCandidate)).toBeLessThan(globalGuard);
    expect(script).toContain("without mutating live host destinations");
    expect(script).toContain("--activate-quiesced");
    expect(script).toContain("quiesced activation requires an exact maintenance owner");
    expect(script).toContain("quiesced activation requires $unit to be inactive");
    expect(script).toContain("quiesced activation requires $unit to be masked");
    expect(script).toContain("ACTIVATE_QUIESCED == 0");
  });

  it("confines restore staging beneath its trusted parent and rejects the live server root", () => {
    expect(script).toContain("trusted not in resolved.parents");
    expect(script).toContain('resolved == pathlib.Path("/opt/minecraft/server")');
    expect(script).toContain("restore staging root has a symlinked ancestor");
    const globalMutation = script.indexOf('install -d -o root -g root -m 0755 "$SETUP_ROOT"');
    const globalGuard = script.lastIndexOf("if (( RESTORE_STAGING == 0 )); then", globalMutation);
    expect(globalGuard).toBeGreaterThan(-1);
    expect(globalGuard).toBeLessThan(globalMutation);
  });

  it("executes a complete manifest-driven fresh-install rollback inventory", () => {
    const fixture = releaseFixture();
    try {
      const result = spawnSync(
        "python3",
        [
          "-c",
          embeddedPython(
            /python3 - "\$runtime_release\/release-manifest\.json" "\$release_members" <<'PY'\n([\s\S]*?)\nPY/
          ),
          fixture.manifest,
          fixture.inventory,
        ],
        { encoding: "utf8" }
      );
      expect(result.status).toBe(0);
      expect(readdirSync(fixture.inventory).sort()).toEqual(
        Array.from({ length: 23 }, (_, index) => `${index}.missing`).sort()
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("executes existing-host success capture and partial-activation rollback for every member", () => {
    const fixture = releaseFixture();
    try {
      for (const [index, file] of fixture.files.entries()) writeFileSync(file.destination, `old-${index}`);
      const capture = spawnSync(
        "python3",
        [
          "-c",
          embeddedPython(
            /python3 - "\$runtime_release\/release-manifest\.json" "\$release_members" <<'PY'\n([\s\S]*?)\nPY/
          ),
          fixture.manifest,
          fixture.inventory,
        ],
        { encoding: "utf8" }
      );
      expect(capture.status).toBe(0);
      for (const [index, file] of fixture.files.entries()) writeFileSync(file.destination, `new-${index}`);
      const rollback = embeddedPython(
        /python3 - "\$release_rollback\/release-manifest\.json" "\$release_rollback\/release-members" <<'PY' \|\| true\n([\s\S]*?)\nPY/
      );
      const restored = spawnSync("python3", ["-c", rollback, fixture.manifest, fixture.inventory], {
        encoding: "utf8",
      });
      expect(restored.status).toBe(0);
      for (const [index, file] of fixture.files.entries())
        expect(readFileSync(file.destination, "utf8")).toBe(`old-${index}`);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
