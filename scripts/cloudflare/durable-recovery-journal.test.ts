import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseDnsCreateResponse, parseRouteCreateResponse } from "./cloudflare-resource-reconciliation";
import { type DurableJournalOperation, durableRenameFile, durableReplaceFile } from "./durable-recovery-journal";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("durable Cloudflare recovery journal", () => {
  it.each<DurableJournalOperation>(["write-temp", "fsync-temp", "rename", "fsync-parent"])(
    "recovers a complete old or new record after power loss at %s",
    (failurePoint) => {
      const directory = mkdtempSync(path.join(tmpdir(), "mc-aws-durable-journal-"));
      temporaryDirectories.push(directory);
      const recordPath = path.join(directory, "recovery.json");
      durableReplaceFile(recordPath, '{"phase":"old"}\n');

      expect(() =>
        durableReplaceFile(recordPath, '{"phase":"new"}\n', {
          onOperation: (operation) => {
            if (operation === failurePoint) throw new Error(`simulated power loss at ${operation}`);
          },
        })
      ).toThrow(`simulated power loss at ${failurePoint}`);

      expect(["old", "new"]).toContain(JSON.parse(readFileSync(recordPath, "utf8")).phase);
      durableReplaceFile(recordPath, '{"phase":"recovered-forward"}\n');
      expect(JSON.parse(readFileSync(recordPath, "utf8"))).toEqual({ phase: "recovered-forward" });
      expect(readdirSync(directory).filter((entry) => entry.startsWith("recovery.json.tmp."))).toEqual([]);
    }
  );

  it.each<DurableJournalOperation>(["rename", "fsync-parent"])(
    "recovers a terminal journal after power loss during final %s",
    (failurePoint) => {
      const directory = mkdtempSync(path.join(tmpdir(), "mc-aws-durable-rename-"));
      temporaryDirectories.push(directory);
      const source = path.join(directory, "recovery.json");
      const history = `${source}.last`;
      durableReplaceFile(source, '{"status":"succeeded"}\n');

      expect(() =>
        durableRenameFile(source, history, {
          onOperation: (operation) => {
            if (operation === failurePoint) throw new Error(`simulated power loss at ${operation}`);
          },
        })
      ).toThrow(`simulated power loss at ${failurePoint}`);

      expect(readFileSync(history, "utf8")).toContain('"status":"succeeded"');
      expect(() => readFileSync(source, "utf8")).toThrow();
    }
  );

  it("reconciles exact provider IDs after a crash between provider commit and ID journaling", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mc-aws-create-intent-crash-"));
    temporaryDirectories.push(directory);
    const recordPath = path.join(directory, "recovery.json");
    const operationId = "11111111-2222-4333-8444-555555555555";
    const dns = {
      type: "A" as const,
      name: "panel.example.com",
      content: "192.0.2.1",
      ttl: 1,
      proxied: true,
      comment: `mc-aws-dns-operation:${operationId}`,
    };
    const route = { pattern: "panel.example.com/*", script: "mc-aws-panel" };
    durableReplaceFile(
      recordPath,
      `${JSON.stringify({ creationIntents: { dns: { operationId, ...dns }, route: { operationId, ...route } }, applied: {} })}\n`
    );

    expect(() =>
      parseDnsCreateResponse(JSON.stringify({ success: true, result: [{ id: "a".repeat(32), ...dns }] }), dns)
    ).toThrow("must be an object");
    expect(
      parseDnsCreateResponse(JSON.stringify({ success: true, result: { id: "a".repeat(32), ...dns } }), dns).id
    ).toBe("a".repeat(32));
    expect(
      parseRouteCreateResponse(JSON.stringify({ success: true, result: { id: "b".repeat(32), ...route } }), route).id
    ).toBe("b".repeat(32));
  });
});
