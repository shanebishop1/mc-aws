import * as iam from "aws-cdk-lib/aws-iam";

/**
 * AWS calls reachable from the deployed control-panel Worker.
 *
 * Keep this contract aligned with the command classes used by lib/aws and the
 * API routes that call them. Lifecycle volume mutations run in the Lambda and
 * intentionally do not belong to the Worker identity.
 */
export const workerRuntimeAwsCallGraph = {
  instanceStatus: ["ec2:DescribeInstances"],
  stopInstance: ["ec2:StopInstances"],
  invokeLifecycle: ["lambda:InvokeFunction"],
  stackStatus: ["cloudformation:DescribeStacks"],
  runInstanceCommand: ["ssm:SendCommand", "ssm:GetCommandInvocation"],
  readRuntimeParameters: ["ssm:GetParameter", "ssm:GetParametersByPath"],
  writeRuntimeParameters: ["ssm:PutParameter", "ssm:DeleteParameter"],
  optionalCostData: ["ce:GetCostAndUsage"],
} as const;

export const workerRuntimeRequiredAwsActions = [
  ...workerRuntimeAwsCallGraph.instanceStatus,
  ...workerRuntimeAwsCallGraph.stopInstance,
  ...workerRuntimeAwsCallGraph.invokeLifecycle,
  ...workerRuntimeAwsCallGraph.stackStatus,
  ...workerRuntimeAwsCallGraph.runInstanceCommand,
  ...workerRuntimeAwsCallGraph.readRuntimeParameters,
  ...workerRuntimeAwsCallGraph.writeRuntimeParameters,
] as const;

export interface WorkerRuntimePolicyResources {
  instanceArn: string;
  lifecycleLambdaArn: string;
  stackArn: string;
  runShellScriptDocumentArn: string;
  readableParameterArns: string[];
  writableParameterArns: string[];
  deletableParameterArns: string[];
  operationParameterPathArns: string[];
  includeCostExplorer: boolean;
}

export function createWorkerRuntimePolicyStatements(resources: WorkerRuntimePolicyResources): iam.PolicyStatement[] {
  const statements = [
    new iam.PolicyStatement({
      sid: "DescribeManagedInstance",
      actions: [...workerRuntimeAwsCallGraph.instanceStatus],
      // EC2 DescribeInstances does not support resource-level permissions.
      resources: ["*"],
    }),
    new iam.PolicyStatement({
      sid: "StopManagedInstance",
      actions: [...workerRuntimeAwsCallGraph.stopInstance],
      resources: [resources.instanceArn],
    }),
    new iam.PolicyStatement({
      sid: "InvokeLifecycleLambda",
      actions: [...workerRuntimeAwsCallGraph.invokeLifecycle],
      resources: [resources.lifecycleLambdaArn],
    }),
    new iam.PolicyStatement({
      sid: "DescribeManagedStack",
      actions: [...workerRuntimeAwsCallGraph.stackStatus],
      resources: [resources.stackArn],
    }),
    new iam.PolicyStatement({
      sid: "SendCommandToManagedInstance",
      actions: ["ssm:SendCommand"],
      resources: [resources.runShellScriptDocumentArn, resources.instanceArn],
    }),
    new iam.PolicyStatement({
      sid: "ReadCommandResult",
      actions: ["ssm:GetCommandInvocation"],
      // GetCommandInvocation does not support resource-level permissions.
      resources: ["*"],
    }),
    new iam.PolicyStatement({
      sid: "ReadRuntimeParameters",
      actions: ["ssm:GetParameter"],
      resources: resources.readableParameterArns,
    }),
    new iam.PolicyStatement({
      sid: "ListOperationParameters",
      actions: ["ssm:GetParametersByPath"],
      resources: resources.operationParameterPathArns,
    }),
    new iam.PolicyStatement({
      sid: "WriteRuntimeParameters",
      actions: ["ssm:PutParameter"],
      resources: resources.writableParameterArns,
    }),
    new iam.PolicyStatement({
      sid: "DeleteRuntimeParameters",
      actions: ["ssm:DeleteParameter"],
      resources: resources.deletableParameterArns,
    }),
  ];

  if (resources.includeCostExplorer) {
    statements.push(
      new iam.PolicyStatement({
        sid: "ReadOptionalCostData",
        actions: [...workerRuntimeAwsCallGraph.optionalCostData],
        // Cost Explorer GetCostAndUsage does not support resource-level permissions.
        resources: ["*"],
      })
    );
  }

  return statements;
}
