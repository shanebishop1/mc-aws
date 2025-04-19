# Project Summary: Automated Minecraft Server on AWS

This project provides a fully automated, cost-efficient Minecraft hosting solution on AWS, leveraging EC2, Lambda, SES, Cloudflare, and DLM. The server automatically starts via an email trigger and stops itself after a period of inactivity, minimizing costs. Configuration and infrastructure "glue" code are managed via Git (GitOps style).

## Goals

*   **Cost Efficiency:** Utilize ARM-based EC2 instances (`t4g.medium`) for better price-performance. Pay per-second compute only when the server is actively used due to auto-shutdown. Minimize backup costs using incremental EBS snapshots managed by DLM.
*   **Automation:** One-click launch via EC2 user-data, automated idle shutdown, automated startup via email, and fully managed backups.
*   **Reliability & Clean Shutdown:** Ensure world saves via graceful shutdown (`systemctl stop` triggering screen command), automatic service restarts on failure (`systemd`), and robust idle detection logic.
*   **GitOps-Style Versioning:** All infrastructure setup scripts, systemd units, and IAM policies reside in a GitHub repository. No game data, JARs, or logs are stored in the repo.

## Architecture & Setup

### 1. EC2 Instance Configuration (`t4g.medium`)

*   **AMI:** Amazon Linux 23 (ARM64).
*   **Instance Type:** `t4g.medium` (2 vCPUs, 4 GiB RAM).
*   **IAM Role:** An IAM role attached to the instance grants permissions to:
    *   Read a GitHub PAT from SSM Parameter Store (`ssm:GetParameter`, `kms:Decrypt` via `iam/AllowReadGithubPAT.json`).
    *   Stop its own instance (`ec2:StopInstances` via `iam/EC2StopInstance.json`).
*   **Cloud-Init (`ec2/user_data.sh`):** On first boot, the user-data script performs the following:
    *   Installs prerequisites: Corretto Java 21, git, python3, pip, cronie, AWS CLI v2.
    *   Installs `mcstatus` Python package (for player count checking).
    *   Creates a dedicated `minecraft` user and directories (`/opt/minecraft/server`, `/opt/setup`).
    *   Fetches a GitHub PAT from SSM Parameter Store (`/minecraft/github-pat`) and clones the configuration repository into `/opt/setup`.
    *   Downloads the specified PaperMC JAR (`1.21.4-226`) to `/opt/minecraft/server/paper.jar` and accepts the EULA.
    *   Copies server configuration files (like `server.properties`) from the cloned repo (`/opt/setup/server/`) to `/opt/minecraft/server/` using `rsync`.
    *   Copies the systemd service file (`ec2/minecraft.service`) to `/etc/systemd/system/`.
    *   Copies the idle check script (`ec2/check-mc-idle.sh`) to `/usr/local/bin/` and makes it executable.
    *   Sets up a cron job (`/etc/cron.d/minecraft-idle`) to run `/usr/local/bin/check-mc-idle.sh` every minute (`*/1 * * * *`).
    *   Reloads systemd, enables `crond` and `minecraft.service`, and starts both services.

### 2. Minecraft Service (`ec2/minecraft.service`)

*   **Type:** `forking` (uses `screen` for detaching).
*   **User:** Runs as the `minecraft` user.
*   **Working Directory:** `/opt/minecraft/server`.
*   **Startup:**
    *   `ExecStartPre`: Syncs config files from `/opt/setup/server/` and ensures correct ownership before starting.
    *   `ExecStart`: Starts the PaperMC server inside a detached `screen` session named `mc-server` (`screen -DmS mc-server`). Allocates 3276MB of heap (`-Xms3276M -Xmx3276M`).
*   **Shutdown:**
    *   `ExecStop`: Sends the `stop` command to the Minecraft console via `screen`.
    *   `ExecStopPost`: Quits the `screen` session.
    *   `TimeoutStopSec=60`: Allows 60 seconds for graceful shutdown.
*   **Reliability:** `Restart=on-failure` ensures systemd restarts the server if it crashes.

### 3. Idle Shutdown (`ec2/check-mc-idle.sh`)

*   **Trigger:** Runs every minute via cron.
*   **Logic:**
    1.  Queries player count using `mcstatus localhost status`. Handles `mcstatus` errors gracefully.
    2.  If players > 0, removes an idle marker file (`/tmp/mc-idle.marker`) and exits.
    3.  If players = 0:
        *   If the marker file doesn't exist, creates it and exits.
        *   If the marker file exists, checks its modification time.
    4.  If the marker file is older than 15 minutes (`THRESHOLD=900` seconds):
        *   Logs the shutdown event to `/var/log/mc-idle.log`.
        *   Stops the `minecraft.service` using `systemctl stop`.
        *   Waits up to 2 minutes (`24 * 5s` loop) for the service to fully stop.
        *   Removes the marker file.
        *   Retrieves the instance ID from the EC2 metadata service.
        *   Calls `aws ec2 stop-instances --instance-ids <instance-id>` to stop the EC2 instance itself (requires IAM permission).

### 4. Email-Based Startup (SES -> SNS -> Lambda)

*   **Domain & DNS:** A domain (e.g., `yourdomain.com`) is managed by Cloudflare.
    *   An `A` record (e.g., `mc.yourdomain.com`) points to the EC2 instance's IP (dynamically updated).
    *   An `MX` record points to the AWS SES inbound endpoint for the region (e.g., `us-west-1`).
*   **SES:**
    *   Receives email sent to a specific address (e.g., `start@yourdomain.com`).
    *   A Receipt Rule Set triggers an SNS topic (`IncomingMailTopic`) when email arrives at the designated address.
*   **Lambda (`lambda/StartMinecraftServer/index.js`):**
    *   Triggered by the SNS topic.
    *   **Environment Variables:** Requires `INSTANCE_ID`, `VERIFIED_SENDER`, `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_RECORD_ID`, `CLOUDFLARE_MC_DOMAIN`.
    *   **Logic:**
        1.  Parses the SNS message to get the raw email content.
        2.  Checks if the email subject or body contains the keyword "start" (case-insensitive).
        3.  If "start" is found:
            *   Sends a notification email (to a hardcoded address `you@yourdomain.com`) via SES indicating startup was triggered.
            *   Calls `EC2:StartInstances` for the configured `INSTANCE_ID`.
            *   Polls `EC2:DescribeInstances` repeatedly (every 1s for up to 300s) until a Public IP address is available for the instance.
            *   Uses the Cloudflare API (`node-fetch`) to update the `A` record (`CLOUDFLARE_MC_DOMAIN`) in the specified zone/record ID to point to the new Public IP. Sets TTL to 60 seconds.
    *   **IAM Role:** Requires permissions for `ec2:StartInstances`, `ec2:DescribeInstances`, and `ses:SendEmail` (`iam/lambda-ec2-ses-policy.json`).

### 5. Automated Weekly Backups (DLM)

*   **Mechanism:** AWS Data Lifecycle Manager (DLM) policy (`dlm/weekly-policy.json`).
*   **Target:** Creates snapshots for any EBS volume tagged with `Backup=weekly`.
*   **Schedule:** Runs weekly, every Monday at 3:00 AM UTC (`cron(0 3 ? * MON *)`).
*   **Retention:** Keeps the 4 most recent snapshots (`RetainRule: { Count: 4 }`).
*   **Cost:** Snapshots are incremental; cost is based on changed blocks (~$0.05/GB-month).
*   **Management:** Backups can be enabled/disabled for the primary volume by adding/removing the `Backup=weekly` tag using AWS CLI commands (see `README.md`).

### 6. Recovery Procedure (`README.md`)

1.  **List available snapshots:** Identify the snapshot you want to restore from.
    ```bash
    aws ec2 describe-snapshots \
      --filters Name=tag:CreatedBy,Values=dlm* \
                Name=tag:Backup,Values=weekly \
      --query "Snapshots[*].[SnapshotId,StartTime]" --output table
    ```
2.  **Create a new volume from the snapshot:** Replace `<snap-id>` with the chosen Snapshot ID and ensure the `--availability-zone` matches your EC2 instance's AZ (e.g., `us-west-1c`).
    ```bash
    aws ec2 create-volume \
      --snapshot-id <snap-id> \
      --availability-zone us-west-1c \
      --volume-type gp3 # Or gp2, depending on your preference
    ```
    *(Note the `VolumeId` from the output, e.g., `vol-0123456789abcdef0`)*
3.  **Attach the new volume to the instance:** Replace `<instance-id>` and `<volume-id>` with your values. The device name (e.g., `/dev/sdf`) should be available.
    ```bash
    aws ec2 attach-volume \
      --instance-id <instance-id> \
      --volume-id <volume-id> \
      --device /dev/sdf
    ```
4.  **Restore the world data on the instance:**
    *   SSH into your instance: `ssh -i ~/keypairs/ocmc-key-pair.pem ec2-user@mc.yourdomain.com`
    *   Stop the Minecraft server:
        ```bash
        sudo systemctl stop minecraft.service
        ```
    *   Mount the newly attached volume (check `lsblk` if `/dev/xvdf` isn't correct):
        ```bash
        sudo mkdir /mnt/restore
        sudo mount /dev/xvdf /mnt/restore
        ```
    *   Copy the world data using `rsync` (ensure `/mnt/restore/server/world/` exists on the backup):
        ```bash
        sudo rsync -avh --delete /mnt/restore/server/world/ /opt/minecraft/server/world/
        sudo chown -R minecraft:minecraft /opt/minecraft/server/world
        ```
    *   Clean up:
        ```bash
        sudo umount /mnt/restore
        sudo rmdir /mnt/restore
        ```
    *   Start the Minecraft server:
        ```bash
        sudo systemctl start minecraft.service
        ```
5.  **(Optional) Detach the restore volume:** Once confirmed, you can detach the volume via the AWS Console or CLI:
    ```bash
    aws ec2 detach-volume --volume-id <volume-id>
    ```
    *(You can then delete the volume if no longer needed)*

## Connecting & Management (`README.md`)

*   **Connect:** Players connect using the Cloudflare-managed hostname (e.g., `mc.yourdomain.com` with port `25565`), which always points to the current IP.
*   **SSH:** Connect via SSH using the instance's public IP (if known) or the Cloudflare hostname.
*   **Server Console:** Attach to the running server console using `sudo -u minecraft screen -r mc-server`. Detach with `Ctrl+A`, then `D`.
*   **Logs:**
    *   Minecraft Service: `sudo journalctl -u minecraft.service -f`
    *   Cloud-Init: `sudo less /var/log/cloud-init-output.log`
    *   Idle Check: `sudo less /var/log/mc-idle.log`
