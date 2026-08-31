#!/usr/bin/env node

import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  assertBootstrapUserDataMatches,
  bootstrapPinsFingerprint,
  bootstrapUserDataBindings,
  validateBootstrapPins,
} from "../../lib/bootstrap-pins";

const configPath = path.resolve("config/bootstrap-pins.json");
const userDataPath = path.resolve("infra/src/ec2/user_data.sh");
const runtimeRolloutPath = path.resolve("infra/src/ec2/mc-runtime-rollout.sh");
const fingerprintName = "MC_BOOTSTRAP_PINS_SHA256";

function usage(): never {
  console.error(`Usage:
  pnpm bootstrap:check -- [--env-file <path> ...]
  pnpm bootstrap:review
  pnpm bootstrap:upgrade -- --confirm <reviewed-pins-sha256> [--env-file <path> ...]

Edit config/bootstrap-pins.json with exact reviewed versions, URLs, and upstream
SHA-256 values. 'review' prints the confirmation digest without changing files.
'upgrade' downloads every exact URL, verifies every checksum, updates user_data.sh,
and persists the validated pin-set digest. It never discovers a latest version.`);
  process.exit(2);
}

function parseArgs(argv: string[]): { command: "check" | "review" | "upgrade"; confirm?: string; envFiles: string[] } {
  if (argv[0] === "--") argv.shift();
  const command = argv.shift();
  if (command !== "check" && command !== "review" && command !== "upgrade") usage();
  const result: { command: "check" | "review" | "upgrade"; confirm?: string; envFiles: string[] } = {
    command,
    envFiles: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--") continue;
    if (argv[index] === "--confirm") result.confirm = argv[++index] ?? usage();
    else if (argv[index] === "--env-file") result.envFiles.push(argv[++index] ?? usage());
    else usage();
  }
  if (command === "upgrade" && !result.confirm) usage();
  return result;
}

function writeEnvPin(filePath: string, fingerprint: string): void {
  const absolutePath = path.resolve(filePath);
  const original = existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : "";
  const lines = original.split(/\r?\n/);
  let found = false;
  const updated = lines.map((line) => {
    const comparable = line.startsWith("export ") ? line.slice(7) : line;
    if (!comparable.startsWith(`${fingerprintName}=`)) return line;
    found = true;
    return `${fingerprintName}=${fingerprint}`;
  });
  if (!found) {
    if (updated.length && updated.at(-1) !== "") updated.push("");
    updated.push("# Validated config/bootstrap-pins.json digest; setup-managed, not a secret.");
    updated.push(`${fingerprintName}=${fingerprint}`);
  }
  const temporaryPath = `${absolutePath}.tmp.${process.pid}`;
  writeFileSync(temporaryPath, `${updated.join("\n").replace(/\n+$/, "")}\n`, { mode: 0o600 });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, absolutePath);
}

async function verifyDownloads(pins: ReturnType<typeof validateBootstrapPins>): Promise<void> {
  for (const [name, artifact] of Object.entries(pins.artifacts)) {
    const response = await fetch(artifact.url, {
      redirect: "follow",
      headers: { "User-Agent": "mc-aws-pin-review/1.0" },
    });
    if (!response.ok) throw new Error(`${name} download failed with HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
    if (actual !== artifact.sha256)
      throw new Error(`${name} checksum mismatch: expected ${artifact.sha256}, got ${actual}`);
  }
}

function synchronizeScript(scriptPath: string, pins: ReturnType<typeof validateBootstrapPins>): void {
  let script = readFileSync(scriptPath, "utf8");
  for (const [name, value] of Object.entries(bootstrapUserDataBindings(pins))) {
    const pattern = new RegExp(`^readonly ${name}="[^"]*"$`, "m");
    if (!pattern.test(script)) throw new Error(`${path.basename(scriptPath)} is missing upgrade marker ${name}`);
    script = script.replace(pattern, `readonly ${name}="${value}"`);
  }
  writeFileSync(scriptPath, script);
  assertBootstrapUserDataMatches(script, pins);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const pins = validateBootstrapPins(JSON.parse(readFileSync(configPath, "utf8")) as unknown);
  const fingerprint = bootstrapPinsFingerprint(pins);
  if (options.command === "review") {
    process.stdout.write(`${fingerprint}\n`);
    return;
  }
  if (options.command === "upgrade") {
    if (options.confirm !== fingerprint)
      throw new Error(`Upgrade refused: review pins and pass --confirm ${fingerprint}`);
    await verifyDownloads(pins);
    synchronizeScript(userDataPath, pins);
    synchronizeScript(runtimeRolloutPath, pins);
  } else {
    assertBootstrapUserDataMatches(readFileSync(userDataPath, "utf8"), pins);
    assertBootstrapUserDataMatches(readFileSync(runtimeRolloutPath, "utf8"), pins);
  }
  for (const envFile of options.envFiles) writeEnvPin(envFile, fingerprint);
  process.stdout.write(`${fingerprint}\n`);
  if (options.command === "upgrade") {
    console.error("Pins updated only; UserData does not rerun on an existing host.");
    console.error("Next run: pnpm host:upgrade -- plan, then use rollout-runtime or reviewed replacement.");
  }
}

main().catch((error: unknown) => {
  console.error(`Bootstrap pinning refused: ${(error as Error).message}`);
  process.exit(1);
});
