import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = process.cwd();
const helper = path.join(root, "infra/src/ec2/mc-agent-world-roots.py");
const gatewayTemplate = path.join(root, "infra/src/ec2/mc-agent-gateway.json");
const executorTemplate = path.join(root, "infra/src/ec2/mc-agent-executor.json");
const temporaryRoots: string[] = [];

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "mc-agent-world-roots-"));
  temporaryRoots.push(directory);
  return {
    directory,
    gateway: path.join(directory, "gateway.json"),
    executor: path.join(directory, "executor.json"),
    roots: path.join(directory, "world-roots.json"),
    properties: path.join(directory, "server.properties"),
  };
}

function args(value: ReturnType<typeof fixture>) {
  return [
    helper,
    "reconcile",
    "--gateway-template",
    gatewayTemplate,
    "--executor-template",
    executorTemplate,
    "--gateway-config",
    value.gateway,
    "--executor-config",
    value.executor,
    "--roots-config",
    value.roots,
    "--server-properties",
    value.properties,
  ];
}

function config(file: string) {
  return JSON.parse(readFileSync(file, "utf8")) as { persistentWorldRoots: string[] };
}

function currentConfig(value: ReturnType<typeof fixture>, name: string) {
  return config(path.join(value.directory, "world-roots-current", name));
}

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("persistent world-root host reconciliation", () => {
  it("preserves a valid custom gateway level and all survival dimensions", () => {
    const value = fixture();
    const gateway = JSON.parse(readFileSync(gatewayTemplate, "utf8"));
    gateway.controlBaseUrl = "https://operator.example";
    gateway.persistentWorldRoots = ["survival", "survival_nether", "survival_the_end"];
    writeFileSync(value.gateway, JSON.stringify(gateway));

    execFileSync("python3", args(value));

    const expected = ["survival", "survival_nether", "survival_the_end"];
    expect(currentConfig(value, "gateway.json").persistentWorldRoots).toEqual(expected);
    expect(currentConfig(value, "executor.json").persistentWorldRoots).toEqual(expected);
    expect(currentConfig(value, "world-roots.json").persistentWorldRoots).toEqual(expected);
    expect(
      JSON.parse(readFileSync(path.join(value.directory, "world-roots-current", "gateway.json"), "utf8")).controlBaseUrl
    ).toBe("https://operator.example");
  });

  it("derives identical default roots when no explicit or installed config exists", () => {
    const value = fixture();
    execFileSync("python3", args(value));
    const expected = ["world", "world_nether", "world_the_end"];
    expect(currentConfig(value, "gateway.json").persistentWorldRoots).toEqual(expected);
    expect(currentConfig(value, "executor.json").persistentWorldRoots).toEqual(expected);
  });

  it("derives and preserves every survival dimension from level-name", () => {
    const value = fixture();
    writeFileSync(value.properties, "motd=Example\nlevel-name=survival\nonline-mode=true\n");

    execFileSync("python3", args(value));

    const expected = ["survival", "survival_nether", "survival_the_end"];
    expect(currentConfig(value, "world-roots.json").persistentWorldRoots).toEqual(expected);
    expect(currentConfig(value, "gateway.json").persistentWorldRoots).toEqual(expected);
    expect(currentConfig(value, "executor.json").persistentWorldRoots).toEqual(expected);
  });

  it.each([
    ["colon separator", "level-name:colon-world", "colon-world"],
    ["unescaped whitespace separator", "level-name whitespace-world", "whitespace-world"],
    ["escaped value whitespace", "level-name=space\\ world", "space world"],
    ["continued value", "level-name=continued\\\n-world", "continued-world"],
    ["CR physical line", "motd=Example\rlevel-name=cr-world", "cr-world"],
    ["CRLF physical line", "motd=Example\r\nlevel-name=crlf-world", "crlf-world"],
  ])("parses Java properties %s", (_description, property, levelName) => {
    const value = fixture();
    writeFileSync(value.properties, `${property}\nmotd=Example\n`);

    execFileSync("python3", args(value));

    expect(currentConfig(value, "world-roots.json").persistentWorldRoots).toEqual([
      levelName,
      `${levelName}_nether`,
      `${levelName}_the_end`,
    ]);
  });

  it.each([
    ["form feed", "\f"],
    ["vertical tab", "\v"],
    ["NEL", "\u0085"],
    ["line separator", "\u2028"],
    ["paragraph separator", "\u2029"],
  ])("does not treat %s as a Java Properties physical line ending", (_description, separator) => {
    const value = fixture();
    const expected = `first${separator}level-name=second`;
    writeFileSync(value.properties, `level-name=${expected}\n`);

    execFileSync("python3", args(value));

    expect(currentConfig(value, "world-roots.json").persistentWorldRoots).toEqual([
      expected,
      `${expected}_nether`,
      `${expected}_the_end`,
    ]);
  });

  it("uses the last value for duplicate keys like java.util.Properties", () => {
    const value = fixture();
    writeFileSync(value.properties, "level-name=first\nlevel-name=second\n");

    execFileSync("python3", args(value));

    expect(currentConfig(value, "world-roots.json").persistentWorldRoots).toEqual([
      "second",
      "second_nether",
      "second_the_end",
    ]);
  });

  it("rejects malformed Java property escapes instead of falling back to world", () => {
    const value = fixture();
    writeFileSync(value.properties, "level-name=bad\\u12G4\n");

    expect(spawnSync("python3", args(value)).status).toBe(1);
  });

  it("keeps reviewed additions while replacing generated dimensions after a level transition", () => {
    const value = fixture();
    writeFileSync(value.properties, "level-name=old-world\n");
    const initial = JSON.parse(readFileSync(gatewayTemplate, "utf8"));
    initial.persistentWorldRoots = ["old-world", "old-world_nether", "old-world_the_end", "reviewed/custom"];
    writeFileSync(value.gateway, JSON.stringify(initial));
    execFileSync("python3", args(value));

    writeFileSync(`${value.directory}/previous.properties`, "level-name=old-world\n");
    writeFileSync(value.properties, "level-name=new-world\n");
    execFileSync("python3", [...args(value), "--previous-server-properties", `${value.directory}/previous.properties`]);

    expect(currentConfig(value, "world-roots.json").persistentWorldRoots).toEqual([
      "new-world",
      "new-world_nether",
      "new-world_the_end",
      "reviewed/custom",
    ]);
  });

  it("publishes a new generation when the profile level-name changes instead of retaining stale roots", () => {
    const value = fixture();
    execFileSync("python3", args(value));
    const oldTarget = readlinkSync(path.join(value.directory, "world-roots-current"));
    writeFileSync(value.properties, "level-name=survival\n");

    execFileSync("python3", args(value));

    const newTarget = readlinkSync(path.join(value.directory, "world-roots-current"));
    expect(newTarget).not.toBe(oldTarget);
    expect(currentConfig(value, "world-roots.json").persistentWorldRoots).toEqual([
      "survival",
      "survival_nether",
      "survival_the_end",
    ]);
    expect(existsSync(path.join(value.directory, oldTarget))).toBe(true);
    expect(spawnSync("python3", [helper, "verify", "--roots-config", value.roots]).status).toBe(0);
  });

  it("commits a staged level-name and its derived generation together", () => {
    const value = fixture();
    writeFileSync(value.properties, "level-name=old-world\n");
    const previousMode = statSync(value.properties).mode & 0o777;
    execFileSync("python3", args(value));
    const oldTarget = readlinkSync(path.join(value.directory, "world-roots-current"));
    const staged = path.join(value.directory, "staged-server.properties");
    writeFileSync(staged, "level-name=new-world\n");

    execFileSync("python3", [
      helper,
      "transaction",
      "--gateway-template",
      gatewayTemplate,
      "--executor-template",
      executorTemplate,
      "--gateway-config",
      value.gateway,
      "--executor-config",
      value.executor,
      "--roots-config",
      value.roots,
      "--server-properties",
      value.properties,
      "--staged-server-properties",
      staged,
    ]);

    expect(readFileSync(value.properties, "utf8")).toBe("level-name=new-world\n");
    expect(statSync(value.properties).mode & 0o777).toBe(previousMode);
    expect(readlinkSync(path.join(value.directory, "world-roots-current"))).not.toBe(oldTarget);
    expect(currentConfig(value, "world-roots.json").persistentWorldRoots).toEqual([
      "new-world",
      "new-world_nether",
      "new-world_the_end",
    ]);
  });

  it("commits deletion of server.properties with the default root generation", () => {
    const value = fixture();
    writeFileSync(value.properties, "level-name=old-world\n");
    execFileSync("python3", args(value));

    execFileSync("python3", [
      helper,
      "transaction",
      "--gateway-template",
      gatewayTemplate,
      "--executor-template",
      executorTemplate,
      "--gateway-config",
      value.gateway,
      "--executor-config",
      value.executor,
      "--roots-config",
      value.roots,
      "--server-properties",
      value.properties,
      "--delete-server-properties",
    ]);

    expect(existsSync(value.properties)).toBe(false);
    expect(currentConfig(value, "world-roots.json").persistentWorldRoots).toEqual([
      "world",
      "world_nether",
      "world_the_end",
    ]);
  });

  it("restores both server.properties and the prior generation when publication fails", () => {
    const value = fixture();
    writeFileSync(value.properties, "level-name=old-world\n");
    execFileSync("python3", args(value));
    const oldTarget = readlinkSync(path.join(value.directory, "world-roots-current"));
    const staged = path.join(value.directory, "staged-server.properties");
    writeFileSync(staged, "level-name=new-world\n");
    const program = `
import importlib.util, pathlib, sys
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location("world_roots", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
real_publish = module.publish_generation
def publish_then_fail(arguments, values):
    real_publish(arguments, values)
    raise OSError("injected generation publication failure")
module.publish_generation = publish_then_fail
directory = pathlib.Path(sys.argv[2])
arguments = SimpleNamespace(
    roots_config=directory / "world-roots.json",
    gateway_config=directory / "gateway.json",
    executor_config=directory / "executor.json",
    gateway_template=pathlib.Path(sys.argv[3]),
    executor_template=pathlib.Path(sys.argv[4]),
    server_properties=directory / "server.properties",
    staged_server_properties=directory / "staged-server.properties",
    previous_server_properties=None,
    restored_roots_file=None,
    generation=None,
    generation_dir=None,
)
try:
    module.transaction(arguments)
except OSError:
    pass
else:
    raise SystemExit("transaction unexpectedly succeeded")
`;
    execFileSync("python3", ["-c", program, helper, value.directory, gatewayTemplate, executorTemplate]);

    expect(readFileSync(value.properties, "utf8")).toBe("level-name=old-world\n");
    expect(readlinkSync(path.join(value.directory, "world-roots-current"))).toBe(oldTarget);
    expect(spawnSync("python3", [helper, "verify", "--roots-config", value.roots]).status).toBe(0);
  });

  it("keeps a reviewed custom allowlist when a profile is reapplied without a level-name change", () => {
    const value = fixture();
    writeFileSync(value.properties, "level-name=survival\n");
    const initial = JSON.parse(readFileSync(gatewayTemplate, "utf8"));
    initial.persistentWorldRoots = ["reviewed", "reviewed_nether", "reviewed_the_end"];
    writeFileSync(value.gateway, JSON.stringify(initial));
    execFileSync("python3", args(value));
    writeFileSync(path.join(value.directory, "previous.properties"), "level-name=survival\n");

    execFileSync("python3", [
      helper,
      "reconcile",
      "--gateway-template",
      gatewayTemplate,
      "--executor-template",
      executorTemplate,
      "--gateway-config",
      value.gateway,
      "--executor-config",
      value.executor,
      "--roots-config",
      value.roots,
      "--server-properties",
      value.properties,
      "--previous-server-properties",
      path.join(value.directory, "previous.properties"),
    ]);
    expect(currentConfig(value, "world-roots.json").persistentWorldRoots).toEqual([
      "reviewed",
      "reviewed_nether",
      "reviewed_the_end",
    ]);
  });

  it("publishes authenticated restored custom roots and can reactivate the exact prior generation", () => {
    const value = fixture();
    execFileSync("python3", args(value));
    const priorGeneration = readlinkSync(path.join(value.directory, "world-roots-current")).split("/").at(-1)!;
    const restored = path.join(value.directory, "restored-world-roots.json");
    const customRoots = ["survival", "dimensions/nether", "dimensions/the-end"];
    writeFileSync(restored, JSON.stringify({ schemaVersion: 1, persistentWorldRoots: customRoots }));

    execFileSync("python3", [...args(value), "--restored-roots-file", restored]);
    const inspected = JSON.parse(
      execFileSync("python3", [helper, "inspect", "--output", "roots-json", "--roots-config", value.roots], {
        encoding: "utf8",
      })
    );
    expect(inspected.persistentWorldRoots).toEqual(customRoots);

    execFileSync("python3", [helper, "activate", "--generation", priorGeneration, "--roots-config", value.roots]);
    expect(readlinkSync(path.join(value.directory, "world-roots-current"))).toBe(
      `world-roots-generations/${priorGeneration}`
    );
    expect(currentConfig(value, "world-roots.json").persistentWorldRoots).toEqual([
      "world",
      "world_nether",
      "world_the_end",
    ]);
  });

  it("preserves exact authenticated restored custom roots across a cross-level profile overlay", () => {
    const value = fixture();
    writeFileSync(value.properties, "level-name=old-world\n");
    execFileSync("python3", args(value));
    const previous = path.join(value.directory, "previous.properties");
    writeFileSync(previous, "level-name=old-world\n");
    writeFileSync(value.properties, "level-name=new-world\n");
    const restored = path.join(value.directory, "restored-world-roots.json");
    const customRoots = ["custom/overworld", "custom/nether", "custom/end"];
    writeFileSync(restored, JSON.stringify({ schemaVersion: 1, persistentWorldRoots: customRoots }));

    execFileSync("python3", [
      ...args(value),
      "--restored-roots-file",
      restored,
      "--previous-server-properties",
      previous,
    ]);

    expect(currentConfig(value, "world-roots.json").persistentWorldRoots).toEqual(customRoots);
  });

  it("fails closed on an installed gateway/executor mismatch and leaves both unchanged", () => {
    const value = fixture();
    const gateway = readFileSync(gatewayTemplate, "utf8").replaceAll('"world"', '"survival"');
    const executor = readFileSync(executorTemplate, "utf8");
    writeFileSync(value.gateway, gateway);
    writeFileSync(value.executor, executor);

    const result = spawnSync("python3", args(value), { encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/mismatch/);
    expect(readFileSync(value.gateway, "utf8")).toBe(gateway);
    expect(readFileSync(value.executor, "utf8")).toBe(executor);
  });

  it.each([{ roots: ["../world"] }, { roots: ["/world"] }, { roots: ["world", "world"] }, { roots: [] }])(
    "rejects malformed canonical roots without replacing installed configs: $roots",
    ({ roots }) => {
      const value = fixture();
      const gateway = readFileSync(gatewayTemplate, "utf8");
      const executor = readFileSync(executorTemplate, "utf8");
      writeFileSync(value.gateway, gateway);
      writeFileSync(value.executor, executor);
      writeFileSync(value.roots, JSON.stringify({ schemaVersion: 1, persistentWorldRoots: roots }));

      expect(spawnSync("python3", args(value)).status).toBe(1);
      expect(readFileSync(value.gateway, "utf8")).toBe(gateway);
      expect(readFileSync(value.executor, "utf8")).toBe(executor);
    }
  );

  it.each([1, 2])("leaves a complete old generation when publication crashes at rename %s", (failure) => {
    const value = fixture();
    execFileSync("python3", args(value));
    const oldTarget = readlinkSync(path.join(value.directory, "world-roots-current"));
    const program = `
import importlib.util, pathlib, sys
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location("world_roots", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
real_replace = module.os.replace
directory = pathlib.Path(sys.argv[2])
real_replace = module.os.replace
calls = 0
def fail_at(source, destination):
    global calls
    calls += 1
    if calls == int(sys.argv[3]):
        raise OSError("injected replacement failure")
    real_replace(source, destination)
module.os.replace = fail_at
gateway = __import__("json").load(open(sys.argv[4]))
executor = __import__("json").load(open(sys.argv[5]))
values = {"world-roots.json": {"schemaVersion": 1, "persistentWorldRoots": ["survival", "survival_nether", "survival_the_end"]}, "gateway.json": gateway, "executor.json": executor}
values["gateway.json"]["persistentWorldRoots"] = values["world-roots.json"]["persistentWorldRoots"]
values["executor.json"]["persistentWorldRoots"] = values["world-roots.json"]["persistentWorldRoots"]
arguments = SimpleNamespace(roots_config=directory / "world-roots.json", gateway_config=directory / "gateway.json", executor_config=directory / "executor.json")
try:
    module.publish_generation(arguments, values)
except OSError:
    pass
else:
    raise SystemExit("replacement unexpectedly succeeded")
`;

    execFileSync(
      "python3",
      ["-c", program, helper, value.directory, String(failure), gatewayTemplate, executorTemplate],
      {
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      }
    );

    expect(readlinkSync(path.join(value.directory, "world-roots-current"))).toBe(oldTarget);
    expect(spawnSync("python3", [helper, "verify", "--roots-config", value.roots]).status).toBe(0);
  });

  it("fails closed for an incomplete, missing, or digest-mismatched active generation", () => {
    const value = fixture();
    execFileSync("python3", args(value));
    const current = path.join(value.directory, "world-roots-current");
    const generation = path.join(value.directory, readlinkSync(current));
    writeFileSync(path.join(generation, "gateway.json"), "{}\n");
    expect(spawnSync("python3", [helper, "verify", "--roots-config", value.roots]).status).toBe(1);
    expect((statSync(path.join(value.directory, "world-roots-generations")).mode & 0o777).toString(8)).toBe("755");
    rmSync(generation, { recursive: true, force: true });
    expect(spawnSync("python3", [helper, "verify", "--roots-config", value.roots]).status).toBe(1);
    rmSync(current);
    expect(existsSync(current)).toBe(false);
    expect(spawnSync("python3", [helper, "verify", "--roots-config", value.roots]).status).toBe(1);
  });

  it("rejects activation of a stale generation identifier without changing current", () => {
    const value = fixture();
    execFileSync("python3", args(value));
    const current = path.join(value.directory, "world-roots-current");
    const prior = readlinkSync(current);

    const result = spawnSync("python3", [
      helper,
      "activate",
      "--generation",
      "c".repeat(64),
      "--roots-config",
      value.roots,
    ]);

    expect(result.status).toBe(1);
    expect(readlinkSync(current)).toBe(prior);
  });

  it("verifies the installed current-member path against its sibling generation layout", () => {
    const value = fixture();
    execFileSync("python3", args(value));
    expect(
      spawnSync("python3", [
        helper,
        "verify",
        "--roots-config",
        path.join(value.directory, "world-roots-current", "world-roots.json"),
      ]).status
    ).toBe(0);
  });
});
