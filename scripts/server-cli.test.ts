import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callApi, resolveApiBase } from "./server-cli";

const token = `${"a".repeat(16)}.${"b".repeat(16)}.${"c".repeat(16)}`;
const directories: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tokenFile(mode = 0o600): string {
  const directory = mkdtempSync(path.join(tmpdir(), "mc-aws-server-cli-test-"));
  directories.push(directory);
  const file = path.join(directory, "session-token");
  writeFileSync(file, `${token}\n`, { mode });
  chmodSync(file, mode);
  return file;
}

describe("server CLI target and authentication", () => {
  it("defaults to the local development API", () => {
    expect(resolveApiBase({}).href).toBe("http://localhost:3000/api");
  });

  it("derives the API endpoint from the configured panel URL", () => {
    expect(resolveApiBase({ NEXT_PUBLIC_APP_URL: "https://panel.example.net/" }).href).toBe(
      "https://panel.example.net/api"
    );
  });

  it("rejects insecure remote and credential-bearing targets", () => {
    expect(() => resolveApiBase({ API_BASE: "http://panel.example.net/api" })).toThrow("require HTTPS");
    expect(() => resolveApiBase({ API_BASE: "https://user:pass@panel.example.net/api" })).toThrow(
      "must not contain credentials"
    );
  });

  it("requires a secure session-token file for remote requests", async () => {
    await expect(callApi("/status", "GET", undefined, { API_BASE: "https://panel.example.net/api" })).rejects.toThrow(
      "MC_SERVER_CLI_SESSION_COOKIE_FILE"
    );
    await expect(
      callApi("/status", "GET", undefined, {
        API_BASE: "https://panel.example.net/api",
        MC_SERVER_CLI_SESSION_COOKIE_FILE: tokenFile(0o644),
      })
    ).rejects.toThrow("0600 regular file");
  });

  it("sends the authenticated request without exposing the token in the URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { state: "stopped" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await callApi("/status", "GET", undefined, {
      API_BASE: "https://panel.example.net/api",
      MC_SERVER_CLI_SESSION_COOKIE_FILE: tokenFile(),
    });

    const [url, request] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.href).toBe("https://panel.example.net/api/status");
    expect(request.headers).toEqual({ Cookie: `mc_session=${token}` });
    expect(url.href).not.toContain(token);
  });
});
