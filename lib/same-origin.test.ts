import { createMockNextRequest } from "@/tests/utils";
import { describe, expect, it } from "vitest";
import { evaluateCookieMutationSameOrigin } from "./same-origin";

const canonicalOrigin = "https://panel.example.com";

function mutationRequest(
  headers: Record<string, string> = {},
  options: { method?: string; cookie?: boolean; url?: string } = {}
) {
  const requestHeaders = new Headers(headers);
  if (options.cookie !== false) {
    requestHeaders.set("cookie", "mc_session=session-token");
  }

  return createMockNextRequest(options.url ?? `${canonicalOrigin}/api/start`, {
    method: options.method ?? "POST",
    headers: requestHeaders,
  });
}

describe("cookie mutation same-origin enforcement", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE"])("allows same-origin browser %s requests", (method) => {
    const request = mutationRequest(
      {
        host: "panel.example.com",
        origin: canonicalOrigin,
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
      },
      { method }
    );

    expect(evaluateCookieMutationSameOrigin(request, canonicalOrigin)).toEqual({ allowed: true });
  });

  it("normalizes the canonical default HTTPS port", () => {
    const request = mutationRequest({ host: "panel.example.com", origin: "https://panel.example.com:443" });

    expect(evaluateCookieMutationSameOrigin(request, canonicalOrigin)).toEqual({ allowed: true });
  });

  it.each([
    ["cross-site origin", { host: "panel.example.com", origin: "https://attacker.example" }, "invalid_origin"],
    ["null origin", { host: "panel.example.com", origin: "null" }, "invalid_origin"],
    ["malformed origin", { host: "panel.example.com", origin: "not a URL" }, "invalid_origin"],
    [
      "origin containing a path",
      { host: "panel.example.com", origin: "https://panel.example.com/path" },
      "invalid_origin",
    ],
    ["spoofed host", { host: "attacker.example", origin: canonicalOrigin }, "invalid_host"],
  ])("rejects a browser request with %s", (_label, headers, reason) => {
    const request = mutationRequest({ ...headers, "sec-fetch-site": "cross-site" });

    expect(evaluateCookieMutationSameOrigin(request, canonicalOrigin)).toEqual({ allowed: false, reason });
  });

  it("rejects a browser mutation when Origin is missing", () => {
    const request = mutationRequest({ host: "panel.example.com", "sec-fetch-site": "same-origin" });

    expect(evaluateCookieMutationSameOrigin(request, canonicalOrigin)).toEqual({
      allowed: false,
      reason: "missing_origin",
    });
  });

  it("allows an Origin-less controlled non-browser mutation on the canonical host", () => {
    const request = mutationRequest({ host: "panel.example.com", "user-agent": "internal-health-client/1" });

    expect(evaluateCookieMutationSameOrigin(request, canonicalOrigin)).toEqual({ allowed: true });
  });

  it("does not apply to safe methods or requests without the session cookie", () => {
    const crossSiteHeaders = {
      host: "panel.example.com",
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
    };

    expect(
      evaluateCookieMutationSameOrigin(mutationRequest(crossSiteHeaders, { method: "GET" }), canonicalOrigin)
    ).toEqual({ allowed: true });
    expect(
      evaluateCookieMutationSameOrigin(mutationRequest(crossSiteHeaders, { cookie: false }), canonicalOrigin)
    ).toEqual({ allowed: true });
  });

  it("fails closed when the canonical application origin is invalid", () => {
    const request = mutationRequest({ host: "panel.example.com", origin: canonicalOrigin });

    expect(evaluateCookieMutationSameOrigin(request, "not a URL")).toEqual({
      allowed: false,
      reason: "invalid_configuration",
    });
  });
});
