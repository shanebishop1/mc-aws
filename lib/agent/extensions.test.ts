import { readFileSync } from "node:fs";
import path from "node:path";
import type { AgentExtensionBundle } from "@/lib/agent/contracts";
import { computeExtensionIntegrity, loadAgentExtensionRegistry } from "@/lib/agent/extensions";
import { applyTrustedAfterInvocationHooks } from "@/lib/agent/hooks";
import { describe, expect, it } from "vitest";

function sample(): AgentExtensionBundle {
  return JSON.parse(
    readFileSync(path.join(process.cwd(), "examples/agent-extensions/status-report/extension.json"), "utf8")
  );
}

async function withIntegrity(bundle: AgentExtensionBundle): Promise<AgentExtensionBundle> {
  const integrity = await computeExtensionIntegrity(bundle);
  bundle.provenance.integrity = integrity;
  for (const skill of bundle.skills) skill.provenance.integrity = integrity;
  return bundle;
}

describe("public agent extension registry", () => {
  it("loads the schema-v1 example through the public registry in deterministic order", async () => {
    const example = sample();
    const other = structuredClone(example);
    other.extensionId = "mc-aws.example.alpha";
    other.tools[0].toolId = "example.alpha.read";
    other.skills[0].skillId = "mc-aws.example.alpha";
    other.skills[0].requestedTools = ["example.alpha.read"];
    other.hooks[0].hookId = "mc-aws.example.alpha.evidence";
    const registry = await loadAgentExtensionRegistry([example, await withIntegrity(other)]);

    expect(registry.bundles.map((bundle) => bundle.extensionId)).toEqual([
      "mc-aws.example.alpha",
      "mc-aws.example.status-report",
    ]);
    expect(registry.tools.map((tool) => tool.toolId)).toEqual(["example.alpha.read", "example.status-report.read"]);
    expect(registry.skills[1]?.resources).toEqual(["SKILL.md"]);
    expect(registry.hooks.map((hook) => hook.hookId)).toEqual([
      "mc-aws.example.alpha.evidence",
      "mc-aws.example.status-report.evidence",
    ]);
  });

  it("rejects duplicate IDs, version drift, untrusted or altered provenance, and executable callbacks", async () => {
    const example = sample();
    await expect(loadAgentExtensionRegistry([example, example])).rejects.toThrow("duplicate identifier");
    await expect(loadAgentExtensionRegistry([{ ...example, schemaVersion: 2 }])).rejects.toThrow("must equal 1");
    await expect(
      loadAgentExtensionRegistry([await withIntegrity({ ...structuredClone(example), version: "next" })])
    ).rejects.toThrow("invalid format");
    await expect(
      loadAgentExtensionRegistry([
        await withIntegrity({
          ...structuredClone(example),
          provenance: { ...example.provenance, source: "third-party" },
          skills: example.skills.map((skill) => ({
            ...skill,
            provenance: { ...skill.provenance, source: "third-party" },
          })),
        }),
      ])
    ).rejects.toThrow("not explicitly trusted");
    await expect(loadAgentExtensionRegistry([{ ...example, version: "1.0.1" }])).rejects.toThrow("integrity mismatch");
    await expect(loadAgentExtensionRegistry([{ ...example, callback: () => undefined }])).rejects.toThrow(
      "unknown field"
    );
  });

  it("cannot request immutable boundaries or provider credentials", async () => {
    const example = sample();
    await expect(
      loadAgentExtensionRegistry([{ ...example, immutableBoundary: { requestsRoot: true } }])
    ).rejects.toThrow("unknown field");
    await expect(
      loadAgentExtensionRegistry([{ ...example, providerCredentialRef: "secret-ref:providers/production" }])
    ).rejects.toThrow("unknown field");
    await expect(
      loadAgentExtensionRegistry([
        {
          ...example,
          tools: [
            {
              ...example.tools[0],
              inputSchema: { type: "object", properties: { apiKey: { type: "string" } } },
            },
          ],
        },
      ])
    ).rejects.toThrow("raw credential fields are forbidden");
  });

  it("omits only contract provenance digests and binds arbitrary nested integrity fields", async () => {
    const first = sample();
    first.tools[0].inputSchema = {
      type: "object",
      properties: { checksum: { type: "string", integrity: "sha256:first" } },
    };
    const second = structuredClone(first);
    (second.tools[0].inputSchema.properties as Record<string, Record<string, string>>).checksum.integrity =
      "sha256:second";

    expect(await computeExtensionIntegrity(first)).not.toBe(await computeExtensionIntegrity(second));

    const reviewed = await withIntegrity(first);
    const altered = structuredClone(reviewed);
    (altered.tools[0].inputSchema.properties as Record<string, Record<string, string>>).checksum.integrity =
      "sha256:tampered";
    await expect(loadAgentExtensionRegistry([altered])).rejects.toThrow("integrity mismatch");
  });

  it("resolves the reviewed read hook without importing or executing bundle code", async () => {
    const registry = await loadAgentExtensionRegistry([sample()]);
    const result = applyTrustedAfterInvocationHooks(
      registry.hooks,
      {
        schemaVersion: 1,
        invocationId: "invocation-read",
        sessionId: "session-read",
        toolId: "example.status-report.read",
        capability: "workspace.read",
        targetScope: { schemaVersion: 1, kind: "workspace", normalizedTarget: "status.txt" },
        arguments: { path: "status.txt" },
        requestedAt: "2026-09-02T12:00:00.000Z",
      },
      {
        schemaVersion: 1,
        invocationId: "invocation-read",
        status: "succeeded",
        completedAt: "2026-09-02T12:00:00.000Z",
        summary: "Read a workspace file.",
        output: { content: "ok" },
        evidence: [],
      }
    );
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.description).toContain("Trusted extension hook");
  });
});
