import { vi } from "vitest";

export const mockEC2Client = {
  send: vi.fn(),
};

export const mockSSMClient = {
  send: vi.fn(),
};

export const mockCostExplorerClient = {
  send: vi.fn(),
};

/**
 * Helper to mock EC2 DescribeInstances response
 */
export const mockDescribeInstances = (instances: unknown[], once = true) => {
  const response = {
    Reservations: [{ Instances: instances }],
  };
  if (once) {
    mockEC2Client.send.mockResolvedValueOnce(response);
  } else {
    mockEC2Client.send.mockResolvedValue(response);
  }
};
