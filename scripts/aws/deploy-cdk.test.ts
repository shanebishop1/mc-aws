import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertLiveProviderEvidence,
  defaultDependencies,
  deployProviderBoundChangeSet,
  loadEnvironmentPreservingCdkTarget,
  orchestrateCdkDeploy,
  resolveDeployTarget,
  validateManifestClaim,
} from "./deploy-cdk";

const targetEnvironment = (): NodeJS.ProcessEnv => ({
  ...process.env,
  CDK_DEFAULT_ACCOUNT: "123456789012",
  CDK_DEFAULT_REGION: "us-east-1",
  CLOUDFLARE_DNS_API_TOKEN: "credential-sentinel-never-an-argument",
  MC_CONNECTION_MODE: "cloudflare",
});

const manifestClaim = {
  account: "123456789012",
  region: "us-east-1",
  stackName: "MinecraftStack",
  stackId: "",
  claimToken: "11111111-2222-4333-8444-555555555555",
};

function testDependencies(
  run: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => number,
  materialize: (environment: NodeJS.ProcessEnv) => Promise<string[]>,
  operations?: string[]
) {
  return {
    run,
    materialize,
    readManifestClaim: () => manifestClaim,
    synthesize: () => {
      operations?.push("synth");
      const directory = mkdtempSync(path.join(tmpdir(), "mc-aws-test-assembly-"));
      writeFileSync(
        path.join(directory, "manifest.json"),
        JSON.stringify({
          artifacts: {
            MinecraftStack: {
              type: "aws:cloudformation:stack",
              environment: "aws://123456789012/us-east-1",
              dependencies: ["MinecraftStack.assets"],
              properties: {
                templateFile: "MinecraftStack.template.json",
                stackTemplateAssetObjectUrl: "s3://cdk-test-assets-123456789012-us-east-1/template.json",
              },
            },
            "MinecraftStack.assets": {
              type: "cdk:asset-manifest",
              dependencies: [],
              properties: { file: "MinecraftStack.assets.json" },
            },
          },
        })
      );
      writeFileSync(
        path.join(directory, "MinecraftStack.assets.json"),
        JSON.stringify({
          files: {
            asset: {
              destinations: {
                destination: {
                  bucketName: "cdk-test-assets-123456789012-us-east-1",
                  region: "us-east-1",
                  assumeRoleArn: "arn:${AWS::Partition}:iam::123456789012:role/cdk-test-file-publishing-role",
                },
              },
            },
          },
          dockerImages: {},
        })
      );
      writeFileSync(
        path.join(directory, "MinecraftStack.template.json"),
        JSON.stringify({
          Tags: [{ Key: "McAwsClaimToken", Value: manifestClaim.claimToken }],
          Resources: {
            StackOwnershipClaim: {
              Type: "Custom::StackOwnershipClaim",
              Properties: {
                ServiceToken: "arn:aws:lambda:us-east-1:123456789012:function:adoption",
                StackOwnershipClaim: "true",
                ClaimParameter: "/minecraft/stack-ownership-claim",
                ClaimToken: manifestClaim.claimToken,
              },
            },
          },
        })
      );
      return directory;
    },
    recordOwnership: () => operations?.push("record"),
    deployProviderBoundChangeSet: () => {
      operations?.push("deploy");
      return 0;
    },
  };
}

function changeSetFixture() {
  const commands: string[][] = [];
  const operations: string[] = [];
  const dependencies = testDependencies(
    (command, args) => {
      commands.push([command, ...args]);
      return 0;
    },
    async () => [],
    operations
  );
  const assemblyDirectory = dependencies.synthesize!();
  operations.splice(0);
  const templatePath = path.join(assemblyDirectory, "MinecraftStack.template.json");
  const provider = (
    stackId: string,
    changeSetType: "CREATE" | "UPDATE",
    template = readFileSync(templatePath, "utf8"),
    preparedClaimToken = manifestClaim.claimToken,
    status = "CREATE_COMPLETE",
    executionStatus = "AVAILABLE"
  ) => ({
    describeChangeSet: async (_stackIdentifier: string, changeSetName: string) => ({
      changeSetId: `arn:aws:cloudformation:us-east-1:123456789012:changeSet/${changeSetName}/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
      changeSetName,
      stackId,
      stackName: "MinecraftStack",
      changeSetType,
      status,
      executionStatus,
    }),
    verifyPreparedChangeSet: async (
      _stackIdentifier: string,
      _changeSetId: string,
      _expectedChangeSetType: "CREATE" | "UPDATE",
      _expectedStackId: string,
      _claimToken: string
    ) => ({ changeSetType, stackId, claimToken: preparedClaimToken }),
    getChangeSetTemplate: async () => template,
    executeChangeSet: async (changeSetId: string) => {
      operations.push(`execute:${changeSetId}`);
    },
    waitForChangeSetExecution: async (changeSetId: string) => {
      operations.push(`change-set-complete:${changeSetId}`);
    },
    waitForStack: async (stackIdentifier: string, _region: string, type: string) => {
      operations.push(`wait:${stackIdentifier}:${type}`);
    },
    verifyExecutedStack: async (stackIdentifier: string) => {
      operations.push(`verify:${stackIdentifier}`);
    },
  });
  return { assemblyDirectory, commands, operations, provider, templatePath };
}

describe("standard CDK deployment orchestration", () => {
  it("configures a production provider-bound change-set executor by default", () => {
    expect(defaultDependencies.deployProviderBoundChangeSet).toBeTypeOf("function");
  });

  it("uses CREATE for an absent claim and UPDATE for the exact existing StackId", async () => {
    for (const [claim, expectedType, stackId] of [
      [manifestClaim, "CREATE", "arn:aws:cloudformation:us-east-1:123456789012:stack/MinecraftStack/created-id"],
      [
        {
          ...manifestClaim,
          stackId: "arn:aws:cloudformation:us-east-1:123456789012:stack/MinecraftStack/existing-id",
        },
        "UPDATE",
        "arn:aws:cloudformation:us-east-1:123456789012:stack/MinecraftStack/existing-id",
      ],
    ] as const) {
      const fixture = changeSetFixture();
      await deployProviderBoundChangeSet(
        claim,
        fixture.assemblyDirectory,
        targetEnvironment(),
        (command, args) => {
          fixture.commands.push([command, ...args]);
          return 0;
        },
        fixture.provider(stackId, expectedType)
      );
      expect(fixture.commands[0]).toContain("--method");
      expect(fixture.commands[0]).toContain("prepare-change-set");
      expect(fixture.operations).toContain(`wait:${stackId}:${expectedType}`);
      expect(
        fixture.operations.indexOf(`change-set-complete:${fixture.operations[0].slice("execute:".length)}`)
      ).toBeLessThan(fixture.operations.indexOf(`wait:${stackId}:${expectedType}`));
      expect(fixture.operations).toContain(`verify:${stackId}`);
    }
  });

  it("executes the exact provider ChangeSetId and never falls back to a name-only app", async () => {
    const fixture = changeSetFixture();
    await deployProviderBoundChangeSet(
      manifestClaim,
      fixture.assemblyDirectory,
      targetEnvironment(),
      (command, args) => {
        fixture.commands.push([command, ...args]);
        return 0;
      },
      fixture.provider("arn:aws:cloudformation:us-east-1:123456789012:stack/MinecraftStack/new-id", "CREATE")
    );
    expect(fixture.commands[0]).toEqual(
      expect.arrayContaining(["pnpm", "exec", "cdk", "deploy", "MinecraftStack", "--app", fixture.assemblyDirectory])
    );
    expect(fixture.commands[0]).not.toContain("--template");
    expect(fixture.operations.some((entry) => entry.startsWith("execute:arn:aws:cloudformation"))).toBe(true);
  });

  it("rejects wrong provider StackId, claim token, and template before execution", async () => {
    const existingClaim = {
      ...manifestClaim,
      stackId: "arn:aws:cloudformation:us-east-1:123456789012:stack/MinecraftStack/existing-id",
    };
    const wrongStack = changeSetFixture();
    await expect(
      deployProviderBoundChangeSet(
        existingClaim,
        wrongStack.assemblyDirectory,
        targetEnvironment(),
        () => 0,
        wrongStack.provider("arn:aws:cloudformation:us-east-1:123456789012:stack/MinecraftStack/wrong-id", "UPDATE")
      )
    ).rejects.toThrow("StackId");
    expect(wrongStack.operations).toEqual([]);

    const wrongToken = changeSetFixture();
    const wrongTokenTemplate = JSON.parse(readFileSync(wrongToken.templatePath, "utf8")) as {
      Resources: { StackOwnershipClaim: { Properties: { ClaimToken: string } } };
    };
    wrongTokenTemplate.Resources.StackOwnershipClaim.Properties.ClaimToken = "99999999-2222-4333-8444-555555555555";
    await expect(
      deployProviderBoundChangeSet(
        manifestClaim,
        wrongToken.assemblyDirectory,
        targetEnvironment(),
        () => 0,
        wrongToken.provider(
          "arn:aws:cloudformation:us-east-1:123456789012:stack/MinecraftStack/new-id",
          "CREATE",
          JSON.stringify(wrongTokenTemplate)
        )
      )
    ).rejects.toThrow("template");

    const wrongTemplate = changeSetFixture();
    await expect(
      deployProviderBoundChangeSet(
        manifestClaim,
        wrongTemplate.assemblyDirectory,
        targetEnvironment(),
        () => 0,
        wrongTemplate.provider(
          "arn:aws:cloudformation:us-east-1:123456789012:stack/MinecraftStack/new-id",
          "CREATE",
          JSON.stringify({ Resources: {} })
        )
      )
    ).rejects.toThrow("template");
  });

  it("rejects wrong ChangeSetType and absent/existing identity mismatches before template or execution", async () => {
    const wrongType = changeSetFixture();
    await expect(
      deployProviderBoundChangeSet(
        manifestClaim,
        wrongType.assemblyDirectory,
        targetEnvironment(),
        () => 0,
        wrongType.provider("arn:aws:cloudformation:us-east-1:123456789012:stack/MinecraftStack/new-id", "UPDATE")
      )
    ).rejects.toThrow("does not match CREATE");
    expect(wrongType.operations).toEqual([]);

    const absentIdentity = changeSetFixture();
    await expect(
      deployProviderBoundChangeSet(
        manifestClaim,
        absentIdentity.assemblyDirectory,
        targetEnvironment(),
        () => 0,
        absentIdentity.provider("arn:aws:cloudformation:us-east-1:123456789012:stack/OtherStack/new-id", "CREATE")
      )
    ).rejects.toThrow("exact deployment target");
    expect(absentIdentity.operations).toEqual([]);

    const existingIdentity = changeSetFixture();
    const existingClaim = {
      ...manifestClaim,
      stackId: "arn:aws:cloudformation:us-east-1:123456789012:stack/MinecraftStack/existing-id",
    };
    await expect(
      deployProviderBoundChangeSet(
        existingClaim,
        existingIdentity.assemblyDirectory,
        targetEnvironment(),
        () => 0,
        existingIdentity.provider(
          "arn:aws:cloudformation:us-east-1:123456789012:stack/MinecraftStack/other-id",
          "UPDATE"
        )
      )
    ).rejects.toThrow("StackId");
    expect(existingIdentity.operations).toEqual([]);
  });

  it("rechecks the provider claim token after preparation before execution", async () => {
    const fixture = changeSetFixture();
    const existingClaim = {
      ...manifestClaim,
      stackId: "arn:aws:cloudformation:us-east-1:123456789012:stack/MinecraftStack/existing-id",
    };
    await expect(
      deployProviderBoundChangeSet(
        existingClaim,
        fixture.assemblyDirectory,
        targetEnvironment(),
        () => 0,
        fixture.provider(existingClaim.stackId, "UPDATE", undefined, "99999999-2222-4333-8444-555555555555")
      )
    ).rejects.toThrow("claim token");
    expect(fixture.operations).toEqual([]);
  });

  it("requires an immutable provider change set to be complete and available", async () => {
    const fixture = changeSetFixture();
    await expect(
      deployProviderBoundChangeSet(
        manifestClaim,
        fixture.assemblyDirectory,
        targetEnvironment(),
        () => 0,
        fixture.provider(
          "arn:aws:cloudformation:us-east-1:123456789012:stack/MinecraftStack/new-id",
          "CREATE",
          undefined,
          manifestClaim.claimToken,
          "CREATE_PENDING",
          "AVAILABLE"
        )
      )
    ).rejects.toThrow("identity/status");
    expect(fixture.operations).toEqual([]);
  });

  it("does not accept a stale already-complete stack before the submitted change set completes", async () => {
    const fixture = changeSetFixture();
    const provider = fixture.provider(
      "arn:aws:cloudformation:us-east-1:123456789012:stack/MinecraftStack/new-id",
      "CREATE"
    );
    provider.waitForChangeSetExecution = async () => {
      throw new Error("change set is OBSOLETE");
    };
    await expect(
      deployProviderBoundChangeSet(manifestClaim, fixture.assemblyDirectory, targetEnvironment(), () => 0, provider)
    ).rejects.toThrow("OBSOLETE");
    expect(fixture.operations).toEqual([expect.stringMatching(/^execute:/)]);
  });

  it("fails closed for wrong StackId, claim token, and an absent-stack race", () => {
    const existing = {
      ...manifestClaim,
      stackId:
        "arn:aws:cloudformation:us-east-1:123456789012:stack/MinecraftStack/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    };
    expect(() => validateManifestClaim(existing)).not.toThrow();
    expect(() =>
      assertLiveProviderEvidence(existing, { ...existing, exists: true, stackId: `${existing.stackId}-wrong` })
    ).toThrow("StackId");
    expect(() =>
      assertLiveProviderEvidence(existing, {
        ...existing,
        exists: true,
        claimToken: "99999999-2222-4333-8444-555555555555",
      })
    ).toThrow("McAwsClaimToken");
    expect(() => assertLiveProviderEvidence(manifestClaim, { ...manifestClaim, exists: true })).toThrow("absent stack");
  });

  it("guards the exact CDK target before materializing DNS credentials and deploying", async () => {
    const operations: string[] = [];
    const commands: Array<{ command: string; args: string[]; options: { cwd: string; env: NodeJS.ProcessEnv } }> = [];
    const run = vi.fn((command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => {
      operations.push(
        args.includes("--assert-standard-deploy-safe") ? "guard" : args.includes("synth") ? "synth" : "deploy"
      );
      commands.push({ command, args, options });
      return 0;
    });
    const materialize = vi.fn(async () => {
      operations.push("materialize");
      return ["/minecraft/cloudflare-api-token"];
    });

    await orchestrateCdkDeploy(
      ["--require-approval", "never"],
      targetEnvironment(),
      testDependencies(run, materialize, operations)
    );

    expect(operations).toEqual(["synth", "guard", "materialize", "deploy", "record"]);
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
      "--assembly-directory",
      expect.any(String),
    ]);
    expect(commands).toHaveLength(1);
    expect(commands.flatMap(({ args }) => args)).not.toContain("credential-sentinel-never-an-argument");
    expect(materialize).toHaveBeenCalledWith(expect.objectContaining({ CDK_DEFAULT_REGION: "us-east-1" }));
  });

  it("does not mutate DNS credentials when the safety guard refuses deployment", async () => {
    const materialize = vi.fn(async () => ["/minecraft/cloudflare-api-token"]);
    const run = vi.fn(() => 1);

    await expect(orchestrateCdkDeploy([], targetEnvironment(), testDependencies(run, materialize))).rejects.toThrow(
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
      await orchestrateCdkDeploy(
        [],
        targetEnvironment(),
        testDependencies(() => 0, materialize)
      );
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

  it("rejects assembly-selection arguments before materializing credentials", async () => {
    const materialize = vi.fn(async () => ["/minecraft/cloudflare-api-token"]);
    const run = vi.fn(() => 0);
    for (const argument of ["--app", "-a", "--output", "-o", "--plugin", "-p", "--context", "-c"]) {
      await expect(
        orchestrateCdkDeploy([argument, "attacker-value"], targetEnvironment(), testDependencies(run, materialize))
      ).rejects.toThrow("canonical CDK assembly");
    }
    expect(materialize).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("requires the environment target to match the manifest claim", async () => {
    const environment = targetEnvironment();
    environment.CDK_DEFAULT_REGION = "us-west-2";
    await expect(
      orchestrateCdkDeploy(
        [],
        environment,
        testDependencies(
          () => 0,
          vi.fn(async () => [])
        )
      )
    ).rejects.toThrow("exactly match");
  });
});
