# AWS Credentials Setup Guide

This guide shows you how to get the AWS credentials needed for the control panel.

## Why AWS Credentials?

The control panel needs AWS credentials to:
- Start/stop your EC2 instance
- Check instance status
- Manage backups
- Update CloudFormation stacks

## Two Types of AWS Credentials

### 1. For Local Development & CDK Deploy
These are your **personal AWS account credentials** used to:
- Deploy infrastructure with CDK (`npm run deploy`)
- Run the control panel locally (`pnpm dev`)

### 2. For Production (Cloudflare Workers)
These can be either:
- **Option A:** Same as your personal credentials (simpler, less secure)
- **Option B:** Dedicated IAM user with minimal permissions (more secure)

---

## Getting Your AWS Credentials

### Step 1: Create an IAM User (Recommended)

**Why?** Instead of using your root account credentials, create a dedicated IAM user with only the permissions needed.

1. **Go to IAM Console:**
   - Visit [AWS IAM Console](https://console.aws.amazon.com/iam/)
   - Click **Users** → **Create user**

2. **Name the user:**
   - User name: `minecraft-control-panel`
   - Click **Next**

3. **Set permissions:**
   - Choose "Attach policies directly"
   - Search for and select these policies:
     - ✅ `AmazonEC2FullAccess` (for managing instances)
     - ✅ `CloudFormationFullAccess` (for managing stacks)
     - ✅ `AmazonSSMFullAccess` (for parameter store & session manager)
     - ✅ `AWSLambdaFullAccess` (for invoking start/stop lambdas)
   - Click **Next**

4. **Review and create:**
   - Click **Create user**

### Step 2: Create Access Keys

1. **Select your user:**
   - Go back to **IAM** → **Users**
   - Click on `minecraft-control-panel`

2. **Create access key:**
   - Go to **Security credentials** tab
   - Scroll down to **Access keys**
   - Click **Create access key**

3. **Choose use case:**
   - Select "Application running outside AWS"
   - Click **Next**

4. **Optional description:**
   - Description: `Minecraft control panel credentials`
   - Click **Create access key**

5. **Save your credentials:**
   
   You'll see:
   ```
   Access key ID: AKIAIOSFODNN7EXAMPLE
   Secret access key: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
   ```

   **⚠️ IMPORTANT:** 
   - Copy both values NOW
   - You won't be able to see the secret key again
   - If you lose it, you'll need to create a new key

6. **Download .csv (optional but recommended):**
   - Click "Download .csv file"
   - Store it securely (password manager, encrypted folder)

---

## Using Your Credentials

### For Local Development

Add to `.env.local`:

```bash
AWS_REGION=us-west-1  # Or your region
AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
```

Test it:
```bash
pnpm dev
# The control panel should be able to check instance status
```

### For AWS CLI (CDK Deploy)

Configure AWS CLI:

```bash
aws configure
```

Enter:
- AWS Access Key ID: `AKIAIOSFODNN7EXAMPLE`
- AWS Secret Access Key: `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`
- Default region: `us-west-1` (or your region)
- Default output format: `json`

Test it:
```bash
aws sts get-caller-identity
# Should show your user details
```

### For Production (Cloudflare Workers)

Add to `.env.production`:

```bash
AWS_REGION=us-west-1
AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
```

The deploy script will automatically upload these as encrypted secrets to Cloudflare.

---

## Finding Your AWS Account ID

You need this for the `.env` files:

**Method 1: AWS Console**
- Top right corner of AWS Console
- Click your username dropdown
- You'll see your Account ID (12 digits)

**Method 2: AWS CLI**
```bash
aws sts get-caller-identity --query Account --output text
```

Add to your `.env.local` and `.env.production`:
```bash
AWS_ACCOUNT_ID=123456789012
CDK_DEFAULT_ACCOUNT=123456789012
```

---

## Finding Your Region

Your region is where your EC2 instance is deployed.

**Common regions:**
- `us-east-1` - US East (N. Virginia)
- `us-west-1` - US West (N. California)
- `us-west-2` - US West (Oregon)
- `eu-west-1` - Europe (Ireland)

**Check where your instance is:**
```bash
aws ec2 describe-instances --query 'Reservations[0].Instances[0].Placement.AvailabilityZone' --output text
```

Add to your `.env.local` and `.env.production`:
```bash
AWS_REGION=us-west-1
CDK_DEFAULT_REGION=us-west-1
```

---

## Security Best Practices

### ✅ Do:
- Create a dedicated IAM user (don't use root credentials)
- Store credentials in `.env.local` and `.env.production` (gitignored)
- Use least-privilege permissions (only what the app needs)
- Rotate access keys periodically (every 90 days)
- Enable MFA on your AWS account

### ❌ Don't:
- Commit credentials to git
- Share credentials with others
- Use root account access keys
- Hardcode credentials in code
- Leave unused access keys active

---

## Troubleshooting

### Error: "Unable to locate credentials"

**Cause:** AWS credentials not configured.

**Fix:**
1. Make sure `.env.local` has `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`
2. Restart dev server: `pnpm dev`
3. For CLI commands: run `aws configure`

### Error: "The security token included in the request is invalid"

**Cause:** Access key was deleted or is incorrect.

**Fix:**
1. Go to IAM → Users → Your user → Security credentials
2. Check if access key is still active
3. If not, create a new one
4. Update `.env.local` with new credentials

### Error: "User: arn:aws:iam::xxx:user/minecraft-control-panel is not authorized to perform: ec2:DescribeInstances"

**Cause:** IAM user doesn't have required permissions.

**Fix:**
1. Go to IAM → Users → Your user → Permissions
2. Click "Add permissions" → "Attach policies directly"
3. Add the missing policy (e.g., `AmazonEC2FullAccess`)

### Error: "No default region configured"

**Cause:** AWS region not set.

**Fix:**
```bash
# Add to .env.local
AWS_REGION=us-west-1

# Or configure AWS CLI
aws configure set region us-west-1
```

---

## Minimal Permissions (Advanced)

If you want to follow the principle of least privilege, here's a minimal policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeInstances",
        "ec2:StartInstances",
        "ec2:StopInstances",
        "ec2:DescribeInstanceStatus",
        "ec2:DescribeVolumes",
        "lambda:InvokeFunction",
        "ssm:GetParameter",
        "ssm:PutParameter",
        "cloudformation:DescribeStacks"
      ],
      "Resource": "*"
    }
  ]
}
```

To use:
1. IAM → Policies → Create policy
2. Paste the JSON above
3. Name it `MinecraftControlPanelPolicy`
4. Attach it to your IAM user instead of the full access policies
