import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadInstalledAgentExtensionRegistry } from "./extensions";

describe("packaged data-only extension loading", () => {
  it("loads the reviewed bundle only from a protected installed source", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "mc-agent-extension-"));
    try {
      const bundle = JSON.parse(
        readFileSync(path.resolve(process.cwd(), "examples/agent-extensions/status-report/extension.json"), "utf8")
      ) as { provenance: { integrity: string }; skills: Array<{ provenance: { integrity: string } }> };
      expect(bundle.provenance.integrity).toMatch(/^sha256:[a-f0-9]{64}$/);
      mkdirSync(path.join(root, "extensions/status-report"), { recursive: true, mode: 0o755 });
      writeFileSync(path.join(root, "extensions/status-report/extension.json"), `${JSON.stringify(bundle)}\n`, {
        mode: 0o644,
      });
      chmodSync(root, 0o755);
      const registry = await loadInstalledAgentExtensionRegistry(
        { enabled: true, bundlePaths: ["extensions/status-report/extension.json"] },
        root
      );
      expect(registry.tools.map((tool) => tool.toolId)).toEqual(["example.status-report.read"]);
      expect(registry.hooks[0]?.handlerRef).toBe("mc-aws.record-read-evidence");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not read arbitrary workspace paths even when extension loading is enabled", async () => {
    await expect(
      loadInstalledAgentExtensionRegistry({ enabled: true, bundlePaths: ["workspace/extension.json"] }, "/tmp")
    ).rejects.toThrow(/protected installed source/i);
  });
});
