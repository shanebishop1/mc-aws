#!/usr/bin/env bash
set -euo pipefail

DNS_MODE="${1:-raw_ip}"
DNS_HOSTNAME="${2:-}"
EXPECTED_IP="${3:-}"
TIMEOUT_SECONDS="${MC_READY_TIMEOUT_SECONDS:-120}"
POLL_SECONDS="${MC_READY_POLL_SECONDS:-5}"
DNS_GRACE_SECONDS="${MC_DNS_GRACE_SECONDS:-15}"
MCSTATUS_BIN="${MCSTATUS_BIN:-/usr/local/bin/mcstatus}"
BOOTSTRAP_MARKER="${MC_BOOTSTRAP_MARKER:-/var/lib/mc-aws/bootstrap-complete}"

if [[ ! "$TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ || ! "$POLL_SECONDS" =~ ^[1-9][0-9]*$ || ! "$DNS_GRACE_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "ERROR: readiness timeout and poll interval must be positive integers" >&2
  exit 2
fi
if [[ "$DNS_MODE" != "raw_ip" && "$DNS_MODE" != "none" && -z "$DNS_HOSTNAME" ]]; then
  echo "ERROR: DNS hostname is required when DNS mode is enabled" >&2
  exit 2
fi

deadline=$((SECONDS + TIMEOUT_SECONDS))
game_ready=0
while (( SECONDS < deadline )); do
  bootstrap_ready=0
  service_ready=0
  protocol_ready=0

  [[ -f "$BOOTSTRAP_MARKER" ]] && bootstrap_ready=1
  systemctl is-active --quiet minecraft.service && service_ready=1
  "$MCSTATUS_BIN" localhost status >/dev/null 2>&1 && protocol_ready=1

  if (( bootstrap_ready == 1 && service_ready == 1 && protocol_ready == 1 )); then
    game_ready=1
    break
  fi
  sleep "$POLL_SECONDS"
done

if (( game_ready != 1 )); then
  echo "ERROR: Minecraft service/protocol readiness did not complete within ${TIMEOUT_SECONDS}s" >&2
  exit 1
fi

dns_ready=0
if [[ "$DNS_MODE" == "raw_ip" || "$DNS_MODE" == "none" ]]; then
  dns_ready=1
else
  dns_deadline=$((SECONDS + DNS_GRACE_SECONDS))
  while (( SECONDS <= dns_deadline )); do
    if [[ -n "$EXPECTED_IP" ]] && getent ahostsv4 "$DNS_HOSTNAME" | awk '{print $1}' | grep -Fxq "$EXPECTED_IP"; then
      dns_ready=1
      break
    fi
    (( SECONDS >= dns_deadline )) && break
    sleep "$POLL_SECONDS"
  done
fi

if (( dns_ready == 1 )); then
  printf '{"ready":true,"dnsReady":true,"dnsMode":"%s","hostname":"%s","publicIp":"%s"}\n' "$DNS_MODE" "$DNS_HOSTNAME" "$EXPECTED_IP"
else
  printf '{"ready":true,"dnsReady":false,"dnsWarning":"recursive DNS propagation is still pending","dnsMode":"%s","hostname":"%s","publicIp":"%s"}\n' "$DNS_MODE" "$DNS_HOSTNAME" "$EXPECTED_IP"
fi
