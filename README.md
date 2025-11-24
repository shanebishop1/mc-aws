# Automated AWS Minecraft Server

Most Minecraft server hosting solutions cost ~$10 a month. If you are only using the server occasionally, that’s a lot of wasted money. Self-hosting is free, but then the host must always keep the server online, which can be a pain.

This project hosts a Minecraft server on AWS that **only runs when someone actually wants to play**. It starts up via an email trigger, syncs its configuration from this repository, and shuts itself down automatically when nobody is online.

## Cost

Most hosting providers charge a flat monthly fee. By moving to AWS and using a **`t4g.medium`** instance, you only pay for the seconds the server is running (plus <$1 for storage).

|                 | **This Setup**                         | **Realms / Hosting**       |
| :-------------- | :--------------------------------------- | :------------------------- |
| **Performance** | 4GB RAM / 2 vCPU (Dedicated)             | Hit or miss                |
| **Idle Cost**   | **~$0.75 / month** (Just storage)        | Full Price                 |
| **Active Cost** | **~$0.03 / hour**                        | N/A                        |
| **Total Cost**  | **~\$0.75-\$1.50 / month** (~0-20 hrs of play) | **\$8.00 - \$15.00 / month** |

_Basically, unless you are playing 24/7, this setup is significantly cheaper._

## How it works

1.  **Startup:** Send an email to the account that you set up with AWS SES (e.g., `start@mydomain.com`).
2.  **Trigger:** AWS SES catches the email and executes a Lambda function.
3.  **Launch:** The Lambda starts the EC2 instance and updates your Cloudflare DNS record so the domain points to the EC2's newly-assigned IP.
4.  **Config Sync:** On boot, the server automatically pulls the latest `server.properties` and `whitelist.json` from this GitHub repo.
5.  **Auto-Shutdown:** A script runs every minute checking for players. If the server is empty for 15 minutes, it stops the Minecraft service and shuts down the EC2 instance to stop billing.

## Repo Structure

- `config/` - The actual Minecraft config files (whitelist, properties).
- `ec2/` - Scripts that run on the server (startup, idle check, systemd service).
- `lambda/` - The Node.js code that handles the startup logic.
- `iam/` - AWS permission policies.
- `dlm/` - Backup schedule (snapshots).

## Setup Guide

If you want to set this up this yourself, here is the rough outline.

### Prerequisites

- An AWS Account.
- A domain managed by Cloudflare (needed for the API DNS updates).
- Familiarity with AWS Console.

### 1. The Code

Fork this repo. You can edit `config/` whenever you want to change game settings or add people to the allowlist.

- Update `GITHUB_USERNAME` and `REPO_NAME` at the top of `ec2/user_data.sh` so it clones **your** fork from your account.

### 2. AWS Account Setup

**Use an IAM User, Not Root:**
It's not smart to use the root account in AWS for normal activity. If you haven't already, create an IAM user with admin privileges:

1. Go to IAM → Users → Create user
2. Attach `AdministratorAccess` policy (for setup only)
3. Enable multi-factor authentication (MFA)
4. Use this IAM user for all setup tasks

**Set Up Billing Alarms:**
It's a good practice to set up a simple billing alarm, just in case something goes wrong:

1. Go to CloudWatch → Alarms → Create alarm
2. Select "Billing" metric → "TotalEstimatedCharge"
3. Set threshold to $5 (or whatever you would consider abnormal for your expected usgae)
4. Configure email notifications

### 3. AWS Infrastructure

- **Networking & Security Groups:** Pick an existing VPC + public subnet with an Internet Gateway, or create one. Make a security group that allows inbound TCP `25565` from the IP ranges that should access your server (and optionally SSH `22` from your IP for maintenance). Allow all outbound traffic. Attach this security group to the Minecraft instance at launch.
- **EC2:** Launch a `t4g.medium` instance (Amazon Linux 2023) in that subnet. Attach the security group above and the instance profile from the next bullet. Add the tag `Backup=weekly` to the root volume so DLM finds it.
- **IAM Role / Instance Profile:** Create a role for EC2 that uses `iam/trust-policy.json` and attach `iam/AllowReadGithubPAT.json` + `iam/EC2StopInstance.json`. That gives the box permission to pull the GitHub PAT from SSM (including the `kms:Decrypt` it needs) and to call `ec2:StopInstances` on itself when idle.
- **Secrets:** Store your GitHub PAT as a SecureString parameter `/minecraft/github-pat` in AWS Systems Manager Parameter Store (same region as the instance) and set the key/permissions so only that role can read it.

### 4. The Trigger (Lambda + SES + SNS + Cloudflare)

1. **Collect Cloudflare Info:**
   - In Cloudflare, grab the Zone ID for your domain and the Record ID of the DNS record you want to overwrite (or create an `A` record placeholder and note its ID).
   - Create a Cloudflare API Token with scopes `Zone:Read` + `DNS:Edit` limited to that zone.
   - You will feed these into the Lambda environment as `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_RECORD_ID`, `CLOUDFLARE_MC_DOMAIN`, and `CLOUDFLARE_API_TOKEN`.
2. **Package the Lambda:**
   - `cd lambda/StartMinecraftServer && npm install` (or `npm ci`).
   - Zip **index.js + node_modules/** together, upload to a new Lambda function (Node.js 20 runtime), and set the handler to `index.handler`.
   - Attach an execution role that uses `iam/trust-policy.json` + `iam/lambda-ec2-ses-policy.json` (remember to replace `<EC2_INSTANCE_ID>` before creating the policy).
   - Configure the following environment variables:
     - `INSTANCE_ID`
     - `VERIFIED_SENDER` (address you verified in SES)
     - `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_RECORD_ID`, `CLOUDFLARE_MC_DOMAIN`, `CLOUDFLARE_API_TOKEN`
3. **SES + SNS Flow:**
   - SES Inbound requires an active Receipt Rule Set. Verify the domain that will receive `start@...` and create a rule that matches that recipient.
   - Add an action “SNS Topic” and have the rule publish to a new SNS topic, then subscribe your Lambda to that topic. (The handler expects `event.Records[0].Sns`.)
   - Finally, add a Lambda action or enable the SNS subscription so Lambda is invoked whenever the email arrives.
4. **SES Sandbox Warnings:** While your account is in the SES sandbox you must verify both the sender (the address in `VERIFIED_SENDER`) and every player address that will send the “start” email. Request production access if you want anyone to trigger the server without verification.

### 5. Backups (AWS DLM)

- Tag each EBS volume that holds Minecraft data with `Backup=weekly` (already on the root volume from step 3).
- From this repo run `aws dlm create-lifecycle-policy --region <region> --cli-input-json file://dlm/weekly-policy.json` to create the weekly snapshot policy included in `dlm/weekly-policy.json` (runs Mondays 03:00 UTC, keeps 4 snapshots).
- Console path: **Lifecycle Manager → Create policy → EBS Snapshot → Policy type "EBS snapshot management"**. Target resources by tag `Backup=weekly`, cron `cron(0 3 ? * MON *)`, retention count `4`.
- DLM needs an IAM role with `dlm:*` permissions by default; if you limit permissions make sure it can describe volumes and create/delete snapshots in the region you are using.

## 🎮 How to Manage It

**Playing:**
Send an email with the subject "start" to your trigger address. Wait ~60 seconds, then connect to your domain.

**Updating Settings:**
Don't SSH into the server to change the whitelist or properties. Instead:

1.  Edit `config/whitelist.json` in this repo.
2.  Commit and push.
3.  The next time the server starts (or restarts), it pulls your changes automatically.

**Backups:**
AWS DLM handles the weekly snapshots (see Step 5). It takes a snapshot every Monday at 03:00 UTC and retains the last four copies automatically.

## 📄 License

MIT. Use this code however you want.
