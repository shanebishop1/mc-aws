import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseJsoncObject, readWranglerConfig } from "./wrangler-config";

describe("shared Wrangler JSONC parser", () => {
  it("accepts comments and trailing commas without changing string content", () => {
    expect(
      parseJsoncObject(`{
        // line comment
        "name": "worker//literal",
        "vars": { "VALUE": "/* literal */", },
      }`)
    ).toEqual({ name: "worker//literal", vars: { VALUE: "/* literal */" } });
  });

  it("rejects malformed JSONC and non-object roots", () => {
    expect(() => parseJsoncObject('{ "name": }')).toThrow("Invalid JSONC");
    expect(() => parseJsoncObject("[]")).toThrow("root value");
  });

  it("parses the checked-in commented config through every project-owned parser path", () => {
    expect(readWranglerConfig("wrangler.jsonc").name).toBe("mc-aws-panel");
    expect(
      execFileSync("pnpm", ["exec", "tsx", "scripts/cloudflare/wrangler-config.ts", "worker-name", "wrangler.jsonc"], {
        encoding: "utf8",
      })
    ).toBe("mc-aws-panel");
    for (const file of [
      "scripts/cloudflare/deploy-cloudflare.sh",
      "scripts/cloudflare/rotate-worker-runtime-key.sh",
      "scripts/setup/setup-wizard.sh",
    ]) {
      expect(readFileSync(path.resolve(file), "utf8")).toContain("scripts/cloudflare/wrangler-config.ts worker-name");
    }
  });
});
