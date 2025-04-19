#!/usr/bin/env bash
echo "$(date +'%Y-%m-%d %H:%M:%S'): check-mc-idle.sh invoked" >> /var/log/mc-idle.log
set -euo pipefail

IDLE_MARKER=/tmp/mc-idle.marker
THRESHOLD=$((15 * 60))   # 15 mins

# 1. Query player count, handling connection errors
set +e # Disable exit on error temporarily
MC_OUTPUT=$(/usr/local/bin/mcstatus localhost status 2>&1) # Capture stdout and stderr
MC_EXIT_CODE=$?
set -e # Re-enable exit on error

PLAYERS=0 # Default to 0 players
if [[ $MC_EXIT_CODE -eq 0 ]]; then
  PLAYERS_LINE=$(echo "$MC_OUTPUT" | grep -i '^players:' || true)

  if [[ -n "$PLAYERS_LINE" ]]; then
    # 2) Extract the “0” from “0/20 …”
    PLAYERS=$(echo "$PLAYERS_LINE" | awk '{ print $2 }' | cut -d'/' -f1)
    echo "$(date): $PLAYERS players are online" \
      >> /var/log/mc-idle.log
  else
    echo "$(date): Warning – no players line in mcstatus output: $MC_OUTPUT" \
      >> /var/log/mc-idle.log
    PLAYERS=0
  fi

  # 3) Validate it really is a number
  if ! [[ "$PLAYERS" =~ ^[0-9]+$ ]]; then
    echo "$(date): Warning – failed to parse player count from mcstatus output: $MC_OUTPUT" \
      >> /var/log/mc-idle.log
    PLAYERS=0
  fi
else
  # For any other mcstatus error, log it and exit to avoid incorrect shutdown
  echo "$(date): Error - mcstatus failed with unexpected error (Exit Code: $MC_EXIT_CODE): $MC_OUTPUT" >> /var/log/mc-idle.log
  exit 1 # Exit the script to prevent potentially incorrect shutdown
fi


# 2. If any players are online, remove marker and exit
if (( PLAYERS > 0 )); then
  echo "$(date +'%Y-%m-%d %H:%M:%S'): Removing idle marker since players are online" >> /var/log/mc-idle.log
  rm -f "$IDLE_MARKER"
  exit 0
fi

# 3. No players online:
#    a) If marker doesn't exist, create it and exit
if [[ ! -f "$IDLE_MARKER" ]]; then
  echo "$(date +'%Y-%m-%d %H:%M:%S'): No players are online and no idle marker exists, so creating one" >> /var/log/mc-idle.log
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

  rm -f "$IDLE_MARKER"

  echo "$(date): Minecraft stopped; halting EC2 instance" >> /var/log/mc-idle.log

  # Stop the EC2 instance
  INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)
  aws ec2 stop-instances --instance-ids "$INSTANCE_ID"
fi
