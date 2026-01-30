import { beforeEach, vi } from "vitest";
import { mockCostExplorerClient, mockEC2Client, mockSSMClient } from "./mocks/aws";

// Mock AWS SDK v3
vi.mock("@aws-sdk/client-ec2", async () => {
  const actual = (await vi.importActual("@aws-sdk/client-ec2")) as Record<string, unknown>;
  return {
    ...actual,
    EC2Client: class {
      send = mockEC2Client.send;
    },
  };
});

vi.mock("@aws-sdk/client-ssm", async () => {
  const actual = (await vi.importActual("@aws-sdk/client-ssm")) as Record<string, unknown>;
  return {
    ...actual,
    SSMClient: class {
      send = mockSSMClient.send;
    },
  };
});

vi.mock("@aws-sdk/client-cost-explorer", async () => {
  const actual = (await vi.importActual("@aws-sdk/client-cost-explorer")) as Record<string, unknown>;
  return {
    ...actual,
    CostExplorerClient: class {
      send = mockCostExplorerClient.send;
    },
  };
});

// Mock environment variables
vi.mock("@/lib/env", () => ({
  env: {
    AWS_REGION: "us-east-1",
    AWS_ACCOUNT_ID: "123456789012",
    INSTANCE_ID: "i-1234567890abcdef0",
    CLOUDFLARE_ZONE_ID: "zone123",
    CLOUDFLARE_RECORD_ID: "record123",
    CLOUDFLARE_MC_DOMAIN: "mc.example.com",
    CLOUDFLARE_API_TOKEN: "token123",
    GDRIVE_REMOTE: "gdrive",
    GDRIVE_ROOT: "mc-backups",
    MC_BACKEND_MODE: "aws",
  },
  getBackendMode: () => {
    const mode = process.env.MC_BACKEND_MODE;
    if (!mode) {
      return "aws"; // Default to aws mode
    }
    const normalizedValue = mode.toLowerCase().trim();
    if (normalizedValue !== "aws" && normalizedValue !== "mock") {
      throw new Error(`Invalid MC_BACKEND_MODE value: "${mode}". Must be "aws" or "mock".`);
    }
    return normalizedValue as "aws" | "mock";
  },
  isMockMode: () => {
    const mode = process.env.MC_BACKEND_MODE;
    return mode?.toLowerCase().trim() === "mock";
  },
  isAwsMode: () => {
    const mode = process.env.MC_BACKEND_MODE;
    return !mode || mode.toLowerCase().trim() === "aws";
  },
}));

// Global cleanup
beforeEach(() => {
  mockEC2Client.send.mockReset();
  mockSSMClient.send.mockReset();
  mockCostExplorerClient.send.mockReset();
  vi.clearAllMocks();
});
