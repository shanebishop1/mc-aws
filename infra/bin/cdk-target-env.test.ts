import { describe, expect, it } from "vitest";
import { loadEnvironmentPreservingCdkTarget } from "./cdk-target-env";

describe("CDK target environment loading", () => {
  it("preserves explicit account and region while allowing dotenv to populate other values", () => {
    const environment = {
      CDK_DEFAULT_ACCOUNT: "123456789012",
      CDK_DEFAULT_REGION: "us-west-1",
    } as NodeJS.ProcessEnv;

    loadEnvironmentPreservingCdkTarget(() => {
      environment.CDK_DEFAULT_ACCOUNT = "999999999999";
      environment.CDK_DEFAULT_REGION = "eu-west-1";
      environment.GITHUB_USER = "from-dotenv";
    }, environment);

    expect(environment).toMatchObject({
      CDK_DEFAULT_ACCOUNT: "123456789012",
      CDK_DEFAULT_REGION: "us-west-1",
      GITHUB_USER: "from-dotenv",
    });
  });

  it("retains dotenv behavior for unset or blank target variables", () => {
    const environment = { CDK_DEFAULT_REGION: "" } as NodeJS.ProcessEnv;

    loadEnvironmentPreservingCdkTarget(() => {
      environment.CDK_DEFAULT_ACCOUNT = "123456789012";
      environment.CDK_DEFAULT_REGION = "us-west-1";
    }, environment);

    expect(environment.CDK_DEFAULT_ACCOUNT).toBe("123456789012");
    expect(environment.CDK_DEFAULT_REGION).toBe("us-west-1");
  });
});
