import { getAwsClientConfig, getRuntimeEnvString } from "@/lib/aws/aws-client-config";
import { DescribeInstancesCommand, EC2Client } from "@aws-sdk/client-ec2";
import { type NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const probeTokenName = "MC_AWS_RUNTIME_CREDENTIAL_PROBE_TOKEN";
const candidateAccessKeyName = "MC_AWS_RUNTIME_CANDIDATE_ACCESS_KEY_ID";
const candidateSecretKeyName = "MC_AWS_RUNTIME_CANDIDATE_SECRET_ACCESS_KEY";

async function tokensMatch(received: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [receivedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(received)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const receivedBytes = new Uint8Array(receivedDigest);
  const expectedBytes = new Uint8Array(expectedDigest);
  let difference = receivedBytes.length ^ expectedBytes.length;

  for (let index = 0; index < Math.max(receivedBytes.length, expectedBytes.length); index += 1) {
    difference |= (receivedBytes[index] ?? 0) ^ (expectedBytes[index] ?? 0);
  }

  return difference === 0;
}

function unavailable(): NextResponse {
  return NextResponse.json({ success: false, error: "Not found" }, { status: 404 });
}

function resolveProbeCredentials(usePrimary: boolean): { accessKeyId: string; secretAccessKey: string } | null {
  const accessKeyId = getRuntimeEnvString(usePrimary ? "AWS_ACCESS_KEY_ID" : candidateAccessKeyName) ?? "";
  const secretAccessKey = getRuntimeEnvString(usePrimary ? "AWS_SECRET_ACCESS_KEY" : candidateSecretKeyName) ?? "";
  return accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const expectedToken = getRuntimeEnvString(probeTokenName);
  if (!expectedToken) {
    return unavailable();
  }

  const authorization = request.headers.get("authorization") ?? "";
  const receivedToken = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  if (!receivedToken || !(await tokensMatch(receivedToken, expectedToken))) {
    return unavailable();
  }

  const region = getRuntimeEnvString("AWS_REGION") ?? "";
  const instanceId = getRuntimeEnvString("INSTANCE_ID") ?? "";
  const usePrimary = request.nextUrl.searchParams.get("mode") === "primary";
  const credentials = resolveProbeCredentials(usePrimary);

  if (!region || !instanceId || !credentials) {
    return NextResponse.json({ success: false, error: "Runtime credential probe is incomplete" }, { status: 503 });
  }

  try {
    const ec2 = new EC2Client(getAwsClientConfig(region, credentials));
    const response = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    const resolvedInstanceId = response.Reservations?.[0]?.Instances?.[0]?.InstanceId;

    if (resolvedInstanceId !== instanceId) {
      return NextResponse.json({ success: false, error: "Managed instance was not returned" }, { status: 502 });
    }

    return NextResponse.json(
      {
        success: true,
        data: {
          identity: usePrimary ? "primary" : "candidate",
          managedInstanceVerified: true,
        },
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    console.error("[RUNTIME-CREDENTIAL-PROBE] AWS verification failed");
    return NextResponse.json({ success: false, error: "AWS runtime credential verification failed" }, { status: 502 });
  }
}
