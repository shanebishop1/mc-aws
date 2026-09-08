import { networkDownloadApprovalScope, parseNetworkDownloadApprovalTarget } from "@/lib/agent/network-download";
import { agentSchemas } from "@/lib/agent/validators";
import { describe, expect, it } from "vitest";

function destination(normalizedTarget: string) {
  return { schemaVersion: 1 as const, kind: "workspace" as const, normalizedTarget };
}

const expectation = { expectedSha256: "a".repeat(64), expectedBytes: 10 };

describe("network download approval scope encoding", () => {
  it("cannot collide when distinct resource and destination values contain legacy delimiters", () => {
    const first = networkDownloadApprovalScope(
      "https://downloads.example.invalid/a|workspace:b",
      destination("c"),
      expectation
    );
    const second = networkDownloadApprovalScope(
      "https://downloads.example.invalid/a",
      destination("b|workspace:c"),
      expectation
    );

    expect(first.normalizedTarget).not.toBe(second.normalizedTarget);
    expect(parseNetworkDownloadApprovalTarget(first.normalizedTarget)).toMatchObject({
      resource: "https://downloads.example.invalid/a|workspace:b",
      destination: destination("c"),
      ...expectation,
    });
    expect(parseNetworkDownloadApprovalTarget(second.normalizedTarget)).toMatchObject({
      resource: "https://downloads.example.invalid/a",
      destination: destination("b|workspace:c"),
      ...expectation,
    });
  });

  it.each([
    "https://downloads.example.invalid/file.jar|workspace:plugins/file.jar",
    '{"resource":"https://downloads.example.invalid/file.jar","destination":{"schemaVersion":1,"kind":"workspace","normalizedTarget":"plugins/file.jar"},"schemaVersion":1,"type":"network-download"}',
    '{"destination":{"kind":"workspace","normalizedTarget":"../file.jar","schemaVersion":1},"expectedBytes":10,"expectedSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","resource":"https://downloads.example.invalid/file.jar","schemaVersion":1,"type":"network-download"}',
    '{"destination":{"kind":"workspace","normalizedTarget":"/workspace/file.jar","schemaVersion":1},"expectedBytes":10,"expectedSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","resource":"https://downloads.example.invalid/file.jar","schemaVersion":1,"type":"network-download"}',
    '{"destination":{"kind":"workspace","normalizedTarget":"plugins/file.jar","schemaVersion":1},"expectedBytes":10,"expectedSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","resource":"https://downloads.example.invalid/a/../file.jar","schemaVersion":1,"type":"network-download"}',
  ])("rejects non-canonical or invalid encoded target %s", (normalizedTarget) => {
    expect(() => agentSchemas.targetScope.parse({ schemaVersion: 1, kind: "network", normalizedTarget })).toThrow(
      /canonical network approval target/
    );
  });
});
