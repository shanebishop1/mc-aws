#!/usr/bin/env bash
# 1. Update & install prerequisites
dnf update -y

# 2. Add the Corretto 21 repo (single file contains all versions)
rpm --import https://yum.corretto.aws/corretto.key
curl -L -o /etc/yum.repos.d/corretto.repo https://yum.corretto.aws/corretto.repo

# 3. Install Java 21, unzip, git, Python3 & pip3, and cron
dnf install -y java-21-amazon-corretto-devel unzip git python3 python3-pip cronie
systemctl enable --now crond

# 4. Install AWS CLI v2 (ARM64)
curl "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o /tmp/awscliv2.zip
unzip /tmp/awscliv2.zip -d /tmp
/tmp/aws/install

# 5. Install mcstatus for querying player count
pip3 install mcstatus

# 6. Create minecraft user & dirs
useradd -m -r minecraft
mkdir -p /opt/minecraft/server
mkdir -p /opt/setup
chown -R minecraft:minecraft /opt/minecraft
chown minecraft:minecraft /opt/setup

# 7. Clone this repo (using a GitHub PAT stored in SSM Parameter Store)
GITHUB_TOKEN=$(aws ssm get-parameter \
  --name /minecraft/github-pat \
  --with-decryption \
  --query Parameter.Value --output text)

sudo -u minecraft git clone \
  https://shanebishop1:${GITHUB_TOKEN}@github.com/shanebishop1/mc_aws.git \
  /opt/setup

# 8. Download Paper jar & accept EULA
sudo -u minecraft bash -c '
  cd /opt/minecraft/server
  wget https://api.papermc.io/v2/projects/paper/versions/1.21.1/builds/133/downloads/paper-1.21.1-133.jar -O paper.jar
  echo "eula=true" > eula.txt
'

# 9 Copy custom server files
rsync -a /opt/setup/server/ /opt/minecraft/server/
chown -R minecraft:minecraft /opt/minecraft/server/

# 10. Deploy service unit and shutdown script
cp /opt/setup/ec2/minecraft.service /etc/systemd/system/
cp /opt/setup/ec2/stop-ec2.sh /usr/local/bin/
chown root:root /usr/local/bin/stop-ec2.sh && chmod +x /usr/local/bin/stop-ec2.sh

# 11 Copy idle-check script and schedule cron
cp /opt/setup/ec2/check-mc-idle.sh /usr/local/bin/check-mc-idle.sh
chmod +x /usr/local/bin/check-mc-idle.sh

tee /etc/cron.d/minecraft-idle << 'CRON'
*/1 * * * * root /usr/local/bin/check-mc-idle.sh >/dev/null 2>&1
CRON
chmod 644 /etc/cron.d/minecraft-idle

# 12. Enable & start the Minecraft service
systemctl daemon-reload
systemctl enable minecraft.service
systemctl start minecraft.service
