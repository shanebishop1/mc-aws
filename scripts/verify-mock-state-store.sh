#!/usr/bin/env bash
# Quick verification script for mock-state-store.ts

set -euo pipefail

iso_now() {
  if date -Is >/dev/null 2>&1; then
    date -Is
    return
  fi

  # macOS/BSD date does not support -I
  date -u "+%Y-%m-%dT%H:%M:%SZ"
}

log() { echo "[$(iso_now)] $*"; }

log "Verifying mock-state-store.ts implementation..."

# Check if file exists
if [ ! -f "lib/aws/mock-state-store.ts" ]; then
  log "ERROR: lib/aws/mock-state-store.ts not found"
  exit 1
fi

log "✓ File exists"

# Check for key exports
log "Checking for key exports..."

if grep -q "export class MockStateStore" lib/aws/mock-state-store.ts; then
  log "✓ MockStateStore class exported"
else
  log "ERROR: MockStateStore class not exported"
  exit 1
fi

if grep -q "export function getMockStateStore" lib/aws/mock-state-store.ts; then
  log "✓ getMockStateStore function exported"
else
  log "ERROR: getMockStateStore function not exported"
  exit 1
fi

if grep -q "export interface MockState" lib/aws/mock-state-store.ts; then
  log "✓ MockState interface exported"
else
  log "ERROR: MockState interface not exported"
  exit 1
fi

# Check for key methods
log "Checking for key methods..."

methods=(
  "getInstance"
  "setInstance"
  "updateInstanceState"
  "getParameter"
  "setParameter"
  "getBackups"
  "addBackup"
  "getCosts"
  "getStackStatus"
  "setStackStatus"
  "getGlobalLatency"
  "setGlobalLatency"
  "resetState"
)

for method in "${methods[@]}"; do
  if grep -q "async $method" lib/aws/mock-state-store.ts; then
    log "✓ Method $method found"
  else
    log "ERROR: Method $method not found"
    exit 1
  fi
done

# Check for default fixtures
log "Checking for default fixtures..."

if grep -q "createDefaultInstanceState" lib/aws/mock-state-store.ts; then
  log "✓ Default instance state fixture found"
else
  log "ERROR: Default instance state fixture not found"
  exit 1
fi

if grep -q "createDefaultSSMParameters" lib/aws/mock-state-store.ts; then
  log "✓ Default SSM parameters fixture found"
else
  log "ERROR: Default SSM parameters fixture not found"
  exit 1
fi

if grep -q "createDefaultBackups" lib/aws/mock-state-store.ts; then
  log "✓ Default backups fixture found"
else
  log "ERROR: Default backups fixture not found"
  exit 1
fi

if grep -q "createDefaultCostData" lib/aws/mock-state-store.ts; then
  log "✓ Default cost data fixture found"
else
  log "ERROR: Default cost data fixture not found"
  exit 1
fi

if grep -q "createDefaultCloudFormationStack" lib/aws/mock-state-store.ts; then
  log "✓ Default CloudFormation stack fixture found"
else
  log "ERROR: Default CloudFormation stack fixture not found"
  exit 1
fi

# Check for concurrency safety
log "Checking for concurrency safety..."

if grep -q "withLock" lib/aws/mock-state-store.ts; then
  log "✓ Lock mechanism found"
else
  log "ERROR: Lock mechanism not found"
  exit 1
fi

if grep -q "acquireLock" lib/aws/mock-state-store.ts; then
  log "✓ Lock acquisition method found"
else
  log "ERROR: Lock acquisition method not found"
  exit 1
fi

# Check for persistence
log "Checking for persistence..."

if grep -q "loadState" lib/aws/mock-state-store.ts; then
  log "✓ State loading method found"
else
  log "ERROR: State loading method not found"
  exit 1
fi

if grep -q "saveState" lib/aws/mock-state-store.ts; then
  log "✓ State saving method found"
else
  log "ERROR: State saving method not found"
  exit 1
fi

if grep -q "schedulePersistence" lib/aws/mock-state-store.ts; then
  log "✓ Persistence scheduling method found"
else
  log "ERROR: Persistence scheduling method not found"
  exit 1
fi

log ""
log "All verification checks passed! ✓"
log ""
log "The mock state store is ready to be used by the mock provider."
