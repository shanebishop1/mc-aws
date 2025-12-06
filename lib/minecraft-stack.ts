import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sesActions from 'aws-cdk-lib/aws-ses-actions';
import * as fs from 'fs';
import * as path from 'path';

export class MinecraftStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1. VPC (Use default to save cost/complexity, or create new)
    const vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', {
      isDefault: true,
    });

    // 2. IAM Role for EC2
    const ec2Role = new iam.Role(this, 'MinecraftServerRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // Add permissions to read SSM parameters (GitHub credentials)
    ec2Role.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/minecraft/*`
      ],
    }));
    
    // Add permission to decrypt (needed for SecureString)
    ec2Role.addToPolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: ['*'], // Scope this down if you have a specific KMS key
    }));

    // Add permission to stop itself
    ec2Role.addToPolicy(new iam.PolicyStatement({
      actions: ['ec2:StopInstances'],
      resources: ['*'], // We can't easily restrict to "self" in IAM without tags, but the script uses instance metadata to find its own ID
    }));

    // 3. Security Group
    const securityGroup = new ec2.SecurityGroup(this, 'MinecraftSecurityGroup', {
      vpc,
      description: 'Allow Minecraft and SSH access',
      allowAllOutbound: true,
    });
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(25565), 'Allow Minecraft');
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'Allow SSH');

    // 4. EC2 Instance
    const userDataScript = fs.readFileSync(path.join(__dirname, '../src/ec2/user_data.sh'), 'utf8');

    const instance = new ec2.Instance(this, 'MinecraftServer', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MEDIUM),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      securityGroup,
      role: ec2Role,
      userData: ec2.UserData.custom(userDataScript),
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(10, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
      ],
    });

    // Tag for backups (DLM)
    cdk.Tags.of(instance).add('Backup', 'weekly');


    // 5. SNS Topic for Start Trigger
    const startTopic = new sns.Topic(this, 'MinecraftStartTopic', {
      displayName: 'Minecraft Start Trigger',
    });

    // 6. Lambda Function to Start Server
    const startLambda = new lambda.Function(this, 'StartMinecraftLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../src/lambda/StartMinecraftServer')),
      environment: {
        INSTANCE_ID: instance.instanceId,
        // These need to be provided via context or manually set after deploy if not hardcoded
        CLOUDFLARE_ZONE_ID: process.env.CLOUDFLARE_ZONE_ID || '', 
        CLOUDFLARE_RECORD_ID: process.env.CLOUDFLARE_RECORD_ID || '',
        CLOUDFLARE_MC_DOMAIN: process.env.CLOUDFLARE_MC_DOMAIN || '',
        CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN || '',
        VERIFIED_SENDER: process.env.VERIFIED_SENDER || '',
        START_KEYWORD: process.env.START_KEYWORD || 'start',
        NOTIFICATION_EMAIL: process.env.NOTIFICATION_EMAIL || '',
      },
      timeout: cdk.Duration.seconds(60), // Give it time to poll EC2
    });

    // Grant Lambda permissions
    startLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:StartInstances', 'ec2:DescribeInstances'],
      resources: ['*'],
    }));
    
    // Grant Lambda permission to send email (for notifications)
    startLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: ['*'],
    }));

    // Subscribe Lambda to SNS
    startTopic.addSubscription(new subscriptions.LambdaSubscription(startLambda));

    // 7. SES Receipt Rule
    // Note: You must manually verify the domain/email in SES Console first!
    const ruleSet = ses.ReceiptRuleSet.fromReceiptRuleSetName(this, 'RuleSet', 'default-rule-set');
    
    // We can't easily import an existing rule set by name to add rules to it in CDK without looking it up.
    // For simplicity in this standalone stack, we'll assume we're creating a new rule 
    // or the user will add this rule to their existing set manually if they prefer.
    // However, CDK's `ReceiptRule` construct tries to create a RuleSet if one isn't provided.
    
    // Strategy: Create a new Rule Set for this stack to avoid conflict, 
    // OR ask user to activate it. 
    // Better: Just define the rule and let CDK manage a RuleSet named 'MinecraftRuleSet'.
    
    const mcRuleSet = new ses.ReceiptRuleSet(this, 'MinecraftRuleSet', {
        receiptRuleSetName: 'MinecraftRuleSet',
    });

    mcRuleSet.addRule('StartServerRule', {
      recipients: [process.env.VERIFIED_SENDER || 'start@example.com'], // The email to listen for
      actions: [
        new sesActions.Sns({
          topic: startTopic,
        }),
      ],
    });

    // Outputs
    new cdk.CfnOutput(this, 'InstanceId', { value: instance.instanceId });
    new cdk.CfnOutput(this, 'PublicIp', { value: instance.instancePublicIp });
    new cdk.CfnOutput(this, 'LambdaFunctionName', { value: startLambda.functionName });
  }
}
