# On-Demand Minecraft Server on AWS

<p align="center"><img width="320" height="320" alt="mc-aws-image" src="https://github.com/user-attachments/assets/2d77fd09-d9d9-4f23-9830-826b6cd68a57" /></p>

Most Minecraft server hosting solutions cost ~$10 a month. If you are only using the server occasionally, that’s a lot of wasted money. Self-hosting is free, but if you want any of your friends to be able to join your server at any time, then you, the host, must either:

- **A.** keep the server online 24/7, or
- **B.** manually spin it up/down whenever somebody wants to hop on

This project offers a more flexible alternative: an EC2 setup that costs **$0.00/month** when you aren't using it, and only pennies per hour when you are.

It achieves this by **hibernating** (downloading your server data to your local machine/Google Drive) and deleting the cloud infrastructure when you're done for the season. When you want to play again, a single command spins the infra back up. Then, any of your friends can email the startup email to trigger server startup. The server will automatically close following inactivity.

Key features:

- **Zero Idle Cost:** Hibernate your server when not in use.
- **On-Demand:** Spin up via email trigger or command line.
- **Auto-Shutdown:** Server turns itself off when nobody is playing.

**NOTE: This setup requires some initial configuration (AWS account, Cloudflare), but once set up, it requires very little maintenance.**

## Table of Contents

- [Background](#background)
- [How It Works](#how-it-works)
- [Repo Structure](#repo-structure)
- [Setup Guide](#setup-guide)
- [Connecting to the Server](#connecting-to-the-server)
- [Google Drive Backups](#google-drive-optional-backupstransfers)
- [Weekly EBS Snapshots](#weekly-ebs-snapshots-optional)
- [How to Manage It](#how-to-manage-it)
- [Hibernation](#hibernation-zero-storage-cost)

## Background

### Cost

Traditional hosting providers charge a flat monthly fee. By moving to AWS and using this project's scripts, you only pay for what you use.

| Cost Component           | **Hibernated** (Deep Storage) | **Standby** (Quick Start) | **Active** (Playing)   |
| :----------------------- | :---------------------------- | :------------------------ | :--------------------- |
| **Compute (RAM/CPU)**    | $0.00 / month                 | $0.00 / month             | ~$0.03 / hour          |
| **Storage (World Data)** | $0.00 / month \*              | ~$0.75 / month            | (Included)             |
| **Total Cost**           | **$0.00 / month**             | **~$0.75 / month**        | **~$0.03-0.04 / hour** |

\* _Assuming you hibernate to local disk or free cloud storage (e.g. Google Drive)._

### Example: Light usage

If you play for **8 hours** in a specific month and hibernate the server for the rest of the time:

- **Compute:** 8 hours \* ~$0.03/hr = **$0.24**
- **Storage:** $0.00 (Hibernated)
- **Total:** **$0.24 for the entire month**

**Unless you are playing for many hours, this setup is significantly cheaper than using a traditional, dedicated provider.**

### Rationale

There do exist on-demand hosting providers such as Exarotron\* and ServerWave\*\*. These options are definitely cheaper for many use cases. Not to mention, they'll give you a bunch of extra features and are infinitely easier to set up and use. However, if you want complete flexibility, this setup is the best because:

1. If you want to extend this project, you can. You have complete control of the server and its lifecycle, configuration, etc. You could set up a Discord connection, or a simple webapp that triggers the server startup.
2. Anyone who knows your start keyword and email address can easily spin the server up by sending an email. This means that anybody can play, whether you're available or not. With self-hosting, you would have to be there to turn on the server. With a traditional on-demand provider, you would have to log in to a control panel to spin the server up.
3. You only pay for what you use, at per-second increments (no pre-paying for usage or hourly rounding up).

\*_Exarotron specifically does offer a Discord bot that you could grant access to in order to start the server, but setting up Discord is another step for your non-technical/non-gamer friends to handle. Conversely, everybody has email. Exarotron also requires that you buy credits in ~$3.00 increments, which limits spending flexibility. If you want to play for a couple months and then stop, anything left over from your last ~$3.00 increment will be wasted. Also, technically, using a t3.medium EC2 instance with 4GB of RAM costs $0.04 per hour, which is ever-so-slightly cheaper than the €0.04 per hour for a similar 4G server on Exarotron._

\*\*_ServerWave requires that you pay **per-hour** of usage, not per-second._

At this point, we're talking about pennies. In some cases, you'll save a few pennies with this setup, and in other cases, you'll lose a few. However, this setup exists not just to save money, but to enable independence from any third-party services (besides our almighty cloud providers, of course, upon which the rest of the observable software universe is but a wrapper). And because it's fun to build/scaffold/tinker/control.

## How It Works

1.  **Startup:** Send an email with the secret keyword (default "start") in the subject or body to the account that you set up with AWS SES (e.g., `start@mydomain.com`).
2.  **Trigger:** AWS SES catches the email and executes a Lambda function.
3.  **Launch:** The Lambda starts the EC2 instance and updates your Cloudflare DNS record so the domain points to the EC2's newly-assigned IP.
4.  **Config Sync:** On boot, the server automatically pulls the latest `server.properties` and `whitelist.json` from this repo (or your fork).
5.  **Auto-Shutdown:** A script runs every minute checking for players. If the server is empty for 15 minutes, it stops the Minecraft service and shuts down the EC2 instance to stop billing.

## Repo Structure

- `config/` - The actual Minecraft config files (whitelist, properties).
- `src/ec2/` - Scripts that run on the server (startup, idle check, systemd service).
- `src/lambda/` - The Node.js code that handles the startup logic.
- `setup/dlm/` - Backup schedule (snapshots).

## Setup Guide

This project uses AWS CDK to automate the entire setup process. Follow these steps to deploy your on-demand Minecraft server.

### Prerequisites

Before you begin, ensure you have the following:

#### 1. Local Tools

- **Node.js** installed (v18+)
- **AWS CLI** installed and configured:
  ```bash
  aws configure
  ```
  Enter your AWS Access Key ID, Secret Access Key, default region (e.g., `us-west-1`), and default output format (`json`).
- **Session Manager Plugin** (for connecting to the server):
  ```bash
  brew install --cask session-manager-plugin
  ```

#### 2. Cloudflare Domain Setup

You need a domain managed by **Cloudflare** for dynamic DNS updates. If you don't have one, register a domain (typically <$1/month) and point it to Cloudflare's nameservers.

You'll need three pieces of information from Cloudflare:

**A. Zone ID:**

- Log in to Cloudflare and select your domain
- Open the "Overview" section
- Scroll down to the "API" section on the right sidebar
- Copy your **Zone ID**

**B. API Token:**

- Go to **Manage account** > **Account API tokens**
- Click **Create Token**
- Choose the **Edit Zone DNS** template (or create custom with Zone > DNS > Edit permissions)
- **Zone Resources:** Include > Specific zone > Your Domain
- Click **Continue to Summary** → **Create Token**
- **Copy the token immediately** (you won't see it again)

**C. DNS Record ID:**

- Go to **DNS** > **Records** on the left sidebar
- Create an **A** record for your Minecraft subdomain (e.g., `mc`). Point it to `1.1.1.1` (placeholder; it will be updated automatically)
- To get the **Record ID**, use the Cloudflare API:
  ```bash
  curl -X GET "https://api.cloudflare.com/client/v4/zones/<ZONE_ID>/dns_records" \
       -H "Authorization: Bearer <YOUR_API_TOKEN>" \
       -H "Content-Type: application/json"
  ```
- Find your DNS record in the JSON output and copy its `id` field. You'll need to use this for the `CLOUDFLARE_RECORD_ID` field in `.env`

#### 3. AWS SES Email Verification

AWS SES requires email verification before you can send/receive emails.

1. Go to **AWS Console** → **Amazon SES** → **Identities**
2. Click **Create identity**
3. Select **Domain** and enter your domain (e.g., `yourdomain.com`)
4. Follow the verification steps (add DNS records to Cloudflare)
   - You'll need to copy the 3 DKIM CNAME records to the Cloudflare DNS for your domain
   - Then, you'll need to add an MX record (with the root domain as the name, and `inbound-smtp.us-west-1.amazonaws.com` for the mail server, if in the West region). You can set priority to `10`.
5. **Important:** If you're in SES Sandbox mode, you must also verify:
   - The **sender email** (the email you'll send the "start" command from, e.g., `start@yourdomain.com`)
   - The **notification email** (where you want to receive server alerts, if different from sender)

#### 4. AWS EC2 Key Pair (Optional, but Recommended for File Uploads)

If you want to use SSH for file uploads (the `upload-server.sh` script), create an EC2 key pair:

1. Go to **AWS Console** → **EC2** → **Key Pairs**
2. Click **Create key pair**
   - Name: `mc-aws`
   - Format: `.pem`
3. Download the file and move it to your local SSH directory:
   ```bash
   mv ~/Downloads/mc-aws.pem ~/.ssh/mc-aws.pem
   chmod 400 ~/.ssh/mc-aws.pem
   ```
4. You'll add this key pair name to your `.env` file in the next step

### Deployment Steps

1.  **Fork and Clone:**
    - Fork [shanebishop1/mc-aws](https://github.com/shanebishop1/mc-aws).
    - Clone your fork and open the repo

2.  **Install Dependencies:**

    ```bash
    npm install
    ```

3.  **Bootstrap CDK:**

    ```bash
    npx cdk bootstrap
    ```

4.  **Configure Environment:**

    Copy the provided `.env.template` file to `.env`:

    ```bash
    cp .env.template .env
    ```

    Then edit `.env` with your specific values:

    ```bash
    # Cloudflare (from Prerequisites section above)
    CLOUDFLARE_ZONE_ID="your-zone-id"
    CLOUDFLARE_API_TOKEN="your-api-token"
    CLOUDFLARE_RECORD_ID="your-record-id"
    CLOUDFLARE_MC_DOMAIN="mc.yourdomain.com"

    # AWS SES (verified emails from Prerequisites section above)
    VERIFIED_SENDER="start@yourdomain.com"           # Email to receive trigger emails
    NOTIFICATION_EMAIL="you@yourdomain.com"          # (Optional) Where to receive alerts
    START_KEYWORD="start"                            # (Optional) Word that triggers server start

    # GitHub (for server to pull config on boot)
    GITHUB_USER="your-github-username"
    GITHUB_REPO="mc-aws"                             # or your fork name
    GITHUB_TOKEN="ghp_..."                           # See step 5 below

    # AWS
    AWS_ACCOUNT_ID="123456789012"
    AWS_REGION="us-west-1"

    # EC2 Key Pair (Optional, for SSH file uploads)
    KEY_PAIR_NAME="mc-aws"                           # Leave blank if not using SSH

    # Google Drive (Optional, for cloud backups)
    # GDRIVE_TOKEN_SECRET_ARN="arn:...:secret:/minecraft/rclone-drive-token"
    # GDRIVE_REMOTE="gdrive"
    # GDRIVE_ROOT="mc-backups"
    ```

5.  **Create a GitHub Personal Access Token (PAT):**

    The EC2 instance needs to pull config files from your GitHub repo on each boot. To do this securely, you need a GitHub PAT:

    1. Go to [GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)](https://github.com/settings/tokens)
    2. Click **Generate new token (classic)**
    3. Give it a descriptive name (e.g., `mc-aws-server`)
    4. Set an expiration (or "No expiration" if you prefer)
    5. Select the **`repo`** scope (required for private repos; for public repos, no scopes are needed)
    6. Click **Generate token**
    7. **Copy the token immediately** (you won't see it again)
    8. Add it to your `.env` file:
       ```bash
       GITHUB_TOKEN="ghp_xxxxxxxxxxxxxxxxxxxx"
       ```

    **How it works:** When you run `npm run deploy`, the deploy script reads `GITHUB_TOKEN` from your `.env` and securely stores it in AWS SSM Parameter Store as an encrypted SecureString. The EC2 instance fetches this token on boot to clone/pull your repo.

6.  **Deploy:**

    ```bash
    npm run deploy
    ```

    The deploy script will:
    - Create the EC2 instance, Lambda function, IAM roles, and SES rules
    - **Automatically activate** the SES Rule Set
    - Prompt you to set up Google Drive backups (optional; you can skip)
    - Ask if you want to enable weekly EBS snapshots via DLM

    **Note on Google Drive (optional):** If you want cloud backups, the script will offer to run `./bin/setup-drive-token.sh` for you. This opens a browser for Google OAuth and stores the token in AWS Secrets Manager. You can skip this and deploy without Drive support.

7.  **Wait for Setup:**

    The deployment typically takes 3-5 minutes. Once complete, your server is ready to use!

### First-Time Server Startup

To start your server for the first time:

1. Send an email with your start keyword (default: `start`) in the subject or body to your verified sender email (e.g., `start@yourdomain.com`)
2. Wait ~60 seconds for the server to boot
3. Connect to your Minecraft server using the domain you configured (e.g., `mc.yourdomain.com`)

---

## Connecting to the Server

You have two ways to connect to your EC2.

### Method 1: The Modern Way (Recommended)

This uses AWS Systems Manager (SSM). No SSH keys or open ports required.

- **Connect to Shell:**

  ```bash
  ./bin/connect.sh
  ```

  This drops you into a root shell on the server.

- **Connect to Minecraft Console:**
  ```bash
  ./bin/console.sh
  ```
  This connects you directly to the running Minecraft screen session.

### Method 2: SSH Key (Required for File Uploads)

SSH access is needed for the `upload-server.sh` script and traditional SFTP/rsync.

**One-Time Setup:**

1.  **Create a Key Pair:**
    Go to [EC2 Console → Key Pairs](https://console.aws.amazon.com/ec2/home#KeyPairs) → Create Key Pair.
    - Name it `mc-aws`
    - Format: `.pem`
    - Click Create — the file downloads automatically
    - **Important:** You can only download this file once! If you lose it, delete the key pair and create a new one.

2.  **Move the file:**

    ```bash
    mv ~/Downloads/mc-aws.pem ~/.ssh/mc-aws.pem
    chmod 400 ~/.ssh/mc-aws.pem
    ```

3.  **Add to your `.env`:**

    ```bash
    KEY_PAIR_NAME="mc-aws"
    ```

4.  **Redeploy:**
    ```bash
    npm run deploy
    ```

**Usage:**

```bash
# SSH manually
ssh -i ~/.ssh/mc-aws.pem ec2-user@<SERVER_IP>

# Upload local server folder to replace EC2 server folder
./bin/upload-server.sh ./server/
```

---

## Google Drive (Optional) Backups/Transfers

You can push/pull server data via Google Drive using `rclone` without extra manual setup on the EC2 (tokens are injected by CDK if provided).

### One-time token capture (local)

1. Ensure AWS CLI is configured locally (`aws configure`).
2. Run:

```bash
./bin/setup-drive-token.sh
```

It opens a browser for Google OAuth and stores the token in AWS Secrets Manager. It will print a Secret ARN; add this to `.env`:

```
GDRIVE_TOKEN_SECRET_ARN="arn:...:secret:/minecraft/rclone-drive-token"
GDRIVE_REMOTE="gdrive"   # optional override
GDRIVE_ROOT="mc-backups" # optional override
```

3. Redeploy CDK so the instance gets the token and rclone config.

### Using Drive in scripts

- Upload to EC2 via Drive:

```bash
./bin/upload-server.sh --mode drive
```

- Download from EC2 to local backups (default local mode):

```bash
./bin/download-server.sh            # local rsync
./bin/download-server.sh --mode drive  # tar on EC2 -> Drive (no local copy)
```

Notes:

- Drive mode requires the token secret ARN in `.env` and a redeploy.
- Local mode behavior is unchanged (tar+rsync for upload; rsync for download).
- Idle-check is disabled during upload and re-enabled afterward.

## Weekly EBS Snapshots (Optional)

During deployment, you were asked if you want to enable weekly EBS snapshots via AWS Data Lifecycle Manager (DLM). This is optional but good practice for additional data protection.

**Cost:** ~$0.05 per snapshot (typically 1-2 snapshots retained at a time = ~$0.10/month extra)

**If you enabled snapshots during deploy:**

- Your EBS volume is automatically tagged with `Backup: weekly`
- DLM creates snapshots every Sunday at 2 AM UTC
- Snapshots are retained for 4 weeks, then automatically deleted
- You can restore from a snapshot if needed (via AWS Console → EC2 → Snapshots)

**If you want to enable/disable snapshots later:**

- Go to **EC2** > **Volumes** and select your server's volume
- Add or remove the tag: Key=`Backup`, Value=`weekly`
- The DLM policy will automatically pick up the change

## How to Manage It

**Playing:**
Send an email with the subject (or body) containing your start keyword (default "start") to your trigger address. Wait ~60 seconds, then connect your server from Minecraft.

**Managing Players:**

1.  **Find UUIDs:** Use a tool like [mcuuid.net](https://mcuuid.net/) to find the UUID for each player you want to allow.
2.  **Edit Config:** Update `config/whitelist.json` in this repo. It should look like this:
    ```json
    [
      {
        "uuid": "a1b2c3d4-e5f6-7890-1234-567890abcdef",
        "name": "PlayerOne"
      },
      {
        "uuid": "f1e2d3c4-b5a6-9780-4321-098765fedcba",
        "name": "PlayerTwo"
      }
    ]
    ```
3.  **Push:** Commit and push your changes to GitHub.
4.  **Sync:** The next time the server starts, it will automatically pull the latest changes.

**Updating Properties:**

1.  Edit `config/server.properties` in your local repo.
2.  Commit and push to GitHub.
3.  Restart the server (or wait for next boot) to apply changes.

## Hibernation (Zero Storage Cost)

If you're not going to play for an extended period (weeks/months), you can completely eliminate the ~$0.75/month storage cost by deleting the EBS volume. When you want to play again, you can restore it from your local backup.

### Hibernating Your Server

**Prerequisites:** Make sure you have a local backup of your world first!

1.  **Download Your World:**

    ```bash
    ./bin/download-server.sh
    ```

    This saves your world to a local directory with a timestamp.

2.  **Hibernate (Delete EBS):**
    ```bash
    ./bin/hibernate.sh
    ```
    This will:
    - Stop your EC2 instance
    - Optionally create an AWS snapshot backup (for extra safety)
    - Detach and delete the EBS volume
    - **Result: $0.00/month idle cost** (no storage charges)

### Resuming Your Server

When you want to play again:

1.  **Resume (Create Fresh EBS):**

    ```bash
    ./bin/resume.sh
    ```

    This will:
    - Create a new 8GB GP3 volume from the latest Amazon Linux 2023 AMI
    - Attach it to your EC2 instance
    - Start the instance
    - Auto-configure the server (via user_data script)

2.  **Wait for Setup:**
    Wait ~2 minutes for the user_data script to install Java, Paper, and configure everything.

3.  **Restore Your World:**

    ```bash
    ./bin/upload-server.sh /path/to/your/downloaded/server
    ```

    This uploads your world data back to the server.

4.  **Play**
    Connect to your Minecraft server as usual, using your domain and port.

### Cost Comparison

| Scenario                                     | Monthly Cost          |
| -------------------------------------------- | --------------------- |
| **Normal (Server stopped, EBS attached)**    | ~$0.75/month          |
| **Hibernated (Server stopped, EBS deleted)** | **$0.00/month**       |
| **Playing (Server running)**                 | ~$0.03/hour + storage |

**When to Hibernate:**

- You won't play for 2+ weeks
- You want absolute minimum cost
- You have reliable local backups

**When NOT to Hibernate:**

- You play regularly (weekly)
- You want instant startup via email trigger
- You don't want to manage local backups
