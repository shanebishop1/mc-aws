#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const PIN_NAME = "AL2023_ARM64_AMI_ID";
const DEFAULT_PARAMETER = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64";
const AMI_PATTERN = /^ami-[a-f0-9]{8,17}$/;

interface Options {
  command: "ensure" | "upgrade";
  region: string;
  envFiles: string[];
  confirm?: string;
  parameterName: string;
}

interface ImageDescription {
  Architecture?: string;
  ImageId?: string;
  Name?: string;
  OwnerId?: string;
  RootDeviceType?: string;
  State?: string;
  VirtualizationType?: string;
}

function usage(): never {
  console.error(`Usage:
  pnpm ami:pin -- ensure --region <region> [--env-file <path> ...]
  pnpm ami:upgrade -- upgrade --region <region> --confirm <latest-ami-id> [--env-file <path> ...]

Routine ensure preserves an existing validated pin. Upgrade resolves the current
AWS-published ARM64 AL2023 image and changes the pin only when --confirm exactly
matches that reviewed AMI ID.`);
  process.exit(2);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: strict one-pass CLI parsing rejects every unsupported or incomplete option.
function parseOptions(args: string[]): Options {
  if (args[0] === "--") args.shift();
  const command = args.shift();
  if (command !== "ensure" && command !== "upgrade") usage();
  const options: Options = {
    command,
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "",
    envFiles: [],
    parameterName: DEFAULT_PARAMETER,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = () => args[++index] ?? usage();
    if (argument === "--region") options.region = value();
    else if (argument === "--env-file") options.envFiles.push(value());
    else if (argument === "--confirm") options.confirm = value();
    else if (argument === "--parameter-name") options.parameterName = value();
    else usage();
  }
  if (!/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/.test(options.region)) usage();
  if (!options.envFiles.length) options.envFiles = [".env.production", ".env.local"];
  if (options.command === "upgrade" && !options.confirm) usage();
  return options;
}

function awsJson(region: string, args: string[]): Record<string, unknown> {
  const output = execFileSync("aws", ["--region", region, ...args, "--output", "json"], {
    encoding: "utf8",
    env: { ...process.env, AWS_PAGER: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(output) as Record<string, unknown>;
}

function readPin(envFile: string): string | undefined {
  if (!existsSync(envFile)) return undefined;
  for (const rawLine of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const line = rawLine.startsWith("export ") ? rawLine.slice(7) : rawLine;
    if (!line.startsWith(`${PIN_NAME}=`)) continue;
    let value = line.slice(PIN_NAME.length + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value || undefined;
  }
  return undefined;
}

function writePin(envFile: string, imageId: string): void {
  const absolutePath = path.resolve(envFile);
  const original = existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : "";
  const lines = original.split(/\r?\n/);
  let found = false;
  const updated = lines.map((line) => {
    const comparable = line.startsWith("export ") ? line.slice(7) : line;
    if (!comparable.startsWith(`${PIN_NAME}=`)) return line;
    found = true;
    return `${PIN_NAME}=${imageId}`;
  });
  if (!found) {
    if (updated.length && updated.at(-1) !== "") updated.push("");
    updated.push("# Exact ARM64 Amazon Linux 2023 image; update only through pnpm ami:upgrade.");
    updated.push(`${PIN_NAME}=${imageId}`);
  }
  while (updated.length > 1 && updated.at(-1) === "" && updated.at(-2) === "") updated.pop();
  const temporaryPath = `${absolutePath}.tmp.${process.pid}`;
  writeFileSync(temporaryPath, `${updated.join("\n").replace(/\n+$/, "")}\n`, { mode: 0o600 });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, absolutePath);
}

function resolveLatest(region: string, parameterName: string): string {
  const response = awsJson(region, ["ssm", "get-parameter", "--name", parameterName]);
  const value = (response.Parameter as { Value?: unknown } | undefined)?.Value;
  if (typeof value !== "string" || !AMI_PATTERN.test(value)) {
    throw new Error(`AWS SSM parameter ${parameterName} did not resolve to an exact AMI ID.`);
  }
  return value;
}

function validateImages(region: string, pinnedImageId: string, latestImageId: string): void {
  if (!AMI_PATTERN.test(pinnedImageId)) throw new Error(`${PIN_NAME} must be an exact AMI ID.`);
  const response = awsJson(region, [
    "ec2",
    "describe-images",
    "--image-ids",
    pinnedImageId,
    ...(pinnedImageId === latestImageId ? [] : [latestImageId]),
  ]);
  const images = Array.isArray(response.Images) ? (response.Images as ImageDescription[]) : [];
  const latest = images.find((image) => image.ImageId === latestImageId);
  const pinned = images.find((image) => image.ImageId === pinnedImageId);
  const validAl2023Arm64 = (image: ImageDescription | undefined): boolean =>
    Boolean(
      image &&
        image.Architecture === "arm64" &&
        image.State === "available" &&
        image.RootDeviceType === "ebs" &&
        image.VirtualizationType === "hvm" &&
        /^al2023-ami-.+-arm64$/.test(image.Name ?? "")
    );
  if (!validAl2023Arm64(latest) || !latest?.OwnerId) {
    throw new Error("The AWS-published latest ARM64 AL2023 image failed metadata validation.");
  }
  if (!validAl2023Arm64(pinned) || pinned?.OwnerId !== latest.OwnerId) {
    throw new Error(`${PIN_NAME}=${pinnedImageId} is not an available AWS-published ARM64 AL2023 image in ${region}.`);
  }
}

function main(): void {
  const options = parseOptions(process.argv.slice(2));
  const pins = new Set(options.envFiles.map(readPin).filter((value): value is string => Boolean(value)));
  const shellPin = process.env[PIN_NAME]?.trim();
  if (shellPin) pins.add(shellPin);
  if (pins.size > 1) throw new Error(`${PIN_NAME} conflicts across the shell and deployment env files.`);

  const existingPin = [...pins][0];
  const latestImageId = resolveLatest(options.region, options.parameterName);
  const selectedImageId = options.command === "ensure" ? existingPin || latestImageId : latestImageId;
  validateImages(options.region, selectedImageId, latestImageId);

  if (options.command === "upgrade" && options.confirm !== latestImageId) {
    throw new Error(`Upgrade refused: review the resolved AMI and pass --confirm ${latestImageId}`);
  }
  for (const envFile of options.envFiles) writePin(envFile, selectedImageId);
  process.stdout.write(`${selectedImageId}\n`);
  if (options.command === "upgrade") {
    console.error("Pin updated only; no host changed. Next run: pnpm host:upgrade -- plan");
    console.error("An AMI change requires the backup/snapshot-guarded reviewed replacement workflow.");
  }
}

try {
  main();
} catch (error) {
  console.error(`AMI pinning refused: ${(error as Error).message}`);
  process.exit(1);
}
