import {
  AttachVolumeCommand,
  CreateVolumeCommand,
  DeleteVolumeCommand,
  DescribeImagesCommand,
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  DetachVolumeCommand,
  EC2Client,
  StartInstancesCommand,
  StopInstancesCommand,
} from "@aws-sdk/client-ec2";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import {
  GetCommandInvocationCommand,
  GetParameterCommand,
  PutParameterCommand,
  SSMClient,
  SendCommandCommand,
} from "@aws-sdk/client-ssm";

// Instantiate clients without hardcoding region (SDK will infer based on the env)
// v2 - email parsing fix
const ec2 = new EC2Client({});
const ses = new SESClient({});
const ssm = new SSMClient({});

// Export clients
export { ec2, ses, ssm };

// Re-export all Command classes for convenience
export {
  AttachVolumeCommand,
  CreateVolumeCommand,
  DeleteVolumeCommand,
  DescribeImagesCommand,
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  DetachVolumeCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  SendEmailCommand,
  GetCommandInvocationCommand,
  GetParameterCommand,
  PutParameterCommand,
  SendCommandCommand,
};
