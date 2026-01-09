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

/**
 * Helper to mock SSM GetParameter response
 */
export const mockGetParameter = (value: string, once = true) => {
  const response = {
    Parameter: { Value: value },
  };
  if (once) {
    mockSSMClient.send.mockResolvedValueOnce(response);
  } else {
    mockSSMClient.send.mockResolvedValue(response);
  }
};

/**
 * Helper to mock SSM SendCommand response
 */
export const mockSendCommand = (commandId: string) => {
  mockSSMClient.send.mockResolvedValueOnce({
    Command: { CommandId: commandId },
  });
};

/**
 * Helper to mock SSM GetCommandInvocation response
 */
export const mockGetCommandInvocation = (status: string, output: string) => {
  mockSSMClient.send.mockResolvedValueOnce({
    Status: status,
    StandardOutputContent: output,
  });
};
