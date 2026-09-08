import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  AttachVolumeCommand,
  CreateVolumeCommand,
  DeleteVolumeCommand,
  DescribeImagesCommand,
  DescribeInstancesCommand,
  DescribeSnapshotsCommand,
  DescribeVolumesCommand,
  DetachVolumeCommand,
  EC2Client,
  StartInstancesCommand,
  StopInstancesCommand,
} from "@aws-sdk/client-ec2";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import {
  CancelCommandCommand,
  GetCommandInvocationCommand,
  GetParameterCommand,
  PutParameterCommand,
  SSMClient,
  SendCommandCommand,
} from "@aws-sdk/client-ssm";

// Instantiate clients without hardcoding region (SDK will infer based on the env)
// v2 - email parsing fix
const ec2 = new EC2Client({});
const dynamodb = new DynamoDBClient({});
const ses = new SESClient({});
const ssm = new SSMClient({});

// Export clients
export { dynamodb, ec2, ses, ssm };

// Re-export all Command classes for convenience
export {
  AttachVolumeCommand,
  GetItemCommand,
  PutItemCommand,
  CreateVolumeCommand,
  DeleteVolumeCommand,
  DescribeImagesCommand,
  DescribeInstancesCommand,
  DescribeSnapshotsCommand,
  DescribeVolumesCommand,
  DetachVolumeCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  UpdateItemCommand,
  TransactWriteItemsCommand,
  SendEmailCommand,
  CancelCommandCommand,
  GetCommandInvocationCommand,
  GetParameterCommand,
  PutParameterCommand,
  SendCommandCommand,
};
