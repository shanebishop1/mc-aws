#!/usr/bin/env bash
set -euo pipefail

IDLE_MARKER=/tmp/mc-idle.marker
THRESHOLD=$((15 * 60))   # 15 mins

# 1. Query player count
PLAYERS=$(mcstatus localhost status \
  | awk '/players online:/ { print $3 }' | tr -d ',')

# 2. If any players are online, remove marker and exit
if (( PLAYERS > 0 )); then
  rm -f "$IDLE_MARKER"
  exit 0
fi

# 3. No players online:
#    a) If marker doesn't exist, create it and exit
if [[ ! -f "$IDLE_MARKER" ]]; then
  touch "$IDLE_MARKER"
  exit 0
fi

#    b) Marker exists—check its age
NOW=$(date +%s)
IDLE_TS=$(stat -c %Y "$IDLE_MARKER")
ELAPSED=$(( NOW - IDLE_TS ))

if (( ELAPSED > THRESHOLD )); then
  echo "$(date): No players for $(( THRESHOLD/60 ))m, shutting down…" >> /var/log/mc-idle.log

  # Gracefully stop Minecraft
  systemctl stop minecraft.service

  # Wait up to 2m for it to exit
  for i in {1..24}; do
    if ! systemctl is-active --quiet minecraft.service; then
      break
    fi
    sleep 5
  done

  echo "$(date): Minecraft stopped; halting EC2 instance" >> /var/log/mc-idle.log

  # Stop the EC2 instance
  INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)
  aws ec2 stop-instances --instance-ids "$INSTANCE_ID"
fi
