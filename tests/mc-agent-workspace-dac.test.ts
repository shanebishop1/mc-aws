import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = process.cwd();
const helper = path.join(root, "infra/src/ec2/mc-agent-workspace-dac.py");
const minecraftService = readFileSync(path.join(root, "infra/src/ec2/minecraft.service"), "utf8");
const executorService = readFileSync(path.join(root, "infra/src/ec2/mc-agent-executor.service"), "utf8");
const profileInstaller = readFileSync(path.join(root, "infra/src/ec2/mc-profile-install.sh"), "utf8");
const fixtures: string[] = [];

function runHelper(server: string, gidFile?: string) {
  const environment = {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV ?? "test",
    MC_AGENT_WORKSPACE: server,
  } as NodeJS.ProcessEnv & { MC_AGENT_WORKSPACE_GID_FILE?: string };
  if (gidFile) environment.MC_AGENT_WORKSPACE_GID_FILE = gidFile;
  else environment.MC_AGENT_WORKSPACE_GID_FILE = undefined;
  return spawnSync(
    "python3",
    [
      "-c",
      `import importlib.util
import os
os.geteuid = lambda: 0
spec = importlib.util.spec_from_file_location("workspace_dac", ${JSON.stringify(helper)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.reconcile()
`,
    ],
    { env: environment, encoding: "utf8" }
  );
}

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mc-workspace-dac-"));
  fixtures.push(directory);
  const server = path.join(directory, "server");
  const gidFile = path.join(directory, "workspace-gid");
  mkdirSync(path.join(server, "world", "region"), { recursive: true, mode: 0o755 });
  writeFileSync(path.join(server, "world", "region", "r.0.0.mca"), "region\n", { mode: 0o644 });
  writeFileSync(gidFile, `${process.getgid!()}\n`);
  chmodSync(gidFile, 0o444);
  return { directory, server, gidFile };
}

afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Minecraft workspace DAC reconciliation", () => {
  it("accepts normal nested ext4 directories, preserves uid, and grants controlled group access", () => {
    const value = fixture();
    const before = lstatSync(path.join(value.server, "world", "region", "r.0.0.mca"));
    const result = runHelper(value.server, value.gidFile);
    expect(result.status, result.stderr).toBe(0);

    const rootMode = lstatSync(value.server).mode & 0o7777;
    const nestedMode = lstatSync(path.join(value.server, "world")).mode & 0o7777;
    const file = lstatSync(path.join(value.server, "world", "region", "r.0.0.mca"));
    expect(rootMode & 0o2000).toBe(0o2000);
    expect(nestedMode & 0o2070).toBe(0o2070);
    expect(file.mode & 0o0060).toBe(0o0060);
    expect(file.uid).toBe(before.uid);
    expect(file.nlink).toBe(1);
  });

  it("supports group-writable files and setgid directories created after reconciliation", () => {
    const value = fixture();
    expect(runHelper(value.server, value.gidFile).status).toBe(0);
    const create = spawnSync(
      "python3",
      [
        "-c",
        `import os
os.umask(0o007)
os.mkdir(${JSON.stringify(path.join(value.server, "world", "new-dir"))}, 0o777)
open(${JSON.stringify(path.join(value.server, "world", "new-dir", "new-file"))}, "w", encoding="utf-8").write("new\\n")
`,
      ],
      { encoding: "utf8" }
    );
    expect(create.status, create.stderr).toBe(0);
    expect(lstatSync(path.join(value.server, "world", "new-dir")).mode & 0o2070).toBe(0o2070);
    expect(lstatSync(path.join(value.server, "world", "new-dir", "new-file")).mode & 0o0060).toBe(0o0060);
  });

  it("rejects a symlink without touching its outside target", () => {
    const value = fixture();
    const outside = path.join(value.directory, "outside.txt");
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, path.join(value.server, "0-outside"));
    const result = runHelper(value.server, value.gidFile);
    expect(result.status).not.toBe(0);
    expect(readFileSync(outside, "utf8")).toBe("outside\n");
  });

  it("rejects hard-linked regular files while allowing directory link counts above one", () => {
    const value = fixture();
    const hardlink = path.join(value.server, "0-hardlink");
    linkSync(path.join(value.server, "world", "region", "r.0.0.mca"), hardlink);
    const result = runHelper(value.server, value.gidFile);
    expect(result.status).not.toBe(0);
    expect(existsSync(hardlink)).toBe(true);
  });

  it("keeps legacy Minecraft startup optional and moves reconciliation out of the executor namespace", () => {
    expect(minecraftService.indexOf("ExecStartPre=+/bin/chown -R minecraft:minecraft")).toBeGreaterThanOrEqual(0);
    expect(minecraftService.indexOf("mc-agent-workspace-dac.py reconcile")).toBeGreaterThan(
      minecraftService.indexOf("ExecStartPre=+/bin/chown -R minecraft:minecraft")
    );
    expect(minecraftService).toContain("if [ ! -x /usr/local/bin/mc-agent-workspace-dac.py ]; then exit 0; fi");
    expect(minecraftService).toContain("UMask=0007");
    expect(executorService).not.toContain("mc-agent-workspace-dac.py reconcile");
    expect(profileInstaller).toContain("mc-agent-workspace-dac.py");
    expect(profileInstaller).toContain("/usr/local/bin/mc-agent-workspace-dac.py reconcile");
  });
});
