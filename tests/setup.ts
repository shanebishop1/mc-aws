import { beforeEach, vi } from "vitest";
import { mockCostExplorerClient, mockEC2Client, mockSSMClient } from "./mocks/aws";

// Mock authentication functions
vi.mock("@/lib/api-auth", () => ({
  getAuthUser: vi.fn().mockResolvedValue({
    email: "admin@example.com",
    role: "admin",
  }),
  requireAuth: vi.fn().mockResolvedValue({
    email: "admin@example.com",
    role: "admin",
  }),
  requireAllowed: vi.fn().mockResolvedValue({
    email: "admin@example.com",
    role: "admin",
  }),
  requireAdmin: vi.fn().mockResolvedValue({
    email: "admin@example.com",
    role: "admin",
  }),
}));

// Mock auth utilities
vi.mock("@/lib/auth", () => ({
  SESSION_COOKIE_NAME: "mc_session",
  verifySession: vi.fn().mockResolvedValue({
    email: "admin@example.com",
    role: "admin",
  }),
  createSession: vi.fn().mockResolvedValue("mock-jwt-token"),
  getUserRole: vi.fn().mockReturnValue("admin"),
  createSessionCookie: vi.fn().mockReturnValue({
    name: "mc_session",
    value: "mock-jwt-token",
    httpOnly: true,
    secure: false,
    sameSite: "lax",
    path: "/",
    maxAge: 604800,
  }),
  clearSessionCookie: vi.fn().mockReturnValue({
    name: "mc_session",
    value: "",
    httpOnly: true,
    secure: false,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  }),
}));

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
    CLOUDFLARE_DNS_API_TOKEN: "token123",
    GDRIVE_REMOTE: "gdrive",
    GDRIVE_ROOT: "mc-backups",
    MC_BACKEND_MODE: "aws",
    AUTH_SECRET: "test-secret-key-for-jwt-signing-12345678",
    ADMIN_EMAIL: "admin@example.com",
  },
  getEnv: (name: string, optional = false) => {
    const value = process.env[name];
    if (!value && !optional) {
      console.warn(`[WARN] Missing required environment variable: ${name}`);
      return "";
    }
    return value || "";
  },
  getNodeEnv: () => process.env.NODE_ENV,
  getBackendMode: () => {
    const mode = process.env.MC_BACKEND_MODE;
    if (!mode) {
      return "aws"; // Default to aws mode
    }
    const normalizedValue = mode.toLowerCase().trim();
    if (normalizedValue !== "aws" && normalizedValue !== "mock") {
      throw new Error(`Invalid MC_BACKEND_MODE value: "${mode}". Must be "aws" or "mock".`);
    }
    // Hard-fail if mock mode is enabled in production
    if (normalizedValue === "mock" && process.env.NODE_ENV === "production") {
      throw new Error(
        'MC_BACKEND_MODE="mock" is not allowed in production. Set MC_BACKEND_MODE="aws" or unset NODE_ENV.'
      );
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
  validateAwsCredentials: () => {
    // Skip validation in mock mode (mocked in tests that need specific behavior)
    const mode = process.env.MC_BACKEND_MODE;
    if (mode?.toLowerCase().trim() === "mock") {
      return;
    }
    // In AWS mode, check required credentials
    if (!process.env.AWS_REGION && !process.env.CDK_DEFAULT_REGION) {
      throw new Error("Missing required AWS credentials in AWS mode: AWS_REGION");
    }
    if (!process.env.INSTANCE_ID) {
      throw new Error("Missing required AWS credentials in AWS mode: INSTANCE_ID");
    }
  },
}));

// Global cleanup
beforeEach(() => {
  mockEC2Client.send.mockReset();
  mockSSMClient.send.mockReset();
  mockCostExplorerClient.send.mockReset();
  vi.clearAllMocks();
});
