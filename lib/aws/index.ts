/**
 * AWS client modules - barrel export
 * All functions delegate to the selected provider (AWS or mock)
 */

import type { CostData } from "../types";
import { getProvider } from "./provider-selector";

// Re-export types for backward compatibility
export type { CostBreakdown } from "./cost-client";
export type { AwsProvider, InstanceDetails, PlayerCount, BackupInfo, ParameterStoreEntry } from "./types";

// Instance resolution (shared utility)
export async function findInstanceId(): Promise<string> {
  return (await getProvider()).findInstanceId();
}

export async function resolveInstanceId(instanceId?: string): Promise<string> {
  return (await getProvider()).resolveInstanceId(instanceId);
}

// EC2 operations
export async function getInstanceState(instanceId?: string) {
  return (await getProvider()).getInstanceState(instanceId);
}

export async function getInstanceDetails(instanceId?: string) {
  return (await getProvider()).getInstanceDetails(instanceId);
}

export async function startInstance(instanceId?: string): Promise<void> {
  return (await getProvider()).startInstance(instanceId);
}

export async function stopInstance(instanceId?: string): Promise<void> {
  return (await getProvider()).stopInstance(instanceId);
}

export async function getPublicIp(instanceId: string, timeoutSeconds?: number): Promise<string> {
  return (await getProvider()).getPublicIp(instanceId, timeoutSeconds);
}

export async function waitForInstanceRunning(instanceId: string, timeoutSeconds?: number): Promise<void> {
  return (await getProvider()).waitForInstanceRunning(instanceId, timeoutSeconds);
}

export async function waitForInstanceStopped(instanceId: string, timeoutSeconds?: number): Promise<void> {
  return (await getProvider()).waitForInstanceStopped(instanceId, timeoutSeconds);
}

// SSM operations
export async function executeSSMCommand(instanceId: string, commands: string[]): Promise<string> {
  return (await getProvider()).executeSSMCommand(instanceId, commands);
}

export async function listBackups(instanceId?: string) {
  return (await getProvider()).listBackups(instanceId);
}

export async function getEmailAllowlist(): Promise<string[]> {
  return (await getProvider()).getEmailAllowlist();
}

export async function updateEmailAllowlist(emails: string[]): Promise<void> {
  return (await getProvider()).updateEmailAllowlist(emails);
}

export async function getPlayerCount(): Promise<{ count: number; lastUpdated: string }> {
  return (await getProvider()).getPlayerCount();
}

export async function getParameter(name: string): Promise<string | null> {
  return (await getProvider()).getParameter(name);
}

export async function putParameter(
  name: string,
  value: string,
  type?: "String" | "SecureString",
  overwrite?: boolean
): Promise<void> {
  return (await getProvider()).putParameter(name, value, type, overwrite);
}

export async function deleteParameter(name: string): Promise<void> {
  return (await getProvider()).deleteParameter(name);
}

export async function listParametersByPath(path: string) {
  return (await getProvider()).listParametersByPath(path);
}

// Volume operations
export async function detachAndDeleteVolumes(instanceId?: string): Promise<void> {
  return (await getProvider()).detachAndDeleteVolumes(instanceId);
}

export async function handleResume(instanceId?: string): Promise<void> {
  return (await getProvider()).handleResume(instanceId);
}

// Cost Explorer operations
export async function getCosts(periodType?: "current-month" | "last-month" | "last-30-days"): Promise<CostData> {
  return (await getProvider()).getCosts(periodType);
}

// CloudFormation operations
export async function getStackStatus(stackName?: string) {
  return (await getProvider()).getStackStatus(stackName);
}

export async function checkStackExists(stackName?: string): Promise<boolean> {
  return (await getProvider()).checkStackExists(stackName);
}

// Lambda operations
export async function invokeLambda(functionName: string, payload: unknown): Promise<void> {
  return (await getProvider()).invokeLambda(functionName, payload);
}
