import { createHash } from "node:crypto";

const sha256Pattern = /^[a-f0-9]{64}$/;
const exactVersionPattern = /^\d+\.\d+(?:\.\d+)?$/;

export interface DownloadPin {
  version: string;
  url: string;
  sha256: string;
  checksumSource: string;
}

export interface BootstrapPins {
  schemaVersion: 1;
  reviewedAt: string;
  artifacts: {
    paper: DownloadPin & { minecraftVersion: string; build: number };
    rclone: DownloadPin;
    mcstatus: DownloadPin;
    asyncioDgram: DownloadPin;
    dnspython: DownloadPin;
  };
}

type UnknownRecord = Record<string, unknown>;

function asExactRecord(value: unknown, keys: readonly string[], label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const record = value as UnknownRecord;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain exactly: ${keys.join(", ")}`);
  }
  return record;
}

function exactString(record: UnknownRecord, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}.${key} must be present`);
  if (/placeholder|replace|current|latest|todo/i.test(value))
    throw new Error(`${label}.${key} cannot be mutable or a placeholder`);
  return value;
}

function parseDownloadPin(value: unknown, label: string): DownloadPin {
  const record = asExactRecord(value, ["version", "url", "sha256", "checksumSource"], label);
  const version = exactString(record, "version", label);
  const url = exactString(record, "url", label);
  const sha256 = exactString(record, "sha256", label);
  const checksumSource = exactString(record, "checksumSource", label);
  if (!exactVersionPattern.test(version)) throw new Error(`${label}.version must be exact`);
  if (!sha256Pattern.test(sha256) || /^([a-f0-9])\1{63}$/.test(sha256)) {
    throw new Error(`${label}.sha256 must be a reviewed SHA-256 digest`);
  }
  for (const [name, candidate] of [
    ["url", url],
    ["checksumSource", checksumSource],
  ] as const) {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:") throw new Error(`${label}.${name} must use HTTPS`);
  }
  return { version, url, sha256, checksumSource };
}

export function validateBootstrapPins(value: unknown): BootstrapPins {
  const root = asExactRecord(value, ["schemaVersion", "reviewedAt", "artifacts"], "bootstrap pins");
  if (root.schemaVersion !== 1) throw new Error("bootstrap pins schemaVersion must be 1");
  const reviewedAt = exactString(root, "reviewedAt", "bootstrap pins");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewedAt) || !Number.isFinite(Date.parse(`${reviewedAt}T00:00:00Z`))) {
    throw new Error("bootstrap pins reviewedAt must be an ISO date");
  }
  const artifacts = asExactRecord(
    root.artifacts,
    ["paper", "rclone", "mcstatus", "asyncioDgram", "dnspython"],
    "bootstrap pins.artifacts"
  );
  const paperRecord = asExactRecord(
    artifacts.paper,
    ["minecraftVersion", "build", "version", "url", "sha256", "checksumSource"],
    "bootstrap pins.artifacts.paper"
  );
  const paper = parseDownloadPin(
    {
      version: paperRecord.version,
      url: paperRecord.url,
      sha256: paperRecord.sha256,
      checksumSource: paperRecord.checksumSource,
    },
    "bootstrap pins.artifacts.paper"
  );
  const minecraftVersion = exactString(paperRecord, "minecraftVersion", "bootstrap pins.artifacts.paper");
  const build = paperRecord.build;
  if (!exactVersionPattern.test(minecraftVersion) || !Number.isSafeInteger(build) || (build as number) <= 0) {
    throw new Error("Paper Minecraft version and build must be exact");
  }
  if (
    paper.version !== minecraftVersion ||
    !paper.url.includes(`/objects/${paper.sha256}/paper-${minecraftVersion}-${build}.jar`) ||
    !paper.checksumSource.endsWith(`/versions/${minecraftVersion}/builds/${build}`)
  ) {
    throw new Error("Paper version/build/url pins do not match");
  }

  const rclone = parseDownloadPin(artifacts.rclone, "bootstrap pins.artifacts.rclone");
  const mcstatus = parseDownloadPin(artifacts.mcstatus, "bootstrap pins.artifacts.mcstatus");
  const asyncioDgram = parseDownloadPin(artifacts.asyncioDgram, "bootstrap pins.artifacts.asyncioDgram");
  const dnspython = parseDownloadPin(artifacts.dnspython, "bootstrap pins.artifacts.dnspython");
  const expectedUrlFragments = [
    ["rclone", rclone, `/v${rclone.version}/rclone-v${rclone.version}-linux-arm64.zip`],
    ["mcstatus", mcstatus, `/mcstatus-${mcstatus.version}-py3-none-any.whl`],
    ["asyncioDgram", asyncioDgram, `/asyncio_dgram-${asyncioDgram.version}-py3-none-any.whl`],
    ["dnspython", dnspython, `/dnspython-${dnspython.version}-py3-none-any.whl`],
  ] as const;
  for (const [name, artifact, expectedFragment] of expectedUrlFragments) {
    if (!artifact.url.endsWith(expectedFragment)) throw new Error(`${name} version and URL pins do not match`);
  }

  return {
    schemaVersion: 1,
    reviewedAt,
    artifacts: {
      paper: { ...paper, minecraftVersion, build: build as number },
      rclone,
      mcstatus,
      asyncioDgram,
      dnspython,
    },
  };
}

export function bootstrapPinsFingerprint(pins: BootstrapPins): string {
  return createHash("sha256").update(JSON.stringify(pins)).digest("hex");
}

export function bootstrapUserDataBindings(pins: BootstrapPins): Record<string, string> {
  const { paper, rclone, mcstatus, asyncioDgram, dnspython } = pins.artifacts;
  return {
    MC_BOOTSTRAP_PINS_SHA256: bootstrapPinsFingerprint(pins),
    MC_VERSION: paper.minecraftVersion,
    PAPER_BUILD: String(paper.build),
    PAPER_URL: paper.url,
    PAPER_SHA256: paper.sha256,
    RCLONE_VERSION: rclone.version,
    RCLONE_URL: rclone.url,
    RCLONE_SHA256: rclone.sha256,
    MCSTATUS_VERSION: mcstatus.version,
    MCSTATUS_URL: mcstatus.url,
    MCSTATUS_SHA256: mcstatus.sha256,
    ASYNCIO_DGRAM_VERSION: asyncioDgram.version,
    ASYNCIO_DGRAM_URL: asyncioDgram.url,
    ASYNCIO_DGRAM_SHA256: asyncioDgram.sha256,
    DNSPYTHON_VERSION: dnspython.version,
    DNSPYTHON_URL: dnspython.url,
    DNSPYTHON_SHA256: dnspython.sha256,
  };
}

export function assertBootstrapUserDataMatches(script: string, pins: BootstrapPins): void {
  for (const [name, expected] of Object.entries(bootstrapUserDataBindings(pins))) {
    const match = script.match(new RegExp(`^readonly ${name}="([^"]*)"$`, "m"));
    if (!match) throw new Error(`user_data.sh is missing exact ${name}`);
    if (match[1] !== expected) throw new Error(`user_data.sh ${name} does not match reviewed bootstrap pins`);
  }
}
