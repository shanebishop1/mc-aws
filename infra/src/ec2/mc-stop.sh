#!/usr/bin/env bash
# Send a graceful stop and remain in ExecStop until screen and Java have exited.
set -euo pipefail

/usr/bin/screen -S mc-server -p 0 -X stuff $'stop\r' || true

# systemd bounds this loop with minecraft.service TimeoutStopSec.
while /usr/bin/screen -list 2>/dev/null | grep -q '[.]mc-server' || /usr/bin/pgrep -u "$(id -u minecraft)" -x java >/dev/null; do
  sleep 1
done
