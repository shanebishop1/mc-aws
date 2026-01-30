/**
 * AWS client modules - barrel export
 * All functions delegate to the selected provider (AWS or mock)
 */

import type { CostData } from "../types";
import { getProvider } from "./provider-selector";

// Re-export types for backward compatibility
export type { CostBreakdown } from "./cost-client";
export type { AwsProvider, InstanceDetails, ServerActionLock, PlayerCount, BackupInfo } from "./types";

// Re-export constants for backward compatibility
export { MAX_POLL_ATTEMPTS, POLL_INTERVAL_MS } from "./ec2-client";

// Re-export AWS SDK clients for backward compatibility (only available in AWS mode)
// Note: These will throw errors in mock mode if accessed
export { ec2 } from "./ec2-client";
export { ssm } from "./ssm-client";
export { cloudformation } from "./cloudformation-client";

// Instance resolution (shared utility)
export async function findInstanceId(): Promise<string> {
  return getProvider().findInstanceId();
}

export async function resolveInstanceId(instanceId?: string): Promise<string> {
  return getProvider().resolveInstanceId(instanceId);
}

// EC2 operations
export async function getInstanceState(instanceId?: string) {
  return getProvider().getInstanceState(instanceId);
}

export async function getInstanceDetails(instanceId?: string) {
  return getProvider().getInstanceDetails(instanceId);
}

export async function startInstance(instanceId?: string): Promise<void> {
  return getProvider().startInstance(instanceId);
}

export async function stopInstance(instanceId?: string): Promise<void> {
  return getProvider().stopInstance(instanceId);
}

export async function getPublicIp(instanceId: string, timeoutSeconds?: number): Promise<string> {
  return getProvider().getPublicIp(instanceId, timeoutSeconds);
}

export async function waitForInstanceRunning(instanceId: string, timeoutSeconds?: number): Promise<void> {
  return getProvider().waitForInstanceRunning(instanceId, timeoutSeconds);
}

export async function waitForInstanceStopped(instanceId: string, timeoutSeconds?: number): Promise<void> {
  return getProvider().waitForInstanceStopped(instanceId, timeoutSeconds);
}

// SSM operations
export async function executeSSMCommand(instanceId: string, commands: string[]): Promise<string> {
  return getProvider().executeSSMCommand(instanceId, commands);
}

export async function listBackups(instanceId?: string) {
  return getProvider().listBackups(instanceId);
}

export async function getEmailAllowlist(): Promise<string[]> {
  return getProvider().getEmailAllowlist();
}

export async function updateEmailAllowlist(emails: string[]): Promise<void> {
  return getProvider().updateEmailAllowlist(emails);
}

export async function getPlayerCount(): Promise<{ count: number; lastUpdated: string }> {
  return getProvider().getPlayerCount();
}

export async function getParameter(name: string): Promise<string | null> {
  return getProvider().getParameter(name);
}

export async function putParameter(name: string, value: string, type?: "String" | "SecureString"): Promise<void> {
  return getProvider().putParameter(name, value, type);
}

export async function deleteParameter(name: string): Promise<void> {
  return getProvider().deleteParameter(name);
}

export async function getServerAction(): Promise<{ action: string; timestamp: number } | null> {
  return getProvider().getServerAction();
}

export async function setServerAction(action: string): Promise<void> {
  return getProvider().setServerAction(action);
}

export async function withServerActionLock<T>(actionName: string, fn: () => Promise<T>): Promise<T> {
  return getProvider().withServerActionLock(actionName, fn);
}

// Volume operations
export async function detachAndDeleteVolumes(instanceId?: string): Promise<void> {
  return getProvider().detachAndDeleteVolumes(instanceId);
}

export async function handleResume(instanceId?: string): Promise<void> {
  return getProvider().handleResume(instanceId);
}

// Cost Explorer operations
export async function getCosts(periodType?: "current-month" | "last-month" | "last-30-days"): Promise<CostData> {
  return getProvider().getCosts(periodType);
}

// CloudFormation operations
export async function getStackStatus(stackName?: string) {
  return getProvider().getStackStatus(stackName);
}

export async function checkStackExists(stackName?: string): Promise<boolean> {
  return getProvider().checkStackExists(stackName);
}
