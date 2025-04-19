# Minecraft Server Setup & Management

## Initial EC2 Setup

*   **Security Group:** Create a security group allowing inbound traffic on port `25565` (Minecraft) from anywhere and port `22` (SSH) from your IP address. Apply this security group to the EC2 instance.
*   **AMI:** Use an ARM Amazon Linux 23 AMI.
*   **Instance Type:** Use `t4g.medium`.

## Connecting & Server Management

*   **SSH into the instance:**
    ```bash
    ssh -i ~/path/to/your-key.pem ec2-user@YOUR_PUBLIC_IP
    ```
*   **Check Minecraft service status:**
    ```bash
    sudo systemctl status minecraft.service
    ```
*   **View live Minecraft server output:**
    ```bash
    sudo journalctl -u minecraft.service -f
    ```
*   **View cloud-init logs:**
    ```bash
    sudo less /var/log/cloud-init-output.log
    ```
*   **Interact with the Minecraft server console:**
    ```bash
    sudo -u minecraft screen -r mc-server
    ```
    *(Press `Ctrl+A` then `D` to detach from the screen session)*

## Email Trigger Setup (SES -> SNS -> Lambda)

*   Email is sent to a Cloudflare-managed domain.
*   An MX record points to AWS SES in `us-west-1` for email receiving.
*   SES rule triggers an SNS topic upon receiving email.
*   **Cloudflare Zone ID:** `6b87aa58326735e0cd2be765519df8d2`
*   **SNS Topic ARN:** `arn:aws:sns:us-west-1:123456789012:IncomingMailTopic`

## Backup Management (AWS Backup / DLM)

*   **Policy ID:** `policy-089a4cc6284c6dcb0`
*   **Volume ID Variable:**
    ```bash
    export VOLUME_ID="vol-0835448fa8d5e7e41"
    ```
*   **Turn backups OFF (Remove tag):**
    ```bash
    aws ec2 delete-tags \
      --resources $VOLUME_ID \
      --tags Key=Backup,Value=weekly
    ```
*   **Turn backups ON (Add tag):**
    ```bash
    aws ec2 create-tags \
      --resources $VOLUME_ID \
      --tags Key=Backup,Value=weekly
    ```

## Recovering from Backup

1.  **List available snapshots:**
    ```bash
    aws ec2 describe-snapshots \
      --filters Name=tag:CreatedBy,Values=dlm* \
                Name=tag:Backup,Values=weekly \
      --query "Snapshots[*].[SnapshotId,StartTime]" --output table
    ```
2.  **Create a new volume from a snapshot:** (Replace `<snap-id>` and ensure correct `availability-zone`)
    ```bash
    aws ec2 create-volume \
      --snapshot-id <snap-id> \
      --availability-zone us-west-2a \
      --volume-type gp2
    ```
3.  **Restore the world data on the instance:**
    ```bash
    # SSH into your instance first

    # Stop the Minecraft server
    sudo systemctl stop minecraft.service

    # Mount the newly created volume (replace /dev/xvdf if needed)
    sudo mkdir /mnt/restore
    sudo mount /dev/xvdf /mnt/restore

    # Copy the world data (use rsync for efficiency)
    # Ensure the source path /mnt/restore/server/world exists on the backup volume
    sudo rsync -avh --delete /mnt/restore/server/world/ /opt/minecraft/server/world/
    sudo chown -R minecraft:minecraft /opt/minecraft/server/world

    # Clean up
    sudo umount /mnt/restore
    sudo rmdir /mnt/restore

    # Start the Minecraft server
    sudo systemctl start minecraft.service
    ```
