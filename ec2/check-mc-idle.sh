#!/usr/bin/env bash

# 1. Query player count
PLAYERS=$(mcstatus localhost status --no-color \
  | awk '/players online:/ { print $3 }' | tr -d ',')

# 2. On any players, clear idle marker and exit
if [[ "$PLAYERS" -gt 0 ]]; then
  rm -f /tmp/mc-idle.marker
  exit 0
fi

# 3. Stamp marker if still zero
IDLE_MARKER=/tmp/mc-idle.marker
touch "$IDLE_MARKER"

# 4. If idle > 15m, gracefully stop server then EC2
NOW=$(date +%s)
IDLE_TS=$(stat -c %Y "$IDLE_MARKER")

if (( NOW - IDLE_TS > 900 )); then
  echo "$(date): No players for 15m, stopping Minecraft…" >> /var/log/mc-idle.log

  # a) Stop systemd service (graceful shutdown)
  systemctl stop minecraft.service

  # b) Wait up to 2m for it to exit
  for i in {1..24}; do
    if ! systemctl is-active --quiet minecraft.service; then
      break
    fi
    sleep 5
  done

  echo "$(date): Minecraft stopped; shutting down EC2" >> /var/log/mc-idle.log

  # c) Halt the instance
  INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)
  aws ec2 stop-instances --instance-ids "$INSTANCE_ID"
fi
