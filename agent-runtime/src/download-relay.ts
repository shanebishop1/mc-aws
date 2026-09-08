import {
  type KeyLike,
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";
import { type Server, type Socket, createConnection, createServer } from "node:net";
import path from "node:path";
import { canonicalJson } from "@/lib/agent/canonical-json";
import type { GatewayDownloadAuthorization } from "@/lib/agent/executor";
import { normalizeNetworkDownloadUrl, validateNetworkDownloadExpectation } from "@/lib/agent/network-download";
import { removeOwnedStaleUnixSocket } from "./unix-socket";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{40,256}$/;
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_CLOCK_SKEW_MS = 30_000;
const MAX_REPLAY_ENTRIES = 1_024;
const MAX_FRAME_BYTES = 64 * 1024;
export const MAX_GATEWAY_DOWNLOAD_BYTES = 32 * 1024 * 1024;
export const MAX_GATEWAY_DOWNLOAD_TIMEOUT_MS = 30_000;

export type { GatewayDownloadAuthorization } from "@/lib/agent/executor";

export interface GatewayDownloadGrant {
  invocationId: string;
  sessionId: string;
  invocationDigest: string;
  requestFingerprint: string;
  url: string;
  expectedSha256: string;
  expectedBytes: number;
  maxBytes: number;
  timeoutMs: number;
}

export interface GatewayDownloadRelayAuthorizer {
  authorize(input: GatewayDownloadGrant): GatewayDownloadAuthorization;
  revoke(authorizationId: string): void;
}

export interface RelayFetchResult {
  response: Response;
  finalUrl: URL;
}

export interface CredentiallessHttpsRelayTransport {
  fetchWithMetadata(input: string | URL, init: RequestInit): Promise<RelayFetchResult>;
}

interface RelayRequest {
  schemaVersion: 1;
  requestId: string;
  nonce: string;
  issuedAt: string;
  command: "download" | "cancel";
  authorization: GatewayDownloadAuthorization;
  authentication: string;
}

interface RelayResponseHeader {
  schemaVersion: 1;
  requestId: string;
  ok: boolean;
  finalUrl?: string;
  contentType?: string;
  declaredBytes?: number;
  expectedSha256?: string;
  expectedBytes?: number;
  error?: "invalid-request" | "unauthorized" | "replay" | "fenced" | "download-failed";
  signature: string;
}

interface RelayResponseTrailer {
  schemaVersion: 1;
  requestId: string;
  authorizationId: string;
  invocationDigest: string;
  requestFingerprint: string;
  finalUrl: string;
  expectedSha256: string;
  expectedBytes: number;
  bytes: number;
  contentDigest: string;
  signature: string;
}

interface ActiveAuthorization {
  authorization: GatewayDownloadAuthorization;
  controller?: AbortController;
  state: "authorized" | "active";
}

const canonicalize = canonicalJson;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function boundedInteger(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

function normalizeUrl(value: string): string {
  return normalizeNetworkDownloadUrl(value).toString();
}

function validExpectation(expectedSha256: unknown, expectedBytes: unknown): boolean {
  if (typeof expectedSha256 !== "string" || typeof expectedBytes !== "number") return false;
  try {
    validateNetworkDownloadExpectation({ expectedSha256, expectedBytes });
    return true;
  } catch {
    return false;
  }
}

function unsignedAuthorization(value: GatewayDownloadAuthorization): Omit<GatewayDownloadAuthorization, "signature"> {
  const { signature: _signature, ...unsigned } = value;
  return unsigned;
}

function requestAuthentication(request: Omit<RelayRequest, "authentication" | "authorization">, token: string): string {
  return createHmac("sha256", Buffer.from(token, "base64url")).update(canonicalize(request)).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function parseAuthorization(value: unknown): GatewayDownloadAuthorization {
  const item = record(value);
  const keys = [
    "schemaVersion",
    "authorizationId",
    "invocationId",
    "sessionId",
    "invocationDigest",
    "requestFingerprint",
    "url",
    "expectedSha256",
    "expectedBytes",
    "maxBytes",
    "timeoutMs",
    "expiresAt",
    "token",
    "signature",
  ];
  if (
    !item ||
    !exact(item, keys) ||
    item.schemaVersion !== 1 ||
    typeof item.authorizationId !== "string" ||
    !ID.test(item.authorizationId) ||
    typeof item.invocationId !== "string" ||
    !ID.test(item.invocationId) ||
    typeof item.sessionId !== "string" ||
    !ID.test(item.sessionId) ||
    typeof item.invocationDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(item.invocationDigest) ||
    typeof item.requestFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(item.requestFingerprint) ||
    typeof item.url !== "string" ||
    normalizeUrl(item.url) !== item.url ||
    !validExpectation(item.expectedSha256, item.expectedBytes) ||
    !boundedInteger(item.maxBytes, MAX_GATEWAY_DOWNLOAD_BYTES) ||
    (item.expectedBytes as number) > (item.maxBytes as number) ||
    !boundedInteger(item.timeoutMs, MAX_GATEWAY_DOWNLOAD_TIMEOUT_MS) ||
    typeof item.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(item.expiresAt)) ||
    typeof item.token !== "string" ||
    !TOKEN.test(item.token) ||
    typeof item.signature !== "string" ||
    !SIGNATURE.test(item.signature)
  ) {
    throw new Error("invalid-request");
  }
  return item as unknown as GatewayDownloadAuthorization;
}

function parseRequest(value: unknown): RelayRequest {
  const item = record(value);
  if (
    !item ||
    !exact(item, ["schemaVersion", "requestId", "nonce", "issuedAt", "command", "authorization", "authentication"]) ||
    item.schemaVersion !== 1 ||
    typeof item.requestId !== "string" ||
    !ID.test(item.requestId) ||
    typeof item.nonce !== "string" ||
    !/^[a-f0-9]{32}$/.test(item.nonce) ||
    typeof item.issuedAt !== "string" ||
    !Number.isFinite(Date.parse(item.issuedAt)) ||
    (item.command !== "download" && item.command !== "cancel") ||
    typeof item.authentication !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(item.authentication)
  ) {
    throw new Error("invalid-request");
  }
  return { ...item, authorization: parseAuthorization(item.authorization) } as RelayRequest;
}

function contentType(headers: Headers): string {
  const raw = headers.get("content-type");
  if (!raw || raw.length > 256) throw new Error("Download content type is missing or oversized.");
  const mediaType = raw.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const allowed =
    mediaType === "application/octet-stream" ||
    mediaType === "application/java-archive" ||
    mediaType === "application/java-vm" ||
    mediaType === "application/zip" ||
    mediaType === "application/gzip" ||
    mediaType === "application/x-gzip" ||
    mediaType === "application/x-tar" ||
    mediaType === "application/json" ||
    mediaType === "application/xml" ||
    mediaType === "application/toml" ||
    mediaType === "application/yaml" ||
    mediaType === "application/x-yaml" ||
    mediaType === "text/plain" ||
    mediaType === "text/csv" ||
    mediaType === "text/xml" ||
    mediaType === "text/yaml" ||
    mediaType === "image/png" ||
    mediaType === "image/jpeg" ||
    mediaType === "image/gif" ||
    mediaType === "image/webp";
  if (!allowed) throw new Error("Download content type is not allowed.");
  const encoding = headers.get("content-encoding");
  if (encoding && encoding.trim().toLowerCase() !== "identity") {
    throw new Error("Encoded download content is not allowed.");
  }
  return mediaType;
}

function declaredLength(headers: Headers, maximum: number): number | undefined {
  const raw = headers.get("content-length");
  if (raw === null) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) throw new Error("Download content length is invalid.");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error("Download content length exceeds its bound.");
  }
  return value;
}

async function write(socket: Socket, bytes: Uint8Array): Promise<void> {
  if (socket.destroyed) throw new Error("socket-closed");
  if (socket.write(bytes)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      socket.off("drain", onDrain);
      socket.off("error", onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("socket-failed"));
    };
    socket.once("drain", onDrain);
    socket.once("error", onError);
  });
}

class SocketReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private buffered = Buffer.alloc(0);
  private ended = false;

  constructor(socket: Socket) {
    this.iterator = socket[Symbol.asyncIterator]() as AsyncIterator<Uint8Array>;
  }

  async line(maximum: number): Promise<string> {
    while (true) {
      const newline = this.buffered.indexOf(10);
      if (newline >= 0) {
        if (newline > maximum) throw new Error("message-too-large");
        const line = this.buffered.subarray(0, newline).toString("utf8");
        this.buffered = this.buffered.subarray(newline + 1);
        return line;
      }
      if (this.buffered.byteLength > maximum) throw new Error("message-too-large");
      await this.pull();
    }
  }

  async exact(length: number): Promise<Buffer> {
    while (this.buffered.byteLength < length) await this.pull();
    const value = this.buffered.subarray(0, length);
    this.buffered = this.buffered.subarray(length);
    return value;
  }

  private async pull(): Promise<void> {
    if (this.ended) throw new Error("truncated-message");
    const next = await this.iterator.next();
    if (next.done) {
      this.ended = true;
      throw new Error("truncated-message");
    }
    this.buffered = Buffer.concat([this.buffered, Buffer.from(next.value)]);
  }
}

function encodeLine(value: unknown, maximum = MAX_HEADER_BYTES): Uint8Array {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.byteLength > maximum) throw new Error("message-too-large");
  return bytes;
}

function frame(value: Uint8Array): Uint8Array {
  if (value.byteLength > MAX_FRAME_BYTES) throw new Error("frame-too-large");
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(value.byteLength);
  return Buffer.concat([prefix, value]);
}

export interface GatewayDownloadRelayServerOptions {
  socketPath: string;
  gatewayPrivateKey: KeyLike;
  transport: CredentiallessHttpsRelayTransport;
  now?: () => Date;
  createId?: () => string;
}

export class GatewayDownloadRelayServer implements GatewayDownloadRelayAuthorizer {
  private readonly publicKey: KeyLike;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly authorizations = new Map<string, ActiveAuthorization>();
  private readonly grants = new Map<string, string>();
  private readonly nonces = new Map<string, number>();
  private server?: Server;

  constructor(private readonly options: GatewayDownloadRelayServerOptions) {
    if (!path.isAbsolute(options.socketPath)) throw new TypeError("Download relay socket path must be absolute.");
    this.publicKey = createPublicKey(options.gatewayPrivateKey);
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => randomBytes(16).toString("hex"));
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Authorization validation intentionally checks every signed content-bound field together.
  authorize(input: GatewayDownloadGrant): GatewayDownloadAuthorization {
    if (!ID.test(input.invocationId) || !ID.test(input.sessionId))
      throw new TypeError("Download grant identity is invalid.");
    if (!boundedInteger(input.maxBytes, MAX_GATEWAY_DOWNLOAD_BYTES)) throw new TypeError("Download size is invalid.");
    if (!validExpectation(input.expectedSha256, input.expectedBytes))
      throw new TypeError("Operator-supplied download content identity is invalid.");
    if (input.expectedBytes > input.maxBytes) throw new TypeError("Expected download size exceeds its byte bound.");
    if (!boundedInteger(input.timeoutMs, MAX_GATEWAY_DOWNLOAD_TIMEOUT_MS))
      throw new TypeError("Download timeout is invalid.");
    if (!/^[a-f0-9]{64}$/.test(input.invocationDigest) || !/^[a-f0-9]{64}$/.test(input.requestFingerprint)) {
      throw new TypeError("Download invocation binding is invalid.");
    }
    const grantKey = `${input.invocationDigest}:${input.requestFingerprint}`;
    const priorId = this.grants.get(grantKey);
    const prior = priorId ? this.authorizations.get(priorId) : undefined;
    if (prior && Date.parse(prior.authorization.expiresAt) >= this.now().getTime()) {
      const expected = {
        invocationId: input.invocationId,
        sessionId: input.sessionId,
        invocationDigest: input.invocationDigest,
        requestFingerprint: input.requestFingerprint,
        url: normalizeUrl(input.url),
        expectedSha256: input.expectedSha256,
        expectedBytes: input.expectedBytes,
        maxBytes: input.maxBytes,
        timeoutMs: input.timeoutMs,
      };
      const actual = prior.authorization;
      if (
        actual.invocationId !== expected.invocationId ||
        actual.sessionId !== expected.sessionId ||
        actual.invocationDigest !== expected.invocationDigest ||
        actual.requestFingerprint !== expected.requestFingerprint ||
        actual.url !== expected.url ||
        actual.expectedSha256 !== expected.expectedSha256 ||
        actual.expectedBytes !== expected.expectedBytes ||
        actual.maxBytes !== expected.maxBytes ||
        actual.timeoutMs !== expected.timeoutMs
      ) {
        throw new Error("Download request fingerprint was reused with another grant.");
      }
      return structuredClone(actual);
    }
    if (priorId) this.revoke(priorId);
    const unsigned = {
      schemaVersion: 1 as const,
      authorizationId: `download-${this.createId()}`,
      invocationId: input.invocationId,
      sessionId: input.sessionId,
      invocationDigest: input.invocationDigest,
      requestFingerprint: input.requestFingerprint,
      url: normalizeUrl(input.url),
      expectedSha256: input.expectedSha256,
      expectedBytes: input.expectedBytes,
      maxBytes: input.maxBytes,
      timeoutMs: input.timeoutMs,
      expiresAt: new Date(this.now().getTime() + MAX_CLOCK_SKEW_MS).toISOString(),
      token: randomBytes(32).toString("base64url"),
    };
    if (!ID.test(unsigned.authorizationId)) throw new TypeError("Download authorization ID is invalid.");
    const authorization: GatewayDownloadAuthorization = {
      ...unsigned,
      signature: sign(null, Buffer.from(canonicalize(unsigned)), this.options.gatewayPrivateKey).toString("base64url"),
    };
    this.authorizations.set(authorization.authorizationId, { authorization, state: "authorized" });
    this.grants.set(grantKey, authorization.authorizationId);
    while (this.authorizations.size > MAX_REPLAY_ENTRIES) {
      const oldest = this.authorizations.keys().next().value as string;
      this.revoke(oldest);
    }
    return authorization;
  }

  revoke(authorizationId: string): void {
    const active = this.authorizations.get(authorizationId);
    active?.controller?.abort();
    this.authorizations.delete(authorizationId);
    if (active)
      this.grants.delete(`${active.authorization.invocationDigest}:${active.authorization.requestFingerprint}`);
  }

  async listen(): Promise<void> {
    if (this.server) throw new Error("Download relay server is already listening.");
    await removeOwnedStaleUnixSocket(this.options.socketPath);
    this.server = createServer((socket) => void this.handle(socket));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server?.once("error", onError);
      this.server?.listen(this.options.socketPath, () => {
        this.server?.off("error", onError);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const active of this.authorizations.values()) active.controller?.abort();
    this.authorizations.clear();
    this.grants.clear();
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private response(input: Omit<RelayResponseHeader, "signature">): RelayResponseHeader {
    return {
      ...input,
      signature: sign(null, Buffer.from(canonicalize(input)), this.options.gatewayPrivateKey).toString("base64url"),
    };
  }

  private trailer(input: Omit<RelayResponseTrailer, "signature">): RelayResponseTrailer {
    return {
      ...input,
      signature: sign(null, Buffer.from(canonicalize(input)), this.options.gatewayPrivateKey).toString("base64url"),
    };
  }

  private async sendError(socket: Socket, requestId: string, error: RelayResponseHeader["error"]): Promise<void> {
    try {
      socket.end(encodeLine(this.response({ schemaVersion: 1, requestId, ok: false, error })));
    } catch {
      socket.destroy();
    }
  }

  private verifyRequest(request: RelayRequest): ActiveAuthorization {
    const authorization = request.authorization;
    if (
      !verify(
        null,
        Buffer.from(canonicalize(unsignedAuthorization(authorization))),
        this.publicKey,
        Buffer.from(authorization.signature, "base64url")
      )
    ) {
      throw new Error("unauthorized");
    }
    const unsignedRequest = {
      schemaVersion: request.schemaVersion,
      requestId: request.requestId,
      nonce: request.nonce,
      issuedAt: request.issuedAt,
      command: request.command,
      authorizationId: authorization.authorizationId,
    };
    if (!safeEqual(request.authentication, requestAuthentication(unsignedRequest, authorization.token))) {
      throw new Error("unauthorized");
    }
    const now = this.now().getTime();
    if (
      Math.abs(now - Date.parse(request.issuedAt)) > MAX_CLOCK_SKEW_MS ||
      Date.parse(authorization.expiresAt) < now ||
      this.nonces.has(request.nonce)
    ) {
      throw new Error("replay");
    }
    this.nonces.set(request.nonce, now);
    while (this.nonces.size > MAX_REPLAY_ENTRIES) this.nonces.delete(this.nonces.keys().next().value as string);
    const active = this.authorizations.get(authorization.authorizationId);
    if (!active || canonicalize(active.authorization) !== canonicalize(authorization)) throw new Error("fenced");
    return active;
  }

  private async handle(socket: Socket): Promise<void> {
    let requestId = "invalid";
    try {
      const reader = new SocketReader(socket);
      const request = parseRequest(JSON.parse(await reader.line(MAX_REQUEST_BYTES)) as unknown);
      requestId = request.requestId;
      const active = this.verifyRequest(request);
      if (request.command === "cancel") {
        if (active.state !== "active" || !active.controller) throw new Error("fenced");
        active.controller.abort();
        socket.end(encodeLine(this.response({ schemaVersion: 1, requestId, ok: true })));
        return;
      }
      if (active.state !== "authorized") throw new Error("replay");
      active.state = "active";
      const controller = new AbortController();
      active.controller = controller;
      await this.download(socket, request, controller);
    } catch (error) {
      const code = (error as Error).message;
      const responseError = ["unauthorized", "replay", "fenced"].includes(code)
        ? (code as "unauthorized" | "replay" | "fenced")
        : code === "invalid-request"
          ? "invalid-request"
          : "download-failed";
      await this.sendError(socket, requestId, responseError);
    }
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Streaming validation keeps framing, bounds, digest, and staging-failure handling in one linear path.
  private async download(socket: Socket, request: RelayRequest, controller: AbortController): Promise<void> {
    const authorization = request.authorization;
    const onClose = () => controller.abort();
    socket.once("close", onClose);
    const timer = setTimeout(() => controller.abort(), authorization.timeoutMs);
    timer.unref();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let headerWritten = false;
    try {
      const fetched = await this.options.transport.fetchWithMetadata(authorization.url, {
        method: "GET",
        redirect: "manual",
        headers: {
          accept:
            "application/octet-stream, application/java-archive, application/zip, application/gzip, application/json, text/plain, image/png",
          "accept-encoding": "identity",
          "user-agent": "mc-aws-agent-download-relay/1",
        },
        signal: controller.signal,
      });
      if (fetched.finalUrl.toString() !== authorization.url) {
        await fetched.response.body?.cancel();
        throw new Error("Download final URL changed.");
      }
      const response = fetched.response;
      if (!response.ok || !response.body) throw new Error("Download response failed.");
      const mediaType = contentType(response.headers);
      const declaredBytes = declaredLength(response.headers, authorization.maxBytes);
      const unsignedHeader = {
        schemaVersion: 1 as const,
        requestId: request.requestId,
        ok: true,
        finalUrl: fetched.finalUrl.toString(),
        contentType: mediaType,
        expectedSha256: authorization.expectedSha256,
        expectedBytes: authorization.expectedBytes,
        ...(declaredBytes === undefined ? {} : { declaredBytes }),
      };
      await write(socket, encodeLine(this.response(unsignedHeader)));
      headerWritten = true;
      reader = response.body.getReader();
      let received = 0;
      const contentHash = createHash("sha256");
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        received += item.value.byteLength;
        if (received > authorization.maxBytes) {
          throw new Error("Download exceeded its byte bound.");
        }
        contentHash.update(item.value);
        for (let offset = 0; offset < item.value.byteLength; offset += MAX_FRAME_BYTES) {
          await write(socket, frame(item.value.subarray(offset, offset + MAX_FRAME_BYTES)));
        }
      }
      const contentDigest = contentHash.digest("hex");
      if (declaredBytes !== undefined && declaredBytes !== received) {
        throw new Error("Download body did not match its declared size.");
      }
      if (received !== authorization.expectedBytes || contentDigest !== authorization.expectedSha256) {
        throw new Error("Download body did not match the operator-supplied content identity.");
      }
      await write(socket, frame(new Uint8Array()));
      await write(
        socket,
        encodeLine(
          this.trailer({
            schemaVersion: 1,
            requestId: request.requestId,
            authorizationId: authorization.authorizationId,
            invocationDigest: authorization.invocationDigest,
            requestFingerprint: authorization.requestFingerprint,
            finalUrl: fetched.finalUrl.toString(),
            expectedSha256: authorization.expectedSha256,
            expectedBytes: authorization.expectedBytes,
            bytes: received,
            contentDigest,
          })
        )
      );
      socket.end();
    } catch (error) {
      // Once the signed success header is on the wire, an error response would be
      // parsed as a body frame. Close instead; the executor removes its staging file.
      if (headerWritten) socket.destroy();
      throw error;
    } finally {
      clearTimeout(timer);
      socket.off("close", onClose);
      await reader?.cancel().catch(() => undefined);
      this.revoke(authorization.authorizationId);
    }
  }
}

export interface GatewayDownloadRelayClientOptions {
  socketPath: string;
  gatewayPublicKey: KeyLike;
  now?: () => Date;
  createId?: () => string;
}

export interface GatewayDownloadResult {
  finalUrl: string;
  contentType: string;
  bytes: number;
  contentDigest: string;
}

export class GatewayDownloadRelayClient {
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(private readonly options: GatewayDownloadRelayClientOptions) {
    if (!path.isAbsolute(options.socketPath)) throw new TypeError("Download relay socket path must be absolute.");
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => randomBytes(16).toString("hex"));
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Authenticated framing, bounds, cancellation, and content verification remain one linear receive path.
  async download(
    authorization: GatewayDownloadAuthorization,
    signal: AbortSignal,
    onChunk: (chunk: Uint8Array, received: number) => Promise<void>
  ): Promise<GatewayDownloadResult> {
    if (signal.aborted) throw new DOMException("Invocation cancelled", "AbortError");
    const request = this.request("download", authorization);
    const socket = createConnection(this.options.socketPath);
    const onAbort = () => {
      socket.destroy(new DOMException("Invocation cancelled", "AbortError"));
      void this.cancel(authorization).catch(() => undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      socket.write(encodeLine(request, MAX_REQUEST_BYTES));
      const reader = new SocketReader(socket);
      const header = this.parseResponse(JSON.parse(await reader.line(MAX_HEADER_BYTES)) as unknown, request.requestId);
      if (!header.ok) throw new Error("Gateway download relay failed closed.");
      if (
        header.finalUrl !== authorization.url ||
        header.expectedSha256 !== authorization.expectedSha256 ||
        header.expectedBytes !== authorization.expectedBytes
      ) {
        throw new Error("Gateway download relay resource identity did not match the authorization.");
      }
      let received = 0;
      const contentHash = createHash("sha256");
      while (true) {
        const length = (await reader.exact(4)).readUInt32BE(0);
        if (length === 0) break;
        if (length > MAX_FRAME_BYTES) throw new Error("Gateway download relay frame exceeded its bound.");
        const chunk = await reader.exact(length);
        received += chunk.byteLength;
        if (received > authorization.maxBytes) throw new Error("Gateway download relay exceeded its byte bound.");
        contentHash.update(chunk);
        await onChunk(chunk, received);
      }
      if (header.declaredBytes !== undefined && header.declaredBytes !== received) {
        throw new Error("Gateway download relay returned a truncated body.");
      }
      const trailer = this.parseTrailer(
        JSON.parse(await reader.line(MAX_HEADER_BYTES)) as unknown,
        request.requestId,
        authorization
      );
      const contentDigest = contentHash.digest("hex");
      if (
        trailer.finalUrl !== authorization.url ||
        trailer.expectedSha256 !== authorization.expectedSha256 ||
        trailer.expectedBytes !== authorization.expectedBytes ||
        trailer.bytes !== received ||
        trailer.bytes !== authorization.expectedBytes ||
        trailer.contentDigest !== contentDigest ||
        contentDigest !== authorization.expectedSha256
      ) {
        throw new Error("Gateway download relay content digest did not match the authenticated trailer.");
      }
      return {
        finalUrl: header.finalUrl as string,
        contentType: header.contentType as string,
        bytes: received,
        contentDigest,
      };
    } catch (error) {
      if (signal.aborted) throw new DOMException("Invocation cancelled", "AbortError");
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
      socket.destroy();
    }
  }

  async cancel(authorization: GatewayDownloadAuthorization): Promise<void> {
    const request = this.request("cancel", authorization);
    const socket = createConnection(this.options.socketPath);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      socket.write(encodeLine(request, MAX_REQUEST_BYTES));
      const reader = new SocketReader(socket);
      this.parseResponse(JSON.parse(await reader.line(MAX_HEADER_BYTES)) as unknown, request.requestId);
    } finally {
      socket.destroy();
    }
  }

  private request(command: RelayRequest["command"], authorization: GatewayDownloadAuthorization): RelayRequest {
    parseAuthorization(authorization);
    const unsigned = {
      schemaVersion: 1 as const,
      requestId: `${command}-${this.createId()}`,
      nonce: randomBytes(16).toString("hex"),
      issuedAt: this.now().toISOString(),
      command,
      authorizationId: authorization.authorizationId,
    };
    if (!ID.test(unsigned.requestId)) throw new TypeError("Download relay request ID is invalid.");
    return {
      schemaVersion: 1,
      requestId: unsigned.requestId,
      nonce: unsigned.nonce,
      issuedAt: unsigned.issuedAt,
      command,
      authorization,
      authentication: requestAuthentication(unsigned, authorization.token),
    };
  }

  private parseResponse(value: unknown, requestId: string): RelayResponseHeader {
    const item = record(value);
    if (!item || typeof item.signature !== "string" || !SIGNATURE.test(item.signature)) {
      throw new Error("Gateway download relay response is invalid.");
    }
    const { signature, ...unsigned } = item;
    if (
      !verify(
        null,
        Buffer.from(canonicalize(unsigned)),
        this.options.gatewayPublicKey,
        Buffer.from(signature, "base64url")
      ) ||
      unsigned.schemaVersion !== 1 ||
      unsigned.requestId !== requestId ||
      typeof unsigned.ok !== "boolean" ||
      !Object.keys(unsigned).every((key) =>
        [
          "schemaVersion",
          "requestId",
          "ok",
          "finalUrl",
          "contentType",
          "expectedSha256",
          "expectedBytes",
          "declaredBytes",
          "error",
        ].includes(key)
      )
    ) {
      throw new Error("Gateway download relay response is invalid.");
    }
    if (unsigned.ok) {
      if (
        typeof unsigned.finalUrl !== "string" ||
        normalizeUrl(unsigned.finalUrl) !== unsigned.finalUrl ||
        typeof unsigned.contentType !== "string" ||
        !validExpectation(unsigned.expectedSha256, unsigned.expectedBytes) ||
        (unsigned.declaredBytes !== undefined && !boundedInteger(unsigned.declaredBytes, MAX_GATEWAY_DOWNLOAD_BYTES))
      ) {
        throw new Error("Gateway download relay response is invalid.");
      }
    }
    return item as unknown as RelayResponseHeader;
  }

  private parseTrailer(
    value: unknown,
    requestId: string,
    authorization: GatewayDownloadAuthorization
  ): RelayResponseTrailer {
    const item = record(value);
    if (!item || typeof item.signature !== "string" || !SIGNATURE.test(item.signature)) {
      throw new Error("Gateway download relay trailer is invalid.");
    }
    const { signature, ...unsigned } = item;
    if (
      !verify(
        null,
        Buffer.from(canonicalize(unsigned)),
        this.options.gatewayPublicKey,
        Buffer.from(signature, "base64url")
      ) ||
      !exact(unsigned, [
        "schemaVersion",
        "requestId",
        "authorizationId",
        "invocationDigest",
        "requestFingerprint",
        "finalUrl",
        "expectedSha256",
        "expectedBytes",
        "bytes",
        "contentDigest",
      ]) ||
      unsigned.schemaVersion !== 1 ||
      unsigned.requestId !== requestId ||
      unsigned.authorizationId !== authorization.authorizationId ||
      unsigned.invocationDigest !== authorization.invocationDigest ||
      unsigned.requestFingerprint !== authorization.requestFingerprint ||
      unsigned.finalUrl !== authorization.url ||
      unsigned.expectedSha256 !== authorization.expectedSha256 ||
      unsigned.expectedBytes !== authorization.expectedBytes ||
      typeof unsigned.bytes !== "number" ||
      !Number.isSafeInteger(unsigned.bytes) ||
      unsigned.bytes < 1 ||
      unsigned.bytes > authorization.maxBytes ||
      typeof unsigned.contentDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(unsigned.contentDigest)
    ) {
      throw new Error("Gateway download relay trailer is invalid.");
    }
    return item as unknown as RelayResponseTrailer;
  }
}
