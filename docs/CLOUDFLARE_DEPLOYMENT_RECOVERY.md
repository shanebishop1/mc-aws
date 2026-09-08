# Cloudflare deployment recovery

`pnpm deploy:cf` inventories the current Worker deployment and version split, route, managed panel DNS proxy state, secret names/types, non-secret bindings, and tagged AWS runtime IAM key IDs before changing Cloudflare. It writes an owned `0600` recovery record in the private state directory (outside Next/OpenNext cleanup paths):

```text
.mc-aws-state/cloudflare-deployment-recovery.json
```

Do not delete or edit an active record. Recovery is checked before ordinary environment/schema/build preflight. Before the durable commit decision, the next run validates identity and rolls back. After the replacement runtime key and complete Worker configuration verify, the record stores `decision=commit`; an interruption then resumes forward key cleanup instead of attempting an impossible old-version rollback. A completed record is finalized as `.last`.

Recovery redeploys the recorded immutable Worker version split, restores or removes the project-owned route, and restores the managed DNS proxy state (or removes the exact placeholder record created by this deploy). A Worker proven absent before deployment is deleted on rollback. Concurrent route/DNS state that no longer matches the recorded deployer-owned shape is preserved for manual review. Every record update writes a private temporary inode, fsyncs that inode, atomically renames it, and fsyncs the parent directory; final history moves use the same atomic-directory durability boundary. Phase and commit-decision updates are monotonic, so a power-loss interruption selects either the last complete decision or the complete next decision rather than a partially written record.

## Important limits

- Cloudflare Worker secret values are write-only: inventory APIs expose names/types, not values. Recovery therefore cannot read or recreate an old secret value. It redeploys the prepared prior Worker version, whose immutable binding set still references the previous secrets. Do not delete old Worker versions during an active recovery.
- Cloudflare route recreation can produce a new immutable route ID. The deployment manifest is updated only after exact pattern/script verification. Pre-existing/unowned routes are refused before deployment because exact replacement recovery is not supported.
- Externally managed panel DNS is neither read nor changed. Its state must be recovered by its owner.
- Provider/API outages, expired authentication, deleted Worker versions, manually changed route/DNS records, or deleted AWS access keys can prevent automatic restoration. The record deliberately contains no secret values.
- Runtime key rotation journals the candidate access-key ID immediately, verifies candidate and promoted-primary behavior, and keeps every prior key active until the outer deployment records its commit decision. Cleanup after that decision is idempotent. Recovery never claims it reactivated a deleted key; before commit it requires every recorded prior key to still exist and be active, and after commit it finishes forward.
- Runtime key rotation uses exact `previousKeyIds` and `newKeyId` fields, durably journals intent before each AWS/Worker mutation, and fsyncs every temporary write, rename, and parent directory. A crash during candidate creation, promotion, deactivation, temporary-secret removal, or old-key deletion therefore recovers with the prior usable credential or the verified replacement; it never guesses at an unclassified key.
- Rollback completion also requires both the legacy SSM lifecycle lock and the current DynamoDB lease to be absent, released, or expired. An active or malformed lock leaves the recovery record unfinished rather than falsely reporting success.

For testing only, `MC_AWS_DEPLOY_FAIL_STAGE` and `MC_AWS_RUNTIME_FAIL_STAGE` inject failures at outer and runtime-key phases. The journal helper tests also inject power loss after `write-temp`, `fsync-temp`, `rename`, and `fsync-parent`; `MC_AWS_DURABLE_JOURNAL_FAIL_AFTER` exposes the same local hook for contract simulations. Do not set any of these during normal operation.
