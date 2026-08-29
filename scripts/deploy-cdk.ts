#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as dotenv from "dotenv";
import { materializeDnsSecrets } from "./materialize-dns-secrets";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CDK_TARGET_VARIABLES = ["CDK_DEFAULT_ACCOUNT", "CDK_DEFAULT_REGION"] as const;

interface DeployTarget {
  account: string;
  region: string;
  stackName: string;
}

interface DeployDependencies {
  run: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => number;
  materialize: (environment: NodeJS.ProcessEnv) => Promise<string[]>;
}

const defaultDependencies: DeployDependencies = {
  run: (command, args, options) => spawnSync(command, args, { ...options, stdio: "inherit" }).status ?? 1,
  materialize: materializeDnsSecrets,
};

export function loadCdkDeployEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  root: string = ROOT
): string | undefined {
  return loadEnvironmentPreservingCdkTarget(environment, () => {
    if (environment.CI === "true") return undefined;
    const selectedEnvironmentFile = [".env.production", ".env.local"]
      .map((name) => path.join(root, name))
      .find(existsSync);
    dotenv.config({
      ...(selectedEnvironmentFile ? { path: selectedEnvironmentFile } : {}),
      override: true,
      quiet: true,
      processEnv: environment as Record<string, string>,
    });
    return selectedEnvironmentFile;
  });
}

export function loadEnvironmentPreservingCdkTarget<T>(environment: NodeJS.ProcessEnv, loadEnvironment: () => T): T {
  const explicitTarget = new Map<string, string>();
  for (const name of CDK_TARGET_VARIABLES) {
    const value = environment[name];
    if (value) explicitTarget.set(name, value);
  }

  const result = loadEnvironment();

  for (const [name, value] of explicitTarget) environment[name] = value;
  return result;
}

export function resolveDeployTarget(environment: NodeJS.ProcessEnv): DeployTarget {
  const account = environment.CDK_DEFAULT_ACCOUNT?.trim();
  const region = environment.CDK_DEFAULT_REGION?.trim();
  const stackName = environment.STACK_NAME?.trim() || "MinecraftStack";
  if (!account || !/^\d{12}$/.test(account)) {
    throw new Error("CDK_DEFAULT_ACCOUNT must identify the exact 12-digit deployment account.");
  }
  if (!region || !/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/.test(region)) {
    throw new Error("CDK_DEFAULT_REGION must identify the exact deployment region.");
  }
  if (!/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(stackName)) {
    throw new Error("STACK_NAME is invalid.");
  }
  return { account, region, stackName };
}

export async function orchestrateCdkDeploy(
  cdkArguments: string[],
  environment: NodeJS.ProcessEnv,
  dependencies: DeployDependencies = defaultDependencies
): Promise<void> {
  const target = resolveDeployTarget(environment);
  const childEnvironment = {
    ...environment,
    AWS_DEFAULT_REGION: target.region,
    CDK_DEFAULT_ACCOUNT: target.account,
    CDK_DEFAULT_REGION: target.region,
  };

  const guardStatus = dependencies.run(
    "pnpm",
    [
      "exec",
      "tsx",
      "scripts/migrate-existing-deployment.ts",
      "--assert-standard-deploy-safe",
      "--account",
      target.account,
      "--region",
      target.region,
      "--stack-name",
      target.stackName,
    ],
    { cwd: ROOT, env: childEnvironment }
  );
  if (guardStatus !== 0)
    throw new Error("Deployment safety guard refused the target; DNS credentials were not changed.");

  let names: string[];
  try {
    names = await dependencies.materialize(childEnvironment);
  } catch {
    throw new Error("DNS SecureString materialization failed; credential values were omitted.");
  }
  for (const name of names) console.log(`Materialized SecureString ${name}; value omitted`);

  const deployEnvironment: NodeJS.ProcessEnv = { ...childEnvironment, CLOUDFLARE_API_TOKEN: undefined };
  const deployStatus = dependencies.run("pnpm", ["exec", "cdk", "deploy", target.stackName, ...cdkArguments], {
    cwd: path.join(ROOT, "infra"),
    env: deployEnvironment,
  });
  if (deployStatus !== 0) throw new Error("CDK deployment failed.");
}

async function main(): Promise<void> {
  try {
    loadCdkDeployEnvironment();
    await orchestrateCdkDeploy(process.argv.slice(2), process.env);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
