#!/usr/bin/env bash
set -euo pipefail

log() { echo "[$(date -Is)] $*"; }

# Centralized version variables
MC_VERSION="1.21.1"
PAPER_BUILD="133"
PAPER_URL="https://api.papermc.io/v2/projects/paper/versions/${MC_VERSION}/builds/${PAPER_BUILD}/downloads/paper-${MC_VERSION}-${PAPER_BUILD}.jar"
GDRIVE_REMOTE="${GDRIVE_REMOTE:-gdrive}"
GDRIVE_ROOT="${GDRIVE_ROOT:-mc-backups}"
GDRIVE_TOKEN_SECRET_ARN="${GDRIVE_TOKEN_SECRET_ARN:-}"

# 1. Update & install prerequisites
log "Updating base packages..."
dnf update -y

# 2. Add the Corretto 21 repo (single file contains all versions)
rpm --import https://yum.corretto.aws/corretto.key
curl -L -o /etc/yum.repos.d/corretto.repo https://yum.corretto.aws/corretto.repo

# 3. Install Java 21, unzip, git, Python3 & pip3, and cron
log "Installing Java, Git, Python, pip, cron, rsync (core deps)..."
dnf install -y java-21-amazon-corretto-devel unzip git python3 python3-pip cronie rsync
log "Installing rclone (upstream binary)..."
curl -L -o /tmp/rclone.zip https://downloads.rclone.org/rclone-current-linux-arm64.zip
unzip -o /tmp/rclone.zip -d /tmp/rclone
install /tmp/rclone/rclone-*/rclone /usr/local/bin/rclone || log "Warning: rclone install failed"
if ! command -v git >/dev/null 2>&1; then
  log "git missing after install; retrying..."
  dnf install -y git
fi
if ! command -v python3 >/dev/null 2>&1; then
  log "python3 missing after install; retrying..."
  dnf install -y python3
fi
if ! python3 -m pip --version >/dev/null 2>&1; then
  log "pip missing; installing python3-pip..."
  dnf install -y python3-pip
fi
if ! command -v unzip >/dev/null 2>&1; then
  log "unzip missing after install; retrying..."
  dnf install -y unzip
fi
systemctl enable --now crond

# 4. Install AWS CLI v2 (ARM64)
curl "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o /tmp/awscliv2.zip
unzip /tmp/awscliv2.zip -d /tmp
/tmp/aws/install || { log "AWS CLI install failed"; exit 1; }

# 5. Install mcstatus for querying player count
python3 -m pip install mcstatus

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
  log "Cloning setup repo into /opt/setup..."
  sudo -u minecraft git clone \
    "https://${GITHUB_USERNAME}:${GITHUB_TOKEN}@github.com/${GITHUB_USERNAME}/${REPO_NAME}.git" \
    /opt/setup
fi

if [[ ! -d "/opt/setup" ]]; then
  log "/opt/setup not present after clone; aborting."
  exit 1
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
if [[ -d /opt/setup/config ]]; then
  rsync -a /opt/setup/config/ /opt/minecraft/server/
else
  log "Warning: /opt/setup/config not found; skipping config copy."
fi
chown -R minecraft:minecraft /opt/minecraft/server/

# 9.5 Configure rclone for Drive if token provided (reads from SSM Parameter Store)
TOKEN_JSON=$(aws ssm get-parameter --name /minecraft/gdrive-token --with-decryption --query Parameter.Value --output text 2>/dev/null || echo "")
if [[ -n "$TOKEN_JSON" ]]; then
  mkdir -p /opt/setup/rclone
  cat > /opt/setup/rclone/rclone.conf <<EOF
[${GDRIVE_REMOTE}]
type = drive
token = ${TOKEN_JSON}
EOF
  chown -R minecraft:minecraft /opt/setup/rclone
  log "rclone configured for Google Drive"
else
  log "No Google Drive token found in SSM; skipping rclone setup"
fi

# 10. Deploy service unit and shutdown script
if [[ ! -f "/etc/systemd/system/minecraft.service" ]]; then
  if [[ -f /opt/setup/src/ec2/minecraft.service ]]; then
    cp /opt/setup/src/ec2/minecraft.service /etc/systemd/system/
  else
    log "Error: minecraft.service unit file missing in /opt/setup/src/ec2; aborting."
    exit 1
  fi
fi

# 11 Copy idle-check script and schedule cron
if [[ -f /opt/setup/src/ec2/check-mc-idle.sh ]]; then
  cp /opt/setup/src/ec2/check-mc-idle.sh /usr/local/bin/check-mc-idle.sh
  chmod +x /usr/local/bin/check-mc-idle.sh
else
  log "Warning: check-mc-idle.sh missing; skipping idle cron install."
fi

if [[ -f /usr/local/bin/check-mc-idle.sh ]]; then
  if ! grep -q "check-mc-idle.sh" /etc/cron.d/minecraft-idle 2>/dev/null; then
    tee /etc/cron.d/minecraft-idle << 'CRON'
*/1 * * * * root /usr/local/bin/check-mc-idle.sh
CRON
    chmod 644 /etc/cron.d/minecraft-idle
  fi
fi

# 12. Enable & start the Minecraft service
systemctl daemon-reload
systemctl enable minecraft.service
if ! systemctl is-active --quiet minecraft.service; then
  systemctl start minecraft.service
fi
