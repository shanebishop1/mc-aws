import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const apiRoot = path.resolve(process.cwd(), "app/api");
const stateChangingHandlerPattern = /export\s+async\s+function\s+(POST|PUT|PATCH|DELETE)\s*\(/g;

function routeFiles(directory = apiRoot): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return routeFiles(entryPath);
    return entry.name === "route.ts" ? [entryPath] : [];
  });
}

function mutationHandlers(): Map<string, string> {
  const handlers = new Map<string, string>();
  for (const file of routeFiles()) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(stateChangingHandlerPattern)) {
      const route = `/${path.relative(path.resolve(process.cwd(), "app"), path.dirname(file)).replaceAll(path.sep, "/")}`;
      handlers.set(`${match[1]} ${route}`, source);
    }
  }
  return handlers;
}

const cookieAuthenticatedMutations = [
  "POST /api/agent/sessions",
  "POST /api/agent/sessions/[sessionId]/approvals/[approvalId]/decision",
  "POST /api/agent/sessions/[sessionId]/approvals/[approvalId]/revoke",
  "POST /api/agent/sessions/[sessionId]/cancel",
  "POST /api/agent/sessions/[sessionId]/continue",
  "POST /api/backup",
  "PUT /api/emails/allowlist",
  "POST /api/hibernate",
  "POST /api/mock/fault",
  "DELETE /api/mock/fault",
  "POST /api/mock/patch",
  "POST /api/mock/reset",
  "POST /api/mock/scenario",
  "POST /api/restore",
  "POST /api/resume",
  "POST /api/start",
  "POST /api/stop",
] as const;

const runtimeBearerMutations = [
  "POST /api/agent/runtime/backups",
  "POST /api/agent/runtime/leases/[leaseId]/[action]",
  "POST /api/agent/runtime/work",
] as const;

describe("state-changing API same-origin coverage", () => {
  it("keeps an explicit inventory of every state-changing route handler", () => {
    expect([...mutationHandlers().keys()].sort()).toEqual(
      [...cookieAuthenticatedMutations, ...runtimeBearerMutations, "POST /api/auth/logout"].sort()
    );
  });

  it.each(cookieAuthenticatedMutations)("protects %s through centralized cookie authentication", (handler) => {
    const source = mutationHandlers().get(handler);
    expect(source).toBeDefined();
    expect(source).toMatch(/(?:require(?:Allowed|Admin)|authenticateAgentAdmin)\s*\(/);
  });

  it("keeps the agent authentication wrapper admin-only", () => {
    const source = readFileSync(path.resolve(process.cwd(), "lib/agent/control-plane/http.ts"), "utf8");
    expect(source).toMatch(/requireAdmin\s*\(request\)/);
  });

  it.each(runtimeBearerMutations)("protects %s with the non-cookie runtime bearer", (handler) => {
    const source = mutationHandlers().get(handler);
    expect(source).toBeDefined();
    expect(source).toMatch(/authenticateAgentRuntime\s*\(/);
  });

  it("protects logout before clearing the session cookie", () => {
    const source = mutationHandlers().get("POST /api/auth/logout") ?? "";
    const enforcementIndex = source.indexOf("enforceCookieMutationSameOrigin(request)");
    const clearIndex = source.indexOf("clearSessionCookie()");

    expect(enforcementIndex).toBeGreaterThan(-1);
    expect(clearIndex).toBeGreaterThan(enforcementIndex);
  });
});
