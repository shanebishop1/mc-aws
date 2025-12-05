# On-Demand Minecraft Server on AWS
<p align="center"><img width="320" height="320" alt="lol" src="https://github.com/user-attachments/assets/2d77fd09-d9d9-4f23-9830-826b6cd68a57" /></p>

Most Minecraft server hosting solutions cost ~$10 a month. If you are only using the server occasionally, that’s a lot of wasted money. Self-hosting is free, but if you want any of your friends to be able to join your server at any time, then you, the host, must either:

- **A.** keep the server online 24/7, or
- **B.** manually spin it up/down whenever somebody wants to hop on

Both options are inconvenient.

The goal of this repo is to show you how to host a Minecraft server on AWS that **only runs when someone actually wants to play**. It starts up via an email trigger, syncs its config/allowlist from this repository, and shuts itself down automatically when nobody is online.

I found a few similar, pre-existing recipes online, but none of them included auto-shutdown, the option for backups, or email integration, which allows any (non-technical) user to spin up the server. So here we are- I'm hoping this will save you a few bucks and serve as a fun project!

**NOTE: As I detail below, there are most likely better options elsewhere (on-demand hosting providers) for your use case. If you aren't technical (and don't want to learn), or aren't excited to jump through a few hoops, you should look elsewhere.**

## Table of Contents

- [Background](#background)
- [How it works](#how-it-works)
- [Repo Structure](#repo-structure)
- [Setup Guide](#setup-guide)
- [How to Manage It](#how-to-manage-it)

## Background

### Cost

Traditional hosting providers charge a flat monthly fee. By moving to AWS and using a **`t4g.medium`** instance, you only pay for the seconds the server is running (plus ~$0.75 per month for storage).

|                 | **This Setup**                                  | **Realms / Hosting**         |
| :-------------- | :---------------------------------------------- | :--------------------------- |
| **Performance** | 4GB RAM / 2 vCPU (Dedicated)                    | Hit or miss                  |
| **Idle Cost**   | **~$0.75 / month\*** (just storage, no backups) | Full Price                   |
| **Active Cost** | **~$0.03 / hour**                               | N/A                          |
| **Total Cost**  | **~\$0.75-\$1.50 / month** (~0-20 hrs of play)  | **\$8.00 - \$15.00 / month** |

\*_If you want to backup your data, that will cost an additional ~$0.20 per month._

**Basically, unless you are playing 24/7, this setup is significantly cheaper than using a traditional, dedicated provider.**

### Rationale

There do exist on-demand hosting providers such as Exarotron\* and ServerWave\*\*. These options are definitely cheaper for many use cases. Not to mention, they'll give you a bunch of extra features and are infinitely easier to set up and use. However, if you want complete flexibility, this setup is the best because:

1. You have complete control (just like if you were self-hosting on your own machine). If you don't want to pay the ~$0.75 per month for storage and aren't going to play for a while, you can download your GP3 volume and store it locally, bringing your monthly idle cost to $0.00. Then, when the [annual two-week Minecraft phase](https://knowyourmeme.com/memes/2-week-minecraft-phase) kicks off, you can just attach a new EBS volume to your EC2 instance, SSH in, and rsync your world back.
2. If you want to extend this project, you can. Some ideas include: storing the world on some kind of free provider (e.g. Google Drive) and syncing it to the EC2 instance on boot and back to the provider on shutdown. This would give you very, very, slow start times, but $0.00 idle cost. Just be wary of the 100gb monthly egress limit that AWS has in place.
3. Anyone who knows your start keyword and email address can easily spin the server up by sending an email. This means that anybody can play, whether you're available or not. With self-hosting, you would have to be there to turn on the server. With a traditional on-demand provider, you would have to log in to a control panel to spin the server up.

\*_Exarotron specifically does offer a Discord bot that you could grant access to in order to start the server, but setting up Discord is another step for your non-technical/non-gamer friends to handle. Conversely, everybody has email. Exarotron also requires that you buy credits in ~$3.00 increments, which limits spending flexibility. If you want to play for a couple months and then stop, anything left over from your last ~$3.00 increment will be wasted. Also, technically, using a t3.medium EC2 instance with 4GB of RAM costs $0.04 per hour, which is ever-so-slightly cheaper than the €0.04 per hour for a similar 4G server on Exarotron._

\*\*_ServerWave requires that you pay **per-hour** of usage, not per-second._

At this point, we're talking about pennies. In some cases, you'll save a few pennies with this setup, and in other cases, you'll lose a few. However, this setup exists not just to save money, but to enable independence from any third-party services (besides our almighty cloud providers, of course, upon which the rest of the observable software universe is but a wrapper). And because it's fun to build/scaffold/tinker/control.

## How it works

1.  **Startup:** Send an email with the secret keyword (default "start") in the subject or body to the account that you set up with AWS SES (e.g., `start@mydomain.com`).
2.  **Trigger:** AWS SES catches the email and executes a Lambda function.
3.  **Launch:** The Lambda starts the EC2 instance and updates your Cloudflare DNS record so the domain points to the EC2's newly-assigned IP.
4.  **Config Sync:** On boot, the server automatically pulls the latest `server.properties` and `whitelist.json` from this repo (or your fork).
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

- The `ec2/user_data.sh` script fetches your GitHub username and repository name from AWS Systems Manager Parameter Store (configured in step 3 below).

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
- **EC2:** Launch a `t4g.medium` instance (Amazon Linux 2023) in that subnet. Attach the security group above and the instance profile from the next bullet. If you want backups, add the tag `Backup=weekly` to the root volume so DLM finds it.
- **IAM Role / Instance Profile:** Create a role for EC2 that uses `iam/trust-policy.json` and attach `iam/AllowReadGithubPAT.json` + `iam/EC2StopInstance.json`. That gives the instance permission to pull the GitHub PAT from SSM (including the `kms:Decrypt` it needs) and to call `ec2:StopInstances` on itself when idle.
- **Secrets & Config:** Store the following in AWS Systems Manager Parameter Store (Standard parameters are fine, except for the PAT which should be SecureString):
  - `/minecraft/github-pat` (SecureString): Your GitHub Personal Access Token.
  - `/minecraft/github-user` (String): Your GitHub username.
  - `/minecraft/github-repo` (String): The name of your forked repository (e.g., `mc_aws`).

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
     - `START_KEYWORD` (optional, defaults to "start")
     - `NOTIFICATION_EMAIL` (optional, the email to receive startup notifications)
     - `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_RECORD_ID`, `CLOUDFLARE_MC_DOMAIN`, `CLOUDFLARE_API_TOKEN`
3. **SES + SNS Flow:**
   - SES Inbound requires an active Receipt Rule Set. Verify the domain that will receive `start@...` and create a rule that matches that recipient.
   - Add an action “SNS Topic” and have the rule publish to a new SNS topic, then subscribe your Lambda to that topic. (The handler expects `event.Records[0].Sns`.)
   - Finally, add a Lambda action or enable the SNS subscription so Lambda is invoked whenever the email arrives.
4. **SES Sandbox Warnings:** While your account is in the SES sandbox you must verify both the sender (the address in `VERIFIED_SENDER`) and every player address that will send the “start” email. Request production access if you want anyone to trigger the server without verification.

### 5. Backups (Optional)

- Tag each EBS volume that holds Minecraft data with `Backup=weekly` (already on the root volume from step 3).
- From this repo run `aws dlm create-lifecycle-policy --region <region> --cli-input-json file://dlm/weekly-policy.json` to create the weekly snapshot policy included in `dlm/weekly-policy.json` (runs Mondays 03:00 UTC, keeps 4 snapshots).
- Console path: **Lifecycle Manager → Create policy → EBS Snapshot → Policy type "EBS snapshot management"**. Target resources by tag `Backup=weekly`, cron `cron(0 3 ? * MON *)`, retention count `4`.
- Open the same Lifecycle Manager page in the console afterward and confirm the policy shows `Enabled` (clear any errors if it doesn't).
- DLM needs an IAM role with `dlm:*` permissions by default; if you limit permissions make sure it can describe volumes and create/delete snapshots in the region you are using.

## How to Manage It

**Playing:**
Send an email with the subject (or body) containing your start keyword (default "start") to your trigger address. Wait ~60 seconds, then connect your server from Minecraft.

**Updating Settings:**
Don't SSH into the server to change the whitelist or properties. Instead:

1.  **Find UUIDs:** Use a tool like [mcuuid.net](https://mcuuid.net/) to find the UUID for each player you want to allow.
2.  **Edit Config:** Update `config/whitelist.json` in this repo with the new names and UUIDs.
3.  **Push:** Commit and push your changes.
4.  **Sync:** The next time the server starts (or restarts), it pulls your changes automatically.

**Backups:**
AWS DLM handles the weekly snapshots (see Step 5). It takes a snapshot every Monday at 03:00 UTC and retains the last four copies automatically.
