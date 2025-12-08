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
- [How It Works](#how-it-works)
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
- `setup/iam/` - AWS permission policies.
- `setup/dlm/` - Backup schedule (snapshots).

## Setup Guide (Option 1: Automated with CDK)

If you want to set everything up with a single command, and don't require any special modifications, follow these steps.

### Prerequisites
1.  **Node.js** installed.
2.  **AWS CLI** installed and configured (`aws configure`).
3.  **Cloudflare** API Token and Zone ID (see Manual Guide Step 2).
4.  **Verified Email** in AWS SES (see Manual Guide Step 6).
    *   **Sender:** The email you will send the "start" command *from*.
    *   **Receiver:** The email you want to receive notifications *to* (if different from sender).
5.  **Session Manager Plugin** (for connecting to the server):
    ```bash
    brew install --cask session-manager-plugin
    ```

### Steps
1.  **Install Dependencies:**
    ```bash
    npm install
    ```

2.  **Configure AWS CLI:**
    ```bash
    aws configure
    ```
    Enter your AWS Access Key ID, Secret Access Key, default region (e.g., `us-west-1`), and default output format (`json`).

3.  **Bootstrap CDK:** (Only needed once per AWS account/region)
    ```bash
    npx cdk bootstrap
    ```

4.  **Configure Environment:**
    Copy the provided `.env.template` file to `.env` and fill in your details:
    ```bash
    cp .env.template .env
    ```
    Then edit `.env` with your specific values for:
    - Cloudflare API token and domain configuration
    - GitHub credentials (for server to pull config)
    - AWS SES email addresses
      - `VERIFIED_SENDER`: The email that receives trigger emails *and* sends notifications (e.g., `start@yourdomain.com`)
      - `NOTIFICATION_EMAIL`: Where you want to receive "server started" alerts (optional)
    - AWS account ID and preferred region

5.  **Deploy:**
    ```bash
    npm run deploy
    ```
    This will create the EC2 instance, Lambda, Roles, and SES Rules for you. It will also **automatically activate** the SES Rule Set.

---

---

## Connecting to the Server

You have two ways to connect to your EC2.

### Method 1: The Modern Way (Recommended)
This uses AWS Systems Manager (SSM). No SSH keys or open ports required.

-  **Connect to Shell:**
    ```bash
    ./bin/connect.sh
    ```
    This drops you into a root shell on the server.

-  **Connect to Minecraft Console:**
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

## Setup Guide (Option 2: Manual)

If you prefer to build this by hand to learn how the pieces fit together, follow these steps.

### Prerequisites

- An AWS Account
- A domain managed by **Cloudflare**. This is necessary for the API DNS updates (and is very easy to set up).
- **Node.js** installed locally (to package the Lambda function).
- **AWS CLI** installed and configured locally (optional, but helpful).

### 1. The Code

1.  **Fork this repo** to your own GitHub account.
2.  Clone your fork to your local machine.

### 2. Cloudflare Setup

You could use any DNS provider, but you have to be able to dynamically update the DNS record. There is a modest cost (<$1 per month) for a domain, but you can re-use it for any and all of your projects. If you already have one, even better.  
  
You'll need three things from Cloudflare: your `Zone ID`, an `API Token`, and the `Record ID` of the DNS record you will create.

1.  **Zone ID:**
    - Log in to Cloudflare and select your domain.
    - Open the "Overview" section and scroll down to the "API" section on the right sidebar.
    - Take note of the **Zone ID**.

2.  **API Token:**
    - Go to **Manage account** > **Account API tokens**
    - Choose the **Edit Zone DNS** template
    - Select **Create Custom Token**.
    - **Permissions:**
      - Zone > DNS > Edit
    - **Zone Resources:**
      - Include > Specific zone > Your Domain
    - Click **Continue to Summary** -> **Create Token**.
    - **Take note of the token immediately** (you won't see it again).

3.  **Record ID:**
    - Go to **DNS** > **Records** on the left sidebar.
    - Create an **A** record for your Minecraft subdomain (e.g., `mc`). Point it to `1.1.1.1` (this is a placeholder, it will be updated automatically).
    - To get the `Record ID`, you need to use the API (it isn't shown in the dashboard). Open your terminal and run:
      ```bash
      # Replace <ZONE_ID> and <API_TOKEN> with the values from steps 1 and 2
      curl -X GET "https://api.cloudflare.com/client/v4/zones/<ZONE_ID>/dns_records" \
           -H "Authorization: Bearer <YOUR_API_TOKEN>" \
           -H "Content-Type: application/json"
      ```
    - Look for the DNS record you just created (i.e. `mc.yourdomain.com`) in the JSON output and copy its `id`.


### 3. AWS IAM Setup

You need to create two roles: one for the EC2 instance and one for the Lambda function.

**A. EC2 Role (`MinecraftServerRole`)**
1.  Go to **IAM** > **Roles** > **Create role**.
2.  Select **AWS service** and choose **EC2**.
3.  Click **Next**.
4.  **Permissions:**
    - Click **Create policy**.
    - Switch to **JSON** tab.
    - Copy content from `setup/iam/allow-read-github-pat-policy.json`.
    - Name it `MinecraftReadSecrets`.
    - Create another policy with content from `setup/iam/ec2-stop-instance-policy.json`.
    - Name it `MinecraftSelfStop`.
    - Back in the "Create role" tab, refresh and select `MinecraftReadSecrets`, `MinecraftSelfStop`, and `AmazonSSMManagedInstanceCore` (for Session Manager access).
5.  Name the role `MinecraftServerRole` and create it.

**B. Lambda Role (`MinecraftLauncherRole`)**
1.  Go to **IAM** > **Roles** > **Create role**.
2.  Select **AWS service** and choose **Lambda**.
3.  Click **Next**.
4.  **Permissions:**
    - Create a policy with content from `setup/iam/ec2-start-describe-policy.json`.
    - **IMPORTANT:** Edit the JSON to replace `<EC2_INSTANCE_ID>` with `*` (since you don't have the ID yet) or come back and update it once you have your EC2 instance ID..
    - Name it `MinecraftStartEC2`.
    - Create a policy with content from `setup/iam/ses-send-email-policy.json`.
    - Name it `MinecraftSendEmail`.
    - Select `MinecraftStartEC2`, `MinecraftSendEmail`, and `AWSLambdaBasicExecutionRole`.
5.  Name the role `MinecraftLauncherRole` and create it.

### 4. AWS Secrets (SSM Parameter Store)

The server needs your GitHub credentials to pull the config.

1.  Go to **Systems Manager** > **Parameter Store**.
2.  Click **Create parameter**.
3.  **GitHub User:**
    - Name: `/minecraft/github-user`
    - Type: `String`
    - Value: `YourGitHubUsername`
4.  **GitHub Repo:**
    - Name: `/minecraft/github-repo`
    - Type: `String`
    - Value: `YourRepoName` (e.g., `mc-aws`)
5.  **GitHub PAT (Personal Access Token):**
    - Generate a Classic PAT in GitHub (Settings > Developer settings > Personal access tokens > Tokens (classic)) with `repo` scope.
    - Name: `/minecraft/github-pat`
    - Type: **`SecureString`**
    - Value: `ghp_...`

### 5. The Trigger (Lambda)

1.  **Prepare the Code:**
    - On your local machine, navigate to `src/lambda/StartMinecraftServer`.
    - Run `npm install`.
    - Zip the contents: `zip -r function.zip .` (make sure `index.js` is at the root of the zip, not inside a folder).

2.  **Create Function:**
    - Go to **Lambda** > **Create function**.
    - Name: `StartMinecraftServer`.
    - Runtime: **Node.js 20.x**.
    - Execution role: **Use an existing role** -> `MinecraftLauncherRole`.
    - Click **Create function**.

3.  **Upload Code:**
    - In the **Code** tab, click **Upload from** > **.zip file**.
    - Upload your `function.zip`.

4.  **Configuration:**
    - Go to **Configuration** > **Environment variables**.
    - Add the following:
      - `CLOUDFLARE_API_TOKEN`: (From Step 2)
      - `CLOUDFLARE_MC_DOMAIN`: `mc.yourdomain.com`
      - `CLOUDFLARE_RECORD_ID`: (From Step 2)
      - `CLOUDFLARE_ZONE_ID`: (From Step 2)
      - `INSTANCE_ID`: (Leave placeholder `pending` for now)
      - `NOTIFICATION_EMAIL`: Email that you want to receive notifications when the EC2 is activated (optional, must be verified in SES)
      - `START_KEYWORD`: choose a start keyword that anybody can email to the address in SES to start the server (e.g., `start`)
      - `VERIFIED_SENDER`: `start@yourdomain.com` (The email address you will set up in SES)

### 6. SES & SNS Setup

1.  **Verify Identity:**
    - Open the AWS Console and go to **Amazon SES** > **Identities**.
    - Click **Create identity**.
    - Select **Domain**
    - Follow the verification steps (add DNS records for domain, or click link for email).
    - **Note:** If in Sandbox mode, you must also verify the email address you will be *sending from* (your personal email).
    - **Notification Email:** If you want to receive startup notifications, you must also verify that email address (if it's different from the one above).

2.  **Create SNS Topic:**
    - Go to **Amazon SNS** > **Topics** > **Create topic**.
    - Type: **Standard**.
    - Name: `MinecraftStartTopic`.
    - Create it.
    - Click **Create subscription**.
    - Protocol: **AWS Lambda**.
    - Endpoint: `StartMinecraftServer`.

3.  **Create Receipt Rule:**
    - Go to **Amazon SES** > **Email receiving**.
    - Create a **Rule Set** (if none exists).
    - Create a **Rule**.
    - **Recipient conditions:** `start@yourdomain.com` (or just your domain).
    - **Actions:** Add **SNS** action.
    - Topic: `MinecraftStartTopic`.
    - Finish and create.

### 7. Launch the Server (EC2)

1.  Go to **EC2** > **Instances** > **Launch instances**.
2.  **Name:** `Minecraft Server`.
3.  **OS:** Amazon Linux 2023 AMI (Architecture: **64-bit (Arm)**).
4.  **Instance Type:** `t4g.medium`.
5.  **Key pair:** Select one or create one (for SSH access).
6.  **Network settings:**
    - Select your VPC/Subnet.
    - **Auto-assign public IP:** Enable.
    - **Security group:** Create new. Allow **TCP 25565** (Minecraft) and **TCP 22** (SSH).
7.  **Configure storage:** 10 GiB gp3 is usually enough.
8.  **Advanced details:**
    - **IAM instance profile:** `MinecraftServerRole`.
    - **User data:** Copy and paste the contents of `src/ec2/user_data.sh` from this repo.
9.  **Launch instance**.
10. **Get Instance ID:**
    - Copy the new Instance ID (e.g., `i-0123456789abcdef0`).
    - Go back to your **Lambda** function > **Configuration** > **Environment variables**.
    - Update `INSTANCE_ID` with the real ID.
    - (Optional) Update your IAM Policy `MinecraftStartEC2` to restrict permissions to this specific ID.

## Backups (Optional)

To enable weekly backups:
1. Go to EC2 > Volumes. Select your server's volume.
2. Add a tag: Key=`Backup`, Value=`weekly`.
3. Run the following command (requires AWS CLI) to create the lifecycle policy:
   ```bash
   aws dlm create-lifecycle-policy --region us-west-1 --cli-input-json file://setup/dlm/weekly-policy.json
   ```
   (Make sure to update the region in the command if needed. Also, you should verify in the console that the policy was created successfully.)

## How to Manage It

**Playing:**
Send an email with the subject (or body) containing your start keyword (default "start") to your trigger address. Wait ~60 seconds, then connect your server from Minecraft.

**Note:** After running `npm run deploy`, Cloudflare DNS may not immediately point to your EC2's IP because the Lambda function only updates DNS when it starts the instance (during the email trigger). If you want to connect to the already-running EC2, send a start email to update Cloudflare DNS with the current IP address.

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
    - Create a new 10GB GP3 volume from the latest Amazon Linux 2023 AMI
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

4.  **Play!**
    Connect to your Minecraft server as usual.

### Cost Comparison

| Scenario | Monthly Cost |
|----------|--------------|
| **Normal (Server stopped, EBS attached)** | ~$0.75/month |
| **Hibernated (Server stopped, EBS deleted)** | **$0.00/month** |
| **Playing (Server running)** | ~$0.03/hour + storage |

**When to Hibernate:**
- You won't play for 2+ weeks
- You want absolute minimum cost
- You have reliable local backups

**When NOT to Hibernate:**
- You play regularly (weekly)
- You want instant startup via email trigger
- You don't want to manage local backups
