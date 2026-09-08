import { describe, expect, it } from "vitest";
import {
  parseDnsCreateResponse,
  parseRouteCreateResponse,
  reconcileDnsCreation,
  reconcileRouteCreation,
  uniqueDnsRecordAtName,
  uniqueRouteAtPattern,
  verifyDnsRecordResponse,
  verifyRouteResponse,
} from "./cloudflare-resource-reconciliation";

const id = "a".repeat(32);
const otherId = "b".repeat(32);
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
const envelope = (
  result: unknown,
  resultInfo: unknown = {
    page: 1,
    per_page: 100,
    total_pages: 1,
    count: Array.isArray(result) ? result.length : 0,
    total_count: Array.isArray(result) ? result.length : 0,
  }
): string => JSON.stringify({ success: true, result, result_info: resultInfo });

describe("strict Cloudflare response identity handling", () => {
  it("parses the exact returned DNS ID and requires canonical TTL", () => {
    const response = envelope({ id, ...dns });
    expect(parseDnsCreateResponse(response, dns)).toEqual({ id, ...dns });
    expect(verifyDnsRecordResponse(response, { id, ...dns })).toEqual({ id, ...dns });
    expect(() => parseDnsCreateResponse(envelope({ id, ...dns, ttl: 60 }), dns)).toThrow("complete request identity");
    expect(() => parseDnsCreateResponse(envelope([{ id, ...dns }]), dns)).toThrow("must be an object");
  });

  it("parses exact returned route IDs and rejects list/object shape confusion", () => {
    const response = envelope({ id, ...route });
    expect(parseRouteCreateResponse(response, route)).toEqual({ id, ...route });
    expect(verifyRouteResponse(response, { id, ...route })).toEqual({ id, ...route });
    expect(() => parseRouteCreateResponse(envelope([{ id, ...route }]), route)).toThrow("must be an object");
    expect(() => verifyRouteResponse(envelope({ id: otherId, ...route }), { id, ...route })).toThrow(
      "exact journaled identity"
    );
  });

  it("requires a complete single-page list before claiming uniqueness", () => {
    expect(
      uniqueDnsRecordAtName(
        envelope([{ id, ...dns }], { page: 1, per_page: 100, total_pages: 1, count: 1, total_count: 1 }),
        dns.name
      )
    ).toEqual({
      id,
      ...dns,
    });
    expect(() =>
      uniqueDnsRecordAtName(envelope([{ id, ...dns }], { page: 1, per_page: 1, total_pages: 2 }), dns.name)
    ).toThrow("complete single-page");
    expect(() => uniqueRouteAtPattern(envelope({ id, ...route }), route.pattern)).toThrow("must be an array");
    expect(() => uniqueDnsRecordAtName(JSON.stringify({ success: true, result: [] }), dns.name)).toThrow(
      "pagination metadata"
    );
    expect(() =>
      uniqueDnsRecordAtName(envelope([{ id, ...dns }], { page: 2, per_page: 100, total_pages: 2 }), dns.name)
    ).toThrow("complete single-page");
    expect(
      uniqueRouteAtPattern(
        envelope([], { page: 1, per_page: 100, total_pages: 1, count: 0, total_count: 0 }),
        route.pattern
      )
    ).toBeUndefined();
  });

  it("hard-stops response-loss reconciliation instead of adopting mutable copied identity", () => {
    expect(() => reconcileDnsCreation()).toThrow("no immutable provider ID");
    expect(() => reconcileRouteCreation()).toThrow("no immutable provider ID");
    expect(() =>
      uniqueDnsRecordAtName(
        envelope([
          { id, ...dns },
          { id: otherId, ...dns },
        ]),
        dns.name
      )
    ).toThrow("Ambiguous DNS inventory");
    expect(() =>
      uniqueRouteAtPattern(
        envelope([
          { id, ...route },
          { id: otherId, ...route },
        ]),
        route.pattern
      )
    ).toThrow("Ambiguous Worker route");
  });
});
