import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { afterAll, beforeAll, vi } from "vitest";

const state = { attempts: 0 };

export function agentE2eNetworkAttempts(): number {
  return state.attempts;
}

function blocked(): never {
  state.attempts++;
  throw new Error("Network access is disabled by the agent E2E test boundary.");
}

beforeAll(() => {
  if (process.env.MC_AGENT_E2E_NETWORK !== "disabled") {
    throw new Error("The agent E2E suite requires MC_AGENT_E2E_NETWORK=disabled.");
  }
  vi.stubGlobal("fetch", vi.fn(blocked));
  vi.spyOn(http, "request").mockImplementation(blocked);
  vi.spyOn(http, "get").mockImplementation(blocked);
  vi.spyOn(https, "request").mockImplementation(blocked);
  vi.spyOn(https, "get").mockImplementation(blocked);
  vi.spyOn(net, "connect").mockImplementation(blocked);
  vi.spyOn(net, "createConnection").mockImplementation(blocked);
  vi.spyOn(tls, "connect").mockImplementation(blocked);
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
