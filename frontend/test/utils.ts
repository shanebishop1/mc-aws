import { NextRequest } from "next/server";
import type { NextResponse } from "next/server";
import { mockDescribeInstances } from "./mocks/aws";

/**
 * Creates a mock NextRequest object
 */
export function createMockNextRequest(url: string, options: RequestInit = {}) {
  // Cast to any to avoid signal incompatibility in tests
  return new NextRequest(new URL(url, "http://localhost"), options as any);
}

/**
 * Parses the JSON body of a NextResponse
 */
export async function parseNextResponse<T>(response: NextResponse): Promise<T> {
  return (await response.json()) as T;
}

/**
 * Sets up a mock EC2 instance in the specified state
 * Sets it for all subsequent calls by default as multiple functions may call DescribeInstances
 */
export function setupInstanceState(state: string, publicIp?: string, hasVolume = true) {
  mockDescribeInstances(
    [
      {
        InstanceId: "i-1234567890abcdef0",
        State: { Name: state },
        PublicIpAddress: publicIp,
        BlockDeviceMappings: hasVolume ? [{ DeviceName: "/dev/sda1" }] : [],
      },
    ],
    false
  );
}
