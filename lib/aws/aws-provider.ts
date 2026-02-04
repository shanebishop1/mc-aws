/**
 * Real AWS provider implementation
 * Wraps existing AWS SDK client functions
 */

import type { Stack } from "@aws-sdk/client-cloudformation";
import type { CostData } from "../types";
import type { AwsProvider, BackupInfo, InstanceDetails, PlayerCount } from "./types";

import { checkStackExists, getStackStatus } from "./cloudformation-client";
import { getCosts } from "./cost-client";
// Import all existing AWS client functions
import {
  findInstanceId,
  getInstanceDetails,
  getInstanceState,
  getPublicIp,
  resolveInstanceId,
  startInstance,
  stopInstance,
  waitForInstanceRunning,
  waitForInstanceStopped,
} from "./ec2-client";
import { invokeLambda } from "./lambda-client";
import {
  deleteParameter,
  executeSSMCommand,
  getEmailAllowlist,
  getParameter,
  getPlayerCount,
  listBackups,
  putParameter,
  updateEmailAllowlist,
} from "./ssm-client";
import { detachAndDeleteVolumes, handleResume } from "./volume-client";

/**
 * Real AWS provider that uses actual AWS SDK clients
 * This provider initializes AWS clients on module load
 */
export const awsProvider: AwsProvider = {
  // EC2 - Instance Management
  findInstanceId,
  resolveInstanceId,
  getInstanceState,
  getInstanceDetails,
  startInstance,
  stopInstance,
  getPublicIp,
  waitForInstanceRunning,
  waitForInstanceStopped,

  // EC2 - Volume Management
  detachAndDeleteVolumes,
  handleResume,

  // SSM - Command Execution
  executeSSMCommand,
  listBackups,

  // SSM - Parameter Store
  getParameter,
  putParameter,
  deleteParameter,

  // SSM - Application-Specific Parameters
  getEmailAllowlist,
  updateEmailAllowlist,
  getPlayerCount,

  // Cost Explorer
  getCosts,

  // CloudFormation
  getStackStatus,
  checkStackExists,

  // Lambda
  invokeLambda,
};
