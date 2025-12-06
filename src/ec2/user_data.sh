#!/usr/bin/env bash
# Centralized version variables
MC_VERSION="1.21.1"
PAPER_BUILD="133"
PAPER_URL="https://api.papermc.io/v2/projects/paper/versions/${MC_VERSION}/builds/${PAPER_BUILD}/downloads/paper-${MC_VERSION}-${PAPER_BUILD}.jar"

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
if ! id "minecraft" &>/dev/null; then
  useradd -m -r minecraft
fi
mkdir -p /opt/minecraft/server
mkdir -p /opt/setup
chown -R minecraft:minecraft /opt/minecraft
chown minecraft:minecraft /opt/setup

# 7. Clone this repo (using a GitHub PAT stored in SSM Parameter Store)
GITHUB_USERNAME=$(aws ssm get-parameter --name /minecraft/github-user --query Parameter.Value --output text)
REPO_NAME=$(aws ssm get-parameter --name /minecraft/github-repo --query Parameter.Value --output text)
GITHUB_TOKEN=$(aws ssm get-parameter \
  --name /minecraft/github-pat \
  --with-decryption \
  --query Parameter.Value --output text)

if [[ ! -d "/opt/setup/.git" ]]; then
  sudo -u minecraft git clone \
    "https://${GITHUB_USERNAME}:${GITHUB_TOKEN}@github.com/${GITHUB_USERNAME}/${REPO_NAME}.git" \
    /opt/setup
fi

# 8. Download Paper jar & accept EULA
if [[ ! -f "/opt/minecraft/server/paper.jar" ]]; then
  sudo -u minecraft bash -c "
    cd /opt/minecraft/server
    wget ${PAPER_URL} -O paper.jar
  "
fi
if [[ ! -f "/opt/minecraft/server/eula.txt" ]]; then
  sudo -u minecraft bash -c 'echo "eula=true" > /opt/minecraft/server/eula.txt'
fi

# 9 Copy custom server and plugin config files
rsync -a /opt/setup/config/ /opt/minecraft/server/
chown -R minecraft:minecraft /opt/minecraft/server/

# 10. Deploy service unit and shutdown script
if [[ ! -f "/etc/systemd/system/minecraft.service" ]]; then
  cp /opt/setup/src/ec2/minecraft.service /etc/systemd/system/
fi
if [[ ! -f "/usr/local/bin/stop-ec2.sh" ]]; then
  cp /opt/setup/src/ec2/stop-ec2.sh /usr/local/bin/
  chown root:root /usr/local/bin/stop-ec2.sh && chmod +x /usr/local/bin/stop-ec2.sh
fi

# 11 Copy idle-check script and schedule cron
cp /opt/setup/src/ec2/check-mc-idle.sh /usr/local/bin/check-mc-idle.sh
chmod +x /usr/local/bin/check-mc-idle.sh

if ! grep -q "check-mc-idle.sh" /etc/cron.d/minecraft-idle 2>/dev/null; then
  tee /etc/cron.d/minecraft-idle << 'CRON'
*/1 * * * * root /usr/local/bin/check-mc-idle.sh
CRON
  chmod 644 /etc/cron.d/minecraft-idle
fi

# 12. Enable & start the Minecraft service
systemctl daemon-reload
systemctl enable minecraft.service
if ! systemctl is-active --quiet minecraft.service; then
  systemctl start minecraft.service
fi
