import { GET } from "@/app/api/internal/runtime-credentials/verify/route";
import { mockEC2Client } from "@/tests/mocks/aws";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeValues: Record<string, string> = {
  MC_AWS_RUNTIME_CREDENTIAL_PROBE_TOKEN: "deployment-probe-token",
  MC_AWS_RUNTIME_CANDIDATE_ACCESS_KEY_ID: "AKIACANDIDATE",
  MC_AWS_RUNTIME_CANDIDATE_SECRET_ACCESS_KEY: "candidate-secret",
  AWS_ACCESS_KEY_ID: "AKIAPRIMARY",
  AWS_SECRET_ACCESS_KEY: "primary-secret",
  AWS_REGION: "us-west-1",
  INSTANCE_ID: "i-1234567890abcdef0",
};

const getAwsClientConfigMock = vi.fn((_region: string, credentials: unknown) => ({ credentials }));

vi.mock("@/lib/aws/aws-client-config", () => ({
  getRuntimeEnvString: (name: string) => runtimeValues[name] ?? null,
  getAwsClientConfig: (region: string, credentials: unknown) => getAwsClientConfigMock(region, credentials),
}));

describe("runtime credential deployment probe", () => {
  beforeEach(() => {
    mockEC2Client.send.mockResolvedValue({
      Reservations: [{ Instances: [{ InstanceId: runtimeValues.INSTANCE_ID }] }],
    });
  });

  it("does not call AWS without the ephemeral bearer token", async () => {
    const response = await GET(new NextRequest("https://panel.example.com/api/internal/runtime-credentials/verify"));

    expect(response.status).toBe(404);
    expect(mockEC2Client.send).not.toHaveBeenCalled();
  });

  it("verifies staged candidate credentials against the managed instance", async () => {
    const request = new NextRequest(
      "https://panel.example.com/api/internal/runtime-credentials/verify?mode=candidate",
      {
        headers: { authorization: `Bearer ${runtimeValues.MC_AWS_RUNTIME_CREDENTIAL_PROBE_TOKEN}` },
      }
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { identity: "candidate", managedInstanceVerified: true },
    });
    expect(getAwsClientConfigMock).toHaveBeenCalledWith("us-west-1", {
      accessKeyId: "AKIACANDIDATE",
      secretAccessKey: "candidate-secret",
    });
  });

  it("can verify promoted primary credentials before old-key revocation", async () => {
    const request = new NextRequest("https://panel.example.com/api/internal/runtime-credentials/verify?mode=primary", {
      headers: { authorization: `Bearer ${runtimeValues.MC_AWS_RUNTIME_CREDENTIAL_PROBE_TOKEN}` },
    });
    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(getAwsClientConfigMock).toHaveBeenCalledWith("us-west-1", {
      accessKeyId: "AKIAPRIMARY",
      secretAccessKey: "primary-secret",
    });
  });
});
