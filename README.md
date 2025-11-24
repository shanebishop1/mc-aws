# Automated AWS Minecraft Server

Most MC server hosting solutions cost ~$10 a month. If you are only using the server occasionally, that’s a lot of wasted money. Self-hosting is free, but then the host must always keep the server online, which can be a pain.

This project hosts a Minecraft server on AWS that **only runs when someone actually wants to play**. It starts up via an email trigger, syncs its configuration from this repository, and shuts itself down automatically when nobody is online.

## Cost

Most hosting providers charge a flat monthly fee. By moving to AWS and using a **`t4g.medium`** instance, you only pay for the seconds the server is running (plus <$1 for storage).

|                 | **My AWS Setup**                         | **Realms / Hosting**       |
| :-------------- | :--------------------------------------- | :------------------------- |
| **Performance** | 4GB RAM / 2 vCPU (Dedicated)             | Often Shared/Laggy         |
| **Idle Cost**   | **~$0.75 / month** (Just storage)        | Full Price                 |
| **Active Cost** | **~$0.03 / hour**                        | N/A                        |
| **Total Cost**  | **~$1.50 / month** (for ~20 hrs of play) | **$8.00 - $15.00 / month** |

_Basically, unless you are playing 24/7, this is significantly cheaper._

## How it works

1.  **Startup:** I send an empty email to a specific address (e.g., `start@mydomain.com`).
2.  **Trigger:** AWS SES catches the email and fires a Lambda function.
3.  **Launch:** The Lambda starts the EC2 instance and updates my Cloudflare DNS record so the domain points to the new IP.
4.  **Config Sync:** On boot, the server automatically pulls the latest `server.properties` and `whitelist.json` from this GitHub repo.
5.  **Auto-Shutdown:** A script runs every minute checking for players. If the server is empty for 15 minutes, it stops the Minecraft service and shuts down the EC2 instance to stop billing.

## Repo Structure

- `config/` - The actual Minecraft config files (whitelist, properties).
- `ec2/` - Scripts that run on the server (startup, idle check, systemd service).
- `lambda/` - The Node.js code that handles the startup logic.
- `iam/` - AWS permission policies.
- `dlm/` - Backup schedule (snapshots).

## Setup Guide

If you want to run this yourself, here is the rough outline.

### Prerequisites

- An AWS Account.
- A domain managed by Cloudflare (needed for the API DNS updates).
- Familiarity with AWS Console.

### 1. The Code

Fork this repo. You'll edit the files in `config/` whenever you want to change game settings or add people to the whitelist.

- Update `ec2/user_data.sh` to clone **your** fork instead of mine.

### 2. AWS Account Setup

**Use an IAM User, Not Root:**
Never use the root account for daily operations. Create an IAM user with administrative privileges for setup:

1. Go to IAM → Users → Create user
2. Attach `AdministratorAccess` policy (for setup only)
3. Enable multi-factor authentication (MFA)
4. Use this IAM user for all setup tasks

**Set Up Billing Alarms:**
Prevent surprise bills with a simple billing alarm:

1. Go to CloudWatch → Alarms → Create alarm
2. Select "Billing" metric → "TotalEstimatedCharge"
3. Set threshold to $5 (or your preferred amount)
4. Configure email notification
5. This alerts you before costs get out of control

### 3. AWS Infrastructure

- **EC2:** Launch a `t4g.medium` instance (Amazon Linux 2023).
  - Add a tag `Backup=weekly` to the storage volume so the automated backups catch it.
- **IAM:** Create a role for the EC2 instance. It needs permissions to:
  - Read a GitHub Personal Access Token (stored in AWS SSM Parameter Store).
  - Run `StopInstances` on itself.
- **Secrets:** Put your GitHub Token in AWS Systems Manager (Parameter Store) as `/minecraft/github-pat`.

### 4. The Trigger (Lambda + SES)

- **Lambda:** Zip up the `lambda/` folder and deploy it. It needs Environment Variables for your Instance ID and Cloudflare API details.
- **SES:** Verify your domain. Set up a "Receipt Rule" that says "When an email hits `start@...`, trigger the Lambda."

## 🎮 How to Manage It

**Playing:**
Send an email with the subject "start" to your trigger address. Wait ~60 seconds, then connect to your domain.

**Updating Settings:**
Don't SSH into the server to change the whitelist or properties. Instead:

1.  Edit `config/whitelist.json` in this repo.
2.  Commit and push.
3.  The next time the server starts (or restarts), it pulls your changes automatically.

**Backups:**
I set up AWS DLM (Data Lifecycle Manager) to automatically take a snapshot of the drive once a week. It keeps the last 4 snapshots and deletes the rest.

## 📄 License

MIT. Use this code however you want.
