"use strict";

const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const tls = require("node:tls");

function isLoopbackHost(hostname) {
  const normalized = String(hostname || "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function endpointFromOptions(options) {
  if (typeof options === "string" || options instanceof URL) return new URL(String(options));
  if (!options || typeof options !== "object") return null;
  const hostname = options.hostname || options.host || "127.0.0.1";
  const protocol = options.protocol || (options.port === 443 ? "https:" : "http:");
  return new URL(`${protocol}//${String(hostname).replace(/^\[|\]$/g, "")}`);
}

function assertLoopbackArgs(args) {
  const first = args[0];
  if (first && typeof first === "object" && first.path && !first.host && !first.hostname) return;
  if (typeof first === "number" && typeof args[1] === "string") {
    if (isLoopbackHost(args[1])) return;
    throw new Error("External network access is disabled in the local Wrangler process.");
  }
  if (typeof first === "string" && first.startsWith("/")) return;
  const endpoint = endpointFromOptions(first);
  if (!endpoint || !isLoopbackHost(endpoint.hostname)) {
    throw new Error("External network access is disabled in the local Worker fixture.");
  }
}

function patchRequest(module, name) {
  const original = module[name];
  module[name] = function guardedRequest(...args) {
    assertLoopbackArgs(args);
    return original.apply(this, args);
  };
}

for (const name of ["request", "get"]) {
  patchRequest(http, name);
  patchRequest(https, name);
}
for (const name of ["connect", "createConnection"]) patchRequest(net, name);
patchRequest(tls, "connect");

const nativeFetch = globalThis.fetch;
if (typeof nativeFetch === "function") {
  globalThis.fetch = (input, init) => {
    const endpoint = new URL(input instanceof Request ? input.url : String(input));
    if (!isLoopbackHost(endpoint.hostname)) {
      throw new Error("External network access is disabled in the local Wrangler process.");
    }
    return nativeFetch(input, init);
  };
}
