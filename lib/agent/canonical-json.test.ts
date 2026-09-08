import { spawnSync } from "node:child_process";
import path from "node:path";
import { canonicalJson } from "@/lib/agent/canonical-json";
import { describe, expect, it } from "vitest";

describe("canonical JSON", () => {
  it("emits literal UTF-8 Unicode in JavaScript UTF-16 key order", () => {
    expect(
      canonicalJson({
        "\uE000": "private-use",
        "😀": "snow 雪",
        é: "café",
        "\u0001": "control",
      })
    ).toBe('{"\\u0001":"control","é":"café","😀":"snow 雪","":"private-use"}');
  });

  it("uses JSON.stringify number spellings", () => {
    expect(canonicalJson([-0, 1e-7, 1e-6, 1e20, 1e21])).toBe("[0,1e-7,0.000001,100000000000000000000,1e+21]");
  });

  it("rejects values that cannot have portable canonical UTF-8 bytes", () => {
    expect(() => canonicalJson("\ud800")).toThrow(/Unicode scalar/);
    expect(() => canonicalJson({ "\udfff": true })).toThrow(/Unicode scalar/);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
  });

  it("matches the root Python verifier for deterministic Unicode and floating-point property vectors", () => {
    let state = BigInt("0x9e3779b97f4a7c15");
    const view = new DataView(new ArrayBuffer(8));
    const numbers: number[] = [];
    while (numbers.length < 2_048) {
      state ^= state << BigInt(13);
      state ^= state >> BigInt(7);
      state ^= state << BigInt(17);
      state &= BigInt("0xffffffffffffffff");
      view.setBigUint64(0, state);
      const candidate = view.getFloat64(0);
      if (Number.isFinite(candidate)) numbers.push(candidate);
    }
    const vector = {
      "\uE000": "private-use",
      "😀": ["snow 雪", "café", "line\u2028separator", "paragraph\u2029separator"],
      numbers: [-0, 1e-7, 1e-6, 1e20, 1e21, ...numbers],
    };
    const expected = canonicalJson(vector);
    const helper = path.resolve(process.cwd(), "infra/src/ec2/mc-host-operation.py");
    const script = [
      "import importlib.util, json, pathlib, sys",
      "spec = importlib.util.spec_from_file_location('mc_host_operation', pathlib.Path(sys.argv[1]))",
      "module = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "sys.stdout.buffer.write(module.canonical(json.load(sys.stdin)))",
    ].join("\n");
    const result = spawnSync("python3", ["-c", script, helper], {
      input: expected,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(expected);
  });
});
