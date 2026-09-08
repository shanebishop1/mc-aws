import { canonicalJson } from "@/lib/agent/canonical-json";
import type { JsonValue, TerminalPublicationAuthorization } from "@/lib/agent/contracts";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;

export type UnsignedTerminalPublicationAuthorization = Omit<TerminalPublicationAuthorization, "signature">;

export function terminalPublicationSignedContent(value: UnsignedTerminalPublicationAuthorization): string {
  return `mc-aws-control-terminal-publication:v1\n${canonicalJson(value as unknown as JsonValue)}`;
}

function decodeBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > 4096) {
    throw new Error("Terminal publication signing key is invalid.");
  }
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "base64"));
  const decoded = atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function base64Url(value: ArrayBuffer): string {
  if (typeof Buffer !== "undefined") return Buffer.from(value).toString("base64url");
  let raw = "";
  for (const byte of new Uint8Array(value)) raw += String.fromCharCode(byte);
  return btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function arrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

export function parseTerminalPublicationAuthorization(value: unknown): TerminalPublicationAuthorization {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Terminal publication authorization is invalid.");
  }
  const item = value as Record<string, unknown>;
  const keys = [
    "schemaVersion",
    "source",
    "runtimeId",
    "sessionId",
    "taskId",
    "leaseId",
    "leaseGeneration",
    "invocationId",
    "invocationDigest",
    "journalSequence",
    "resultDigest",
    "terminalReceiptDigest",
    "outcome",
    "taskStatus",
    "sessionStatus",
    "publicationRevision",
    "publishedAt",
    "signature",
  ];
  if (
    Object.keys(item).length !== keys.length ||
    keys.some((key) => !(key in item)) ||
    item.schemaVersion !== 1 ||
    item.source !== "control-plane-terminal-publication" ||
    ![item.runtimeId, item.sessionId, item.taskId, item.leaseId, item.invocationId].every(
      (candidate) => typeof candidate === "string" && ID.test(candidate)
    ) ||
    !Number.isSafeInteger(item.leaseGeneration) ||
    Number(item.leaseGeneration) < 1 ||
    !Number.isSafeInteger(item.journalSequence) ||
    Number(item.journalSequence) < 1 ||
    !Number.isSafeInteger(item.publicationRevision) ||
    Number(item.publicationRevision) < 1 ||
    ![item.invocationDigest, item.resultDigest, item.terminalReceiptDigest].every(
      (candidate) => typeof candidate === "string" && SHA256.test(candidate)
    ) ||
    !["committed", "failed", "cancelled"].includes(String(item.outcome)) ||
    !["completed", "failed", "cancelled"].includes(String(item.taskStatus)) ||
    !["idle", "completed", "failed", "cancelled"].includes(String(item.sessionStatus)) ||
    typeof item.publishedAt !== "string" ||
    !Number.isFinite(Date.parse(item.publishedAt)) ||
    typeof item.signature !== "string" ||
    !SIGNATURE.test(item.signature)
  ) {
    throw new Error("Terminal publication authorization is invalid.");
  }
  return item as unknown as TerminalPublicationAuthorization;
}

async function signingKey(): Promise<CryptoKey> {
  const encoded = process.env.MC_AGENT_BACKUP_FENCE_PRIVATE_KEY_PKCS8?.trim() ?? "";
  if (!encoded) throw new Error("Terminal publication signing is unavailable.");
  const bytes = decodeBase64(encoded);
  return await crypto.subtle.importKey("pkcs8", arrayBuffer(bytes), { name: "Ed25519" }, false, ["sign"]);
}

export async function signTerminalPublicationAuthorization(
  value: UnsignedTerminalPublicationAuthorization
): Promise<TerminalPublicationAuthorization> {
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    await signingKey(),
    new TextEncoder().encode(terminalPublicationSignedContent(value))
  );
  return parseTerminalPublicationAuthorization({ ...value, signature: base64Url(signature) });
}
