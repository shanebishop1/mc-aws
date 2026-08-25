#!/usr/bin/env bash
# Materialize the Google Drive rclone configuration from SSM.

set -euo pipefail
umask 077

log() { echo "[$(date -Is)] $*"; }

BOOTSTRAP_MODE=0
if (( $# > 1 )); then
  log "ERROR: Usage: mc-rclone-config.sh [--bootstrap]"
  exit 2
fi
if (( $# == 1 )); then
  if [[ "$1" != "--bootstrap" ]]; then
    log "ERROR: Usage: mc-rclone-config.sh [--bootstrap]"
    exit 2
  fi
  BOOTSTRAP_MODE=1
fi

AWS_CLI="${MC_RCLONE_AWS_CLI:-aws}"
TOKEN_PARAMETER="${MC_RCLONE_TOKEN_PARAMETER:-/minecraft/gdrive-token}"
CONFIG_PATH="${RCLONE_CONFIG:-${MC_RCLONE_CONFIG_PATH:-/opt/setup/rclone/rclone.conf}}"
REMOTE_FILE="${MC_RCLONE_REMOTE_FILE:-/etc/minecraft/gdrive-remote}"
CONFIG_OWNER="${MC_RCLONE_CONFIG_OWNER:-root}"
CONFIG_GROUP="${MC_RCLONE_CONFIG_GROUP:-root}"

REMOTE_NAME="${GDRIVE_REMOTE:-}"
if [[ -z "$REMOTE_NAME" && -r "$REMOTE_FILE" ]]; then
  IFS= read -r REMOTE_NAME < "$REMOTE_FILE" || true
fi
REMOTE_NAME="${REMOTE_NAME:-gdrive}"

# Keep the value safe both as an rclone INI section and as the remote prefix used by callers.
if [[ ! "$REMOTE_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
  log "ERROR: Invalid Google Drive remote name"
  exit 1
fi

TOKEN_JSON=""
if ! TOKEN_JSON="$("$AWS_CLI" ssm get-parameter \
  --name "$TOKEN_PARAMETER" \
  --with-decryption \
  --query Parameter.Value \
  --output text 2>/dev/null)" || [[ -z "$TOKEN_JSON" ]]; then
  unset TOKEN_JSON
  if (( BOOTSTRAP_MODE == 1 )); then
    log "Google Drive token is not available during bootstrap; skipping rclone configuration"
    exit 0
  fi
  log "ERROR: Could not retrieve the Google Drive token from SSM"
  exit 1
fi

# Validate the versioned credential envelope or the legacy bare token without printing secrets.
NORMALIZED_CREDENTIALS=""
if ! NORMALIZED_CREDENTIALS="$(printf '%s' "$TOKEN_JSON" | jq -ce '
  def valid_token:
    type == "object"
    and (.access_token | type == "string" and length > 0)
    and (.token_type | type == "string" and length > 0)
    and (.refresh_token | type == "string" and length > 0)
    and (.expiry | type == "string" and length > 0);
  if valid_token then
    {token: ., client_id: null, client_secret: null}
  elif type == "object"
    and .version == 1
    and (.token | valid_token)
    and (.client_id | type == "string" and length > 0)
    and (.client_secret | type == "string" and length > 0)
  then {token: .token, client_id: .client_id, client_secret: .client_secret}
  else error("invalid rclone credential envelope")
  end
' 2>/dev/null)"; then
  unset TOKEN_JSON NORMALIZED_CREDENTIALS
  log "ERROR: Google Drive token in SSM is not valid rclone token JSON"
  exit 1
fi
unset TOKEN_JSON

COMPACT_TOKEN="$(printf '%s' "$NORMALIZED_CREDENTIALS" | jq -ce '.token')"
CLIENT_ID="$(printf '%s' "$NORMALIZED_CREDENTIALS" | jq -r '.client_id // empty')"
CLIENT_SECRET="$(printf '%s' "$NORMALIZED_CREDENTIALS" | jq -r '.client_secret // empty')"
unset NORMALIZED_CREDENTIALS

if [[ "$CLIENT_ID" == *$'\n'* || "$CLIENT_ID" == *$'\r'* || "$CLIENT_SECRET" == *$'\n'* || "$CLIENT_SECRET" == *$'\r'* ]]; then
  unset COMPACT_TOKEN CLIENT_ID CLIENT_SECRET
  log "ERROR: Google Drive OAuth client credentials are invalid"
  exit 1
fi

CONFIG_DIR="$(dirname -- "$CONFIG_PATH")"
mkdir -p -- "$CONFIG_DIR"
chown "$CONFIG_OWNER:$CONFIG_GROUP" "$CONFIG_DIR"
chmod 0755 "$CONFIG_DIR"

TEMP_CONFIG="$(mktemp "${CONFIG_PATH}.tmp.XXXXXX")"
cleanup() {
  rm -f -- "$TEMP_CONFIG"
}
trap cleanup EXIT HUP INT TERM

printf '[%s]\ntype = drive\n' "$REMOTE_NAME" > "$TEMP_CONFIG"
if [[ -n "$CLIENT_ID" ]]; then
  printf 'client_id = %s\nclient_secret = %s\n' "$CLIENT_ID" "$CLIENT_SECRET" >> "$TEMP_CONFIG"
fi
printf 'token = %s\n' "$COMPACT_TOKEN" >> "$TEMP_CONFIG"
unset COMPACT_TOKEN CLIENT_ID CLIENT_SECRET
chown "$CONFIG_OWNER:$CONFIG_GROUP" "$TEMP_CONFIG"
chmod 0600 "$TEMP_CONFIG"
mv -f -- "$TEMP_CONFIG" "$CONFIG_PATH"
trap - EXIT HUP INT TERM

log "Materialized Google Drive rclone configuration"
