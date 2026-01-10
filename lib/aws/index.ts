/**
 * AWS client modules - barrel export
 */

// Instance resolution (shared utility)
export { findInstanceId, resolveInstanceId } from "./instance-resolver";

// EC2 operations
export {
  ec2,
  MAX_POLL_ATTEMPTS,
  POLL_INTERVAL_MS,
  getInstanceState,
  getInstanceDetails,
  waitForInstanceRunning,
  waitForInstanceStopped,
  getPublicIp,
  startInstance,
  stopInstance,
} from "./ec2-client";

// SSM operations
export {
  ssm,
  executeSSMCommand,
  listBackups,
  getEmailAllowlist,
  updateEmailAllowlist,
  getPlayerCount,
  getParameter,
} from "./ssm-client";

// Volume operations
export {
  detachAndDeleteVolumes,
  handleResume,
} from "./volume-client";

// Cost Explorer operations
export type { CostBreakdown, CostData } from "./cost-client";
export { getCosts } from "./cost-client";

// CloudFormation operations
export {
  cloudformation,
  getStackStatus,
  checkStackExists,
} from "./cloudformation-client";
