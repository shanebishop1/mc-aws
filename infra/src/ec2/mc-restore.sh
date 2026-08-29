#!/usr/bin/env bash
# Restore Minecraft server from Google Drive
# Usage: mc-restore.sh <latest|backup-archive>

set -euo pipefail
umask 077

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }

export RCLONE_CONFIG="${RCLONE_CONFIG:-/opt/setup/rclone/rclone.conf}"
RCLONE_CONFIG_HELPER="${MC_RCLONE_CONFIG_HELPER:-/usr/local/bin/mc-rclone-config.sh}"
PROFILE_INSTALLER="${MC_PROFILE_INSTALLER:-/usr/local/bin/mc-profile-install.sh}"

OPERATION_LOCK="${MC_OPERATION_LOCK:-/tmp/mc-operation.lock}"
MAINTENANCE_LOCK="${MC_MAINTENANCE_LOCK:-/tmp/mc-maintenance.lock}"
HIBERNATE_GUARD="${MC_HIBERNATE_GUARD:-/tmp/mc-hibernate-in-progress}"
BOOT_ID_FILE="${MC_BOOT_ID_FILE:-/proc/sys/kernel/random/boot_id}"
TEMP_DIR=""
MAINTENANCE_LOCK_OWNED=0
PRESERVE_TEMP=0
MUTATION_STARTED=0
RESTORE_SUCCEEDED=0
ROLLBACK_ATTEMPTED=0
FAILURE_CONTEXT="unexpected restore failure"
HAD_PREVIOUS=0
PREVIOUS_LOCATION=""
FAILED_SERVER=""
RETAINED_BACKUP=""
RESTORE_JOURNAL=""
MCSTATUS_BIN=""

cleanup() {
  if [[ "$MAINTENANCE_LOCK_OWNED" == "1" ]]; then
    rm -f -- "$MAINTENANCE_LOCK"
  fi
  if [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" ]]; then
    if [[ "$PRESERVE_TEMP" == "1" ]]; then
      log "CRITICAL: Preserving restore state for manual recovery: $TEMP_DIR"
    else
      rm -rf -- "$TEMP_DIR"
    fi
  fi
}

handle_exit() {
  local exit_code=$?
  trap - EXIT HUP INT TERM

  if [[ "$MUTATION_STARTED" == "1" && "$RESTORE_SUCCEEDED" != "1" && "$ROLLBACK_ATTEMPTED" != "1" ]]; then
    recover_previous_state "$FAILURE_CONTEXT" || exit_code=1
  fi
  cleanup
  exit "$exit_code"
}

# Hold the same crash-safe advisory lock used by backup and hibernate mode.
if ! command -v flock >/dev/null 2>&1; then
  log "ERROR: flock is required for lifecycle operation serialization"
  exit 1
fi
exec 9>"$OPERATION_LOCK"
if ! flock -n 9; then
  log "ERROR: Another backup, restore, or hibernate operation is in progress"
  exit 1
fi
trap handle_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

CURRENT_BOOT_ID="$(cat "$BOOT_ID_FILE" 2>/dev/null || true)"
if [[ -e "$HIBERNATE_GUARD" ]]; then
  IFS= read -r GUARD_BOOT_ID < "$HIBERNATE_GUARD" || true
  if [[ -z "$CURRENT_BOOT_ID" || "$GUARD_BOOT_ID" != "$CURRENT_BOOT_ID" ]]; then
    log "Removing stale hibernate guard from a previous boot"
    rm -f -- "$HIBERNATE_GUARD"
  fi
fi

if [[ -e "$HIBERNATE_GUARD" ]]; then
  log "ERROR: Hibernate is in progress; refusing to restore server state"
  exit 1
fi

# Do not remove a maintenance lock created by mc-resume.sh or another caller.
if [[ ! -e "$MAINTENANCE_LOCK" ]]; then
  touch "$MAINTENANCE_LOCK"
  MAINTENANCE_LOCK_OWNED=1
fi

SERVER_DIR="${MC_SERVER_DIR:-/opt/minecraft/server}"
SERVER_PARENT="$(dirname -- "$SERVER_DIR")"
SERVER_OWNER="${MC_SERVER_OWNER:-minecraft:minecraft}"
HEALTH_DELAY="${MC_RESTORE_HEALTH_DELAY:-3}"
MCSTATUS_BIN="${MC_STATUS_BIN:-/usr/local/bin/mcstatus}"
PROTOCOL_MAX_ATTEMPTS="${MC_RESTORE_PROTOCOL_MAX_ATTEMPTS:-12}"
PROTOCOL_POLL_INTERVAL="${MC_RESTORE_PROTOCOL_POLL_INTERVAL:-5}"
BACKUP_RETENTION="${MC_RESTORE_BACKUP_RETENTION:-2}"
STAGING_PARENT="${MC_RESTORE_STAGING_PARENT:-/opt}"
STAGING_PARENT_OVERRIDDEN=0
if [[ -n "${MC_RESTORE_STAGING_PARENT+x}" ]]; then
  STAGING_PARENT_OVERRIDDEN=1
fi

if [[ "$(basename -- "$SERVER_DIR")" != "server" || ! -d "$SERVER_PARENT" ]]; then
  log "ERROR: Server directory must be an existing parent with a server child: $SERVER_DIR"
  exit 1
fi
if [[ ! "$BACKUP_RETENTION" =~ ^[1-9][0-9]*$ ]]; then
  log "ERROR: MC_RESTORE_BACKUP_RETENTION must be a positive integer"
  exit 1
fi
if [[ ! "$PROTOCOL_MAX_ATTEMPTS" =~ ^[1-9][0-9]*$ ]]; then
  log "ERROR: MC_RESTORE_PROTOCOL_MAX_ATTEMPTS must be a positive integer"
  exit 1
fi
RESTORE_JOURNAL="${MC_RESTORE_JOURNAL:-/var/lib/mc-aws/mc-restore-journal.json}"
if [[ ! -d "$(dirname -- "$RESTORE_JOURNAL")" ]]; then
  log "ERROR: Restore journal parent does not exist"
  exit 1
fi

if ! python3 - "$STAGING_PARENT" "$SERVER_PARENT" "$STAGING_PARENT_OVERRIDDEN" <<'PY'
import os
import stat
import sys

staging_parent, server_parent, overridden = sys.argv[1:]
try:
    staging_lstat = os.lstat(staging_parent)
    server_stat = os.stat(server_parent)
except OSError as error:
    print(f"Could not inspect restore filesystem: {error}", file=sys.stderr)
    sys.exit(1)

if not stat.S_ISDIR(staging_lstat.st_mode):
    print("Restore staging parent must be a real directory", file=sys.stderr)
    sys.exit(1)
if overridden != "1" and staging_lstat.st_uid != 0:
    print("Default restore staging parent must be owned by root", file=sys.stderr)
    sys.exit(1)
if staging_lstat.st_dev != server_stat.st_dev:
    print("Restore staging and server paths must be on the same filesystem", file=sys.stderr)
    sys.exit(1)
PY
then
  log "ERROR: Restore staging parent is not safe for atomic installation: $STAGING_PARENT"
  exit 1
fi

write_restore_journal() {
  local phase="$1"
  local retained="${2:-}"
  python3 - "$RESTORE_JOURNAL" "$phase" "$SERVER_DIR" "$TEMP_DIR" "$PREVIOUS_LOCATION" "$FAILED_SERVER" "$HAD_PREVIOUS" "$retained" <<'PY'
import json
import os
import sys

journal, phase, server, temp, previous, failed, had_previous, retained = sys.argv[1:]
payload = {
    "version": 1,
    "phase": phase,
    "serverDir": server,
    "tempDir": temp,
    "previousLocation": previous,
    "failedServer": failed,
    "hadPrevious": had_previous == "1",
    "retainedBackup": retained or None,
}
temporary = f"{journal}.new"
with open(temporary, "w", encoding="utf-8") as output:
    json.dump(payload, output, separators=(",", ":"))
    output.flush()
    os.fsync(output.fileno())
os.replace(temporary, journal)
directory = os.open(os.path.dirname(journal), os.O_RDONLY)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
}

clear_restore_journal() {
  python3 - "$RESTORE_JOURNAL" <<'PY'
import os
import sys

journal = sys.argv[1]
try:
    os.unlink(journal)
except FileNotFoundError:
    pass
directory = os.open(os.path.dirname(journal), os.O_RDONLY)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
}

fsync_restore_directories() {
  python3 - "$SERVER_PARENT" "$STAGING_PARENT" "$TEMP_DIR" <<'PY'
import os
import sys

for candidate in dict.fromkeys(sys.argv[1:]):
    if not candidate or not os.path.isdir(candidate):
        continue
    descriptor = os.open(candidate, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
PY
}

verify_minecraft_protocol() {
  local attempt
  for ((attempt = 1; attempt <= PROTOCOL_MAX_ATTEMPTS; attempt++)); do
    if systemctl is-active --quiet minecraft && "$MCSTATUS_BIN" localhost status >/dev/null 2>&1; then
      return 0
    fi
    if (( attempt < PROTOCOL_MAX_ATTEMPTS )); then
      sleep "$PROTOCOL_POLL_INTERVAL"
    fi
  done
  return 1
}

cleanup_recovered_staging() {
  python3 - "$RESTORE_JOURNAL" "$STAGING_PARENT" <<'PY'
import json
import os
import shutil
import sys
from pathlib import Path

journal_path, staging_parent = map(Path, sys.argv[1:])
journal = json.loads(journal_path.read_text(encoding="utf-8"))
temp = Path(journal.get("tempDir", ""))
if journal.get("version") != 1 or journal.get("phase") != "recovered" or temp.parent != staging_parent:
    raise ValueError("recovered journal staging identity is invalid")
if temp.exists():
    shutil.rmtree(temp)
descriptor = os.open(staging_parent, os.O_RDONLY)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
}

recover_interrupted_swap() {
  [[ -f "$RESTORE_JOURNAL" ]] || return 0
  log "Recovering interrupted restore directory swap"
  local recovery_result
  if ! recovery_result="$(python3 - "$RESTORE_JOURNAL" "$SERVER_DIR" "$SERVER_PARENT" "$STAGING_PARENT" <<'PY'
import json
import os
import shutil
import sys
from pathlib import Path

journal_path, expected_server, expected_parent, staging_parent = map(Path, sys.argv[1:])
try:
    journal = json.loads(journal_path.read_text(encoding="utf-8"))
    if journal.get("version") != 1 or Path(journal.get("serverDir", "")) != expected_server:
        raise ValueError("journal identity does not match the configured server")
    temp = Path(journal.get("tempDir", ""))
    previous = Path(journal.get("previousLocation", ""))
    retained_raw = journal.get("retainedBackup")
    retained = Path(retained_raw) if retained_raw else None
    if temp.parent != staging_parent or previous.parent != temp:
        raise ValueError("journal paths are outside the restore filesystem")
    if retained is not None and retained.parent != expected_parent:
        raise ValueError("journal retained backup is outside the server parent")
    had_previous = journal.get("hadPrevious") is True
    rollback = previous if previous.exists() else retained if retained is not None and retained.exists() else None
    if had_previous and rollback is not None:
        if expected_server.exists() or expected_server.is_symlink():
            failed = temp / "crash-failed-server"
            if failed.exists() or failed.is_symlink():
                shutil.rmtree(failed) if failed.is_dir() and not failed.is_symlink() else failed.unlink()
            os.rename(expected_server, failed)
        os.rename(rollback, expected_server)
    elif had_previous and not (expected_server.exists() or expected_server.is_symlink()):
        raise ValueError("both the active and previous server directories are missing")
    elif not had_previous and journal.get("phase") not in ("prepared", "service-stopped"):
        if expected_server.exists() or expected_server.is_symlink():
            failed = temp / "crash-failed-server"
            os.rename(expected_server, failed)
    for directory_path in {expected_parent, staging_parent, temp}:
        if directory_path.is_dir():
            descriptor = os.open(directory_path, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    journal["phase"] = "recovered"
    temporary = journal_path.with_name(journal_path.name + ".new")
    with temporary.open("w", encoding="utf-8") as output:
        json.dump(journal, output, separators=(",", ":"))
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, journal_path)
    print("restart" if expected_server.exists() else "none")
except (OSError, ValueError, json.JSONDecodeError, TypeError) as error:
    print(f"Interrupted restore recovery failed: {error}", file=sys.stderr)
    sys.exit(1)
PY
)"; then
    log "CRITICAL: Interrupted restore journal could not be recovered"
    exit 1
  fi
  if [[ "$recovery_result" == "restart" ]]; then
    systemctl stop minecraft || true
    if ! systemctl start minecraft || ! verify_minecraft_protocol; then
      log "CRITICAL: Recovered server directory did not become protocol-ready"
      exit 1
    fi
  fi
  if ! cleanup_recovered_staging; then
    log "CRITICAL: Recovered restore staging tree could not be cleaned"
    exit 1
  fi
  clear_restore_journal
  log "Interrupted restore recovery completed"
}

recover_interrupted_swap

# Recover local state before reading or materializing any Drive configuration.
GDRIVE_REMOTE_FILE="${MC_RCLONE_REMOTE_FILE:-/etc/minecraft/gdrive-remote}"
if [[ -z "${GDRIVE_REMOTE:-}" && -r "$GDRIVE_REMOTE_FILE" ]]; then
  IFS= read -r GDRIVE_REMOTE < "$GDRIVE_REMOTE_FILE" || true
fi
GDRIVE_ROOT_FILE="${MC_RCLONE_ROOT_FILE:-/etc/minecraft/gdrive-root}"
if [[ -z "${GDRIVE_ROOT:-}" && -r "$GDRIVE_ROOT_FILE" ]]; then
  IFS= read -r GDRIVE_ROOT < "$GDRIVE_ROOT_FILE" || true
fi
GDRIVE_REMOTE="${GDRIVE_REMOTE:-gdrive}"
GDRIVE_ROOT="${GDRIVE_ROOT:-mc-backups}"
if ! "$RCLONE_CONFIG_HELPER"; then
  log "ERROR: Failed to materialize Google Drive configuration"
  exit 1
fi

BACKUP_REF="${1:-latest}"
if [[ "$BACKUP_REF" == "latest" ]]; then
  log "Latest backup requested, finding latest backup file..."
  if ! BACKUP_LIST="$(rclone lsf "${GDRIVE_REMOTE}:${GDRIVE_ROOT}/" --sort time --reverse --files-only)"; then
    log "ERROR: Failed to list backups in ${GDRIVE_REMOTE}:${GDRIVE_ROOT}/"
    exit 1
  fi

  BACKUP_FILE=""
  while IFS= read -r candidate; do
    case "$candidate" in
      *.tar.gz|*.gz)
        BACKUP_FILE="$candidate"
        break
        ;;
    esac
  done <<< "$BACKUP_LIST"

  if [[ -z "$BACKUP_FILE" ]]; then
    log "ERROR: No backups found in ${GDRIVE_REMOTE}:${GDRIVE_ROOT}/"
    exit 1
  fi
  log "Found latest backup: $BACKUP_FILE"
else
  # Backwards compatibility: a stem resolves to .tar.gz; both archive suffixes remain accepted.
  if [[ "$BACKUP_REF" =~ \.(tar\.gz|gz)$ ]]; then
    BACKUP_FILE="$BACKUP_REF"
  else
    BACKUP_FILE="${BACKUP_REF}.tar.gz"
  fi
fi

# Match the archive-name contract enforced by the Lambda before constructing local or remote paths.
if [[ ! "$BACKUP_FILE" =~ ^[A-Za-z0-9._-]+\.(tar\.gz|gz)$ ]]; then
  log "ERROR: Invalid backup filename: $BACKUP_FILE"
  exit 1
fi

log "Starting restore from: $BACKUP_FILE"

# The default /opt parent is root-owned; the device check above guarantees atomic renames to SERVER_DIR.
TEMP_DIR="$(mktemp -d "${STAGING_PARENT}/.mc-restore.XXXXXX")"
DOWNLOAD_DIR="${TEMP_DIR}/download"
EXTRACT_DIR="${TEMP_DIR}/extract"
mkdir -- "$DOWNLOAD_DIR" "$EXTRACT_DIR"
ARCHIVE_PATH="${DOWNLOAD_DIR}/${BACKUP_FILE}"
STAGED_SERVER="${EXTRACT_DIR}/server"
FAILED_SERVER="${TEMP_DIR}/failed-server"
PREVIOUS_LOCATION="${TEMP_DIR}/previous-server"

log "Downloading backup from Google Drive..."
if ! rclone copy "${GDRIVE_REMOTE}:${GDRIVE_ROOT}/${BACKUP_FILE}" "$DOWNLOAD_DIR/"; then
  log "ERROR: Failed to download from Google Drive"
  exit 1
fi
if [[ ! -f "$ARCHIVE_PATH" || -L "$ARCHIVE_PATH" ]]; then
  log "ERROR: Download did not produce the expected archive"
  exit 1
fi

log "Validating and extracting backup into staging..."
if ! python3 - "$ARCHIVE_PATH" "$EXTRACT_DIR" <<'PY'
import os
import shutil
import sys
import tarfile
from pathlib import Path

archive_path = Path(sys.argv[1])
extract_root = Path(sys.argv[2])


def fail(message: str) -> None:
    raise ValueError(message)


try:
    with tarfile.open(archive_path, mode="r:gz") as archive:
        members = archive.getmembers()
        seen: set[tuple[str, ...]] = set()
        regular_file_count = 0
        regular_file_bytes = 0

        for member in members:
            name = member.name
            normalized = name[:-1] if name.endswith("/") else name
            if not normalized or normalized.startswith("/"):
                fail(f"unsafe archive path: {name!r}")

            parts = tuple(normalized.split("/"))
            if any(part in ("", ".", "..") for part in parts):
                fail(f"unsafe archive path: {name!r}")
            if parts[0] != "server":
                fail(f"archive entry is outside the server root: {name!r}")
            if not (member.isdir() or member.isfile()):
                fail(f"unsupported archive entry type: {name!r}")
            if member.isfile():
                regular_file_count += 1
                regular_file_bytes += member.size
            if parts == ("server",) and not member.isdir():
                fail("archive server root is not a directory")
            if parts in seen:
                fail(f"duplicate archive entry: {name!r}")
            seen.add(parts)

        if not members:
            fail("archive is empty")
        if regular_file_count == 0:
            fail("archive contains no server files")
        available_bytes = shutil.disk_usage(extract_root).free
        reserve_bytes = min(64 * 1024 * 1024, available_bytes // 10)
        if regular_file_bytes > available_bytes - reserve_bytes:
            fail("archive contents exceed available staging space")

        directory_modes: list[tuple[Path, int]] = []
        for member in members:
            normalized = member.name[:-1] if member.name.endswith("/") else member.name
            parts = tuple(normalized.split("/"))
            destination = extract_root.joinpath(*parts)

            if member.isdir():
                destination.mkdir(parents=True, exist_ok=True)
                directory_modes.append((destination, member.mode & 0o777))
                continue

            destination.parent.mkdir(parents=True, exist_ok=True)
            source = archive.extractfile(member)
            if source is None:
                fail(f"could not read archive entry: {member.name!r}")
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
            if hasattr(os, "O_NOFOLLOW"):
                flags |= os.O_NOFOLLOW
            descriptor = os.open(destination, flags, member.mode & 0o777)
            with source, os.fdopen(descriptor, "wb") as output:
                shutil.copyfileobj(source, output)
                os.fchmod(output.fileno(), member.mode & 0o777)

        for directory, mode in reversed(directory_modes):
            directory.chmod(mode)

    server_root = extract_root / "server"
    if not server_root.is_dir() or server_root.is_symlink():
        fail("archive does not contain a server directory root")
except (OSError, tarfile.TarError, ValueError) as error:
    print(f"Archive validation/extraction failed: {error}", file=sys.stderr)
    sys.exit(1)
PY
then
  log "ERROR: Backup archive failed validation or extraction"
  exit 1
fi

log "Setting staged server permissions..."
if ! chown -R "$SERVER_OWNER" "$STAGED_SERVER"; then
  log "ERROR: Failed to set staged server permissions"
  exit 1
fi

recover_previous_state() {
  local context="$1"
  local recovery_failed=0
  local rollback_source="$PREVIOUS_LOCATION"

  ROLLBACK_ATTEMPTED=1
  log "Rolling back restore after ${context}..."
  systemctl stop minecraft || log "Warning: Failed to stop minecraft service during rollback"

  if [[ "$HAD_PREVIOUS" == "1" ]]; then
    if [[ ! -e "$rollback_source" && ! -L "$rollback_source" && -n "$RETAINED_BACKUP" ]]; then
      rollback_source="$RETAINED_BACKUP"
    fi
    if [[ -e "$rollback_source" || -L "$rollback_source" ]]; then
      if [[ -e "$SERVER_DIR" || -L "$SERVER_DIR" ]]; then
        if ! mv -- "$SERVER_DIR" "$FAILED_SERVER"; then
          log "CRITICAL: Could not move failed restore out of the server path"
          recovery_failed=1
        fi
      fi
      if [[ "$recovery_failed" == "0" ]] && ! mv -- "$rollback_source" "$SERVER_DIR"; then
        log "CRITICAL: Could not restore the previous server directory"
        recovery_failed=1
      fi
    elif [[ ! -e "$SERVER_DIR" && ! -L "$SERVER_DIR" ]]; then
      log "CRITICAL: Previous server directory is missing during rollback"
      recovery_failed=1
    fi
  elif [[ -e "$SERVER_DIR" || -L "$SERVER_DIR" ]]; then
    if ! mv -- "$SERVER_DIR" "$FAILED_SERVER"; then
      log "CRITICAL: Could not remove failed restore from an initially empty server path"
      recovery_failed=1
    fi
  fi

  if [[ "$HAD_PREVIOUS" == "1" && "$recovery_failed" == "0" ]]; then
    if ! systemctl start minecraft; then
      log "CRITICAL: Previous server directory restored, but minecraft failed to start"
      recovery_failed=1
    elif ! sleep "$HEALTH_DELAY" || ! verify_minecraft_protocol; then
      log "CRITICAL: Previous server restart did not pass protocol readiness"
      systemctl status minecraft --no-pager -l || true
      recovery_failed=1
    fi
  fi

  if [[ "$recovery_failed" == "1" ]]; then
    PRESERVE_TEMP=1
    return 1
  fi
  fsync_restore_directories
  log "Previous server state restored"
  clear_restore_journal
}

validate_staged_server() {
  python3 - "$STAGED_SERVER" <<'PY'
import os
import stat
import sys

root = sys.argv[1]
try:
    root_stat = os.lstat(root)
    if not stat.S_ISDIR(root_stat.st_mode):
        raise ValueError("staged server root is not a directory")
    for current_root, directories, files in os.walk(root, followlinks=False):
        for name in directories + files:
            path = os.path.join(current_root, name)
            entry_stat = os.lstat(path)
            if stat.S_ISDIR(entry_stat.st_mode):
                continue
            if not stat.S_ISREG(entry_stat.st_mode):
                raise ValueError(f"unsupported staged entry type: {path}")
            if entry_stat.st_nlink != 1:
                raise ValueError(f"hard-linked staged file: {path}")
except (OSError, ValueError) as error:
    print(f"Staged server validation failed: {error}", file=sys.stderr)
    sys.exit(1)
PY
}

prune_retained_backups() {
  local protected_backup="${1:-}"
  python3 - "$SERVER_PARENT" "$BACKUP_RETENTION" "$protected_backup" <<'PY'
import shutil
import sys
from pathlib import Path

parent = Path(sys.argv[1])
retention = int(sys.argv[2])
protected = Path(sys.argv[3]) if sys.argv[3] else None
backups = sorted(
    (entry for entry in parent.iterdir() if entry.name.startswith("server.backup-") and entry.is_dir() and not entry.is_symlink()),
    key=lambda entry: entry.name,
    reverse=True,
)
retained = []
if protected is not None and protected in backups:
    retained.append(protected)
retained.extend(entry for entry in backups if entry != protected)
for expired in retained[retention:]:
    shutil.rmtree(expired)
PY
}

# Nothing above this point interrupts the running server.
if [[ -e "$SERVER_DIR" || -L "$SERVER_DIR" ]]; then
  HAD_PREVIOUS=1
fi
MUTATION_STARTED=1
FAILURE_CONTEXT="service stop or pre-install failure"
write_restore_journal "prepared"
log "Stopping Minecraft server..."
if ! systemctl stop minecraft; then
  log "ERROR: Failed to stop minecraft service; restore not installed"
  exit 1
fi
write_restore_journal "service-stopped"

FAILURE_CONTEXT="final staged-server validation failure"
if ! validate_staged_server; then
  log "ERROR: Staged server changed or failed validation before install"
  exit 1
fi

log "Installing staged server directory..."
if [[ "$HAD_PREVIOUS" == "1" ]]; then
  FAILURE_CONTEXT="current-server rename failure"
  write_restore_journal "moving-previous"
  if ! mv -- "$SERVER_DIR" "$PREVIOUS_LOCATION"; then
    log "ERROR: Failed to move current server directory; restore not installed"
    exit 1
  fi
  fsync_restore_directories
  write_restore_journal "previous-moved"
fi

FAILURE_CONTEXT="staged-server install failure"
write_restore_journal "installing"
if ! mv -- "$STAGED_SERVER" "$SERVER_DIR"; then
  log "ERROR: Failed to install staged server directory"
  exit 1
fi
fsync_restore_directories
write_restore_journal "installed"

FAILURE_CONTEXT="server-profile reapplication failure"
log "Applying current server profile to restored world..."
if ! "$PROFILE_INSTALLER" --bootstrap; then
  log "ERROR: Failed to apply the current server profile after restore"
  exit 1
fi

FAILURE_CONTEXT="restored-server start failure"
log "Starting Minecraft server..."
if ! systemctl start minecraft; then
  log "ERROR: Failed to start minecraft service"
  exit 1
fi

FAILURE_CONTEXT="restored-server protocol readiness failure"
sleep "$HEALTH_DELAY"
if ! verify_minecraft_protocol; then
  log "ERROR: Minecraft did not pass protocol readiness after restore"
  systemctl status minecraft --no-pager -l || true
  exit 1
fi
write_restore_journal "ready"

if [[ "$HAD_PREVIOUS" == "1" ]]; then
  RETAINED_BACKUP_BASE="${SERVER_DIR}.backup-$(date +%Y%m%d-%H%M%S)"
  RETAINED_BACKUP="$RETAINED_BACKUP_BASE"
  suffix=0
  while [[ -e "$RETAINED_BACKUP" || -L "$RETAINED_BACKUP" ]]; do
    suffix=$((suffix + 1))
    RETAINED_BACKUP="${RETAINED_BACKUP_BASE}-${suffix}"
  done
  FAILURE_CONTEXT="successful-backup retention failure"
  write_restore_journal "retention-planned" "$RETAINED_BACKUP"
  if ! mv -- "$PREVIOUS_LOCATION" "$RETAINED_BACKUP"; then
    log "ERROR: Failed to retain the previous successful server directory"
    exit 1
  fi
  fsync_restore_directories
  PREVIOUS_LOCATION="$RETAINED_BACKUP"
  write_restore_journal "retained" "$RETAINED_BACKUP"
fi

FAILURE_CONTEXT="retained-backup pruning failure"
if ! prune_retained_backups "$PREVIOUS_LOCATION"; then
  log "ERROR: Failed to prune retained server backups"
  exit 1
fi

clear_restore_journal
RESTORE_SUCCEEDED=1
log "SUCCESS: Restored from ${BACKUP_FILE}"
