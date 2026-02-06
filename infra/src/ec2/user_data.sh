#!/usr/bin/env bash
set -euo pipefail

log() { echo "[$(date -Is)] $*"; }

# Centralized version variables
MC_VERSION="1.21.11"
PAPER_BUILD_DEFAULT="69"
GDRIVE_REMOTE="${GDRIVE_REMOTE:-gdrive}"
GDRIVE_ROOT="${GDRIVE_ROOT:-mc-backups}"

# 1. Update & install prerequisites
log "Updating base packages..."
dnf update -y

# 2. Add the Corretto 21 repo (single file contains all versions)
rpm --import https://yum.corretto.aws/corretto.key
curl -L -o /etc/yum.repos.d/corretto.repo https://yum.corretto.aws/corretto.repo

# 3. Install Java 21, unzip, git, Python3 & pip3, and cron
log "Installing Java, Git, Python, pip, cron, rsync (core deps)..."
dnf install -y java-21-amazon-corretto-devel unzip git python3 python3-pip cronie rsync screen
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

# 7. Clone this repo and configure runtime git auth for service pulls
GITHUB_USERNAME=$(aws ssm get-parameter --name /minecraft/github-user --query Parameter.Value --output text)
REPO_NAME=$(aws ssm get-parameter --name /minecraft/github-repo --query Parameter.Value --output text)
GITHUB_TOKEN=$(aws ssm get-parameter \
  --name /minecraft/github-pat \
  --with-decryption \
  --query Parameter.Value --output text)

# Install a reusable credential helper used by clone and runtime git pull
CREDENTIAL_HELPER_FILE="/usr/local/bin/git-credential-minecraft"
cat > "$CREDENTIAL_HELPER_FILE" <<'HELPER_EOF'
#!/usr/bin/env bash
set -euo pipefail

action="${1:-}"
if [[ "$action" != "get" ]]; then
  exit 0
fi

protocol=
host=
while IFS='=' read -r key value; do
  case "$key" in
    protocol) protocol="$value" ;;
    host) host="$value" ;;
  esac
done

if [[ "$protocol" == "https" && "$host" == "github.com" ]]; then
  if [[ -n "${GITHUB_USERNAME:-}" && -n "${GITHUB_TOKEN:-}" ]]; then
    echo "username=${GITHUB_USERNAME}"
    echo "password=${GITHUB_TOKEN}"
  fi
fi
HELPER_EOF
chmod 755 "$CREDENTIAL_HELPER_FILE"

# Persist credentials for systemd runtime environment (ExecStartPre git pull)
cat > /etc/default/minecraft <<EOF
GITHUB_USERNAME=${GITHUB_USERNAME}
GITHUB_TOKEN=${GITHUB_TOKEN}
EOF
chmod 600 /etc/default/minecraft

if [[ ! -d "/opt/setup/.git" ]]; then
  log "Cloning setup repo into /opt/setup..."
  # Clone using credential helper (runs as minecraft user with env vars passed explicitly)
  if ! sudo -u minecraft \
    GITHUB_USERNAME="$GITHUB_USERNAME" \
    GITHUB_TOKEN="$GITHUB_TOKEN" \
    bash -c "git -c credential.helper='$CREDENTIAL_HELPER_FILE' clone https://github.com/$GITHUB_USERNAME/$REPO_NAME.git /opt/setup"; then
    log "ERROR: Failed to clone repository from GitHub"
    exit 1
  fi
fi

# Ensure runtime pulls for /opt/setup always use the credential helper
if [[ -d "/opt/setup/.git" ]]; then
  sudo -u minecraft git -C /opt/setup config credential.helper "$CREDENTIAL_HELPER_FILE"
fi
unset GITHUB_TOKEN

if [[ ! -d "/opt/setup" ]]; then
  log "/opt/setup not present after clone; aborting."
  exit 1
fi

# 8. Download Paper jar & accept EULA
PAPER_BUILD="${PAPER_BUILD:-$PAPER_BUILD_DEFAULT}"
log "Resolving Paper build for ${MC_VERSION} (default ${PAPER_BUILD})..."
LATEST_PAPER_BUILD="$(curl -fsSL "https://api.papermc.io/v2/projects/paper/versions/${MC_VERSION}" \
  | python3 -c 'import sys,json; j=json.load(sys.stdin); builds=j.get("builds",[]); print(builds[-1] if builds else "")' \
  || true)"
if [[ -n "$LATEST_PAPER_BUILD" ]]; then
  PAPER_BUILD="$LATEST_PAPER_BUILD"
fi
PAPER_URL="https://api.papermc.io/v2/projects/paper/versions/${MC_VERSION}/builds/${PAPER_BUILD}/downloads/paper-${MC_VERSION}-${PAPER_BUILD}.jar"
log "Using Paper jar: ${MC_VERSION} build ${PAPER_BUILD}"

if [[ ! -f "/opt/minecraft/server/paper.jar" ]]; then
  sudo -u minecraft bash -c "cd /opt/minecraft/server && wget \"${PAPER_URL}\" -O paper.jar"
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
  if [[ -f /opt/setup/infra/src/ec2/minecraft.service ]]; then
    cp /opt/setup/infra/src/ec2/minecraft.service /etc/systemd/system/
  else
    log "Error: minecraft.service unit file missing in /opt/setup/infra/src/ec2; aborting."
    exit 1
  fi
fi

# 11 Copy idle-check script and schedule cron
if [[ -f /opt/setup/infra/src/ec2/check-mc-idle.sh ]]; then
  cp /opt/setup/infra/src/ec2/check-mc-idle.sh /usr/local/bin/check-mc-idle.sh
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

# 12. Deploy management scripts (backup, restore, hibernate, resume)
for script in mc-backup.sh mc-restore.sh mc-hibernate.sh mc-resume.sh; do
  if [[ -f /opt/setup/infra/src/ec2/$script ]]; then
    cp /opt/setup/infra/src/ec2/$script /usr/local/bin/$script
    chmod +x /usr/local/bin/$script
    log "Deployed $script"
  fi
done

# 12.5. Deploy DNS update service
log "Installing DNS update service..."
if [[ -f /opt/setup/infra/src/ec2/update-dns.sh ]]; then
  cp /opt/setup/infra/src/ec2/update-dns.sh /usr/local/bin/update-dns.sh
  chmod +x /usr/local/bin/update-dns.sh
  log "Deployed update-dns.sh"
else
  log "Warning: update-dns.sh missing; DNS auto-update will not work."
fi

if [[ -f /opt/setup/infra/src/ec2/minecraft-dns.service ]]; then
  cp /opt/setup/infra/src/ec2/minecraft-dns.service /etc/systemd/system/
  log "Deployed minecraft-dns.service"
else
  log "Warning: minecraft-dns.service missing; DNS auto-update will not work."
fi

# 13. Enable & start the Minecraft service
systemctl daemon-reload
# Enable DNS service (will auto-start on subsequent boots)
systemctl enable minecraft-dns.service
# Start DNS service now (updates DNS for initial boot)
systemctl start minecraft-dns.service
systemctl enable minecraft.service
if ! systemctl is-active --quiet minecraft.service; then
  systemctl start minecraft.service
fi
