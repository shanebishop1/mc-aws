import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadEnvironmentPreservingCdkTarget, orchestrateCdkDeploy, resolveDeployTarget } from "./deploy-cdk";

const targetEnvironment = (): NodeJS.ProcessEnv => ({
  ...process.env,
  CDK_DEFAULT_ACCOUNT: "123456789012",
  CDK_DEFAULT_REGION: "us-east-1",
  CLOUDFLARE_DNS_API_TOKEN: "credential-sentinel-never-an-argument",
  MC_CONNECTION_MODE: "cloudflare",
});

describe("standard CDK deployment orchestration", () => {
  it("guards the exact CDK target before materializing DNS credentials and deploying", async () => {
    const operations: string[] = [];
    const commands: Array<{ command: string; args: string[]; options: { cwd: string; env: NodeJS.ProcessEnv } }> = [];
    const run = vi.fn((command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => {
      operations.push(args.includes("--assert-standard-deploy-safe") ? "guard" : "deploy");
      commands.push({ command, args, options });
      return 0;
    });
    const materialize = vi.fn(async () => {
      operations.push("materialize");
      return ["/minecraft/cloudflare-api-token"];
    });

    await orchestrateCdkDeploy(["--require-approval", "never"], targetEnvironment(), { run, materialize });

    expect(operations).toEqual(["guard", "materialize", "deploy"]);
    expect(commands[0].args).toEqual([
      "exec",
      "tsx",
      "scripts/aws/migrate-existing-deployment.ts",
      "--assert-standard-deploy-safe",
      "--account",
      "123456789012",
      "--region",
      "us-east-1",
      "--stack-name",
      "MinecraftStack",
    ]);
    expect(commands[1].args).toEqual(["exec", "cdk", "deploy", "MinecraftStack", "--require-approval", "never"]);
    expect(commands.flatMap(({ args }) => args)).not.toContain("credential-sentinel-never-an-argument");
    expect(materialize).toHaveBeenCalledWith(expect.objectContaining({ CDK_DEFAULT_REGION: "us-east-1" }));
  });

  it("does not mutate DNS credentials when the safety guard refuses deployment", async () => {
    const materialize = vi.fn(async () => ["/minecraft/cloudflare-api-token"]);
    const run = vi.fn(() => 1);

    await expect(orchestrateCdkDeploy([], targetEnvironment(), { run, materialize })).rejects.toThrow(
      "DNS credentials were not changed"
    );
    expect(materialize).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not disclose a credential included in a materialization failure", async () => {
    const token = "credential-sentinel-never-an-error";
    const materialize = vi.fn(async () => {
      throw new Error(`provider rejected ${token}`);
    });

    let message = "";
    try {
      await orchestrateCdkDeploy([], targetEnvironment(), { run: () => 0, materialize });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("credential values were omitted");
    expect(message).not.toContain(token);
  });

  it("preserves explicit shell targets while loading production values with override semantics", () => {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      CDK_DEFAULT_ACCOUNT: "123456789012",
      CDK_DEFAULT_REGION: "us-east-1",
      MC_CONNECTION_MODE: "raw_ip",
    };

    const selected = loadEnvironmentPreservingCdkTarget(environment, () => {
      environment.CDK_DEFAULT_ACCOUNT = "999999999999";
      environment.CDK_DEFAULT_REGION = "eu-west-1";
      environment.MC_CONNECTION_MODE = "cloudflare";
      return ".env.production";
    });

    expect(selected).toBe(".env.production");
    expect(resolveDeployTarget(environment)).toEqual({
      account: "123456789012",
      region: "us-east-1",
      stackName: "MinecraftStack",
    });
    expect(environment.MC_CONNECTION_MODE).toBe("cloudflare");
  });
});
