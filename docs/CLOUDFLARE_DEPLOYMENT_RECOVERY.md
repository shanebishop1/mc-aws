# Cloudflare deployment recovery

`pnpm deploy:cf` inventories the current Worker deployment and version split, route, managed panel DNS proxy state, secret names/types, non-secret bindings, and tagged AWS runtime IAM key IDs before changing Cloudflare. It writes an owned `0600` recovery record beside the deployment manifest:

```text
.mc-aws-deployment.json.cloudflare-recovery.json
```

Do not delete or edit an active record. Recovery is checked before ordinary environment/schema/build preflight. Before the durable commit decision, the next run validates identity and rolls back. After the replacement runtime key and complete Worker configuration verify, the record stores `decision=commit`; an interruption then resumes forward key cleanup instead of attempting an impossible old-version rollback. A completed record is finalized as `.last`.

Recovery redeploys the recorded immutable Worker version split, restores or removes the project-owned route, and restores the managed DNS proxy state (or removes the exact placeholder record created by this deploy). A Worker proven absent before deployment is deleted on rollback. Concurrent route/DNS state that no longer matches the recorded deployer-owned shape is preserved for manual review.

## Important limits

- Cloudflare Worker secret values are write-only: inventory APIs expose names/types, not values. Recovery therefore cannot read or recreate an old secret value. It redeploys the prepared prior Worker version, whose immutable binding set still references the previous secrets. Do not delete old Worker versions during an active recovery.
- Cloudflare route recreation can produce a new immutable route ID. The deployment manifest is updated only after exact pattern/script verification. Pre-existing/unowned routes are refused before deployment because exact replacement recovery is not supported.
- Externally managed panel DNS is neither read nor changed. Its state must be recovered by its owner.
- Provider/API outages, expired authentication, deleted Worker versions, manually changed route/DNS records, or deleted AWS access keys can prevent automatic restoration. The record deliberately contains no secret values.
- Runtime key rotation journals the candidate access-key ID immediately, verifies candidate and promoted-primary behavior, and keeps every prior key active until the outer deployment records its commit decision. Cleanup after that decision is idempotent. Recovery never claims it reactivated a deleted key; before commit it requires every recorded prior key to still exist and be active, and after commit it finishes forward.
- Rollback completion also requires both the legacy SSM lifecycle lock and the current DynamoDB lease to be absent, released, or expired. An active or malformed lock leaves the recovery record unfinished rather than falsely reporting success.

For testing only, `MC_AWS_DEPLOY_FAIL_STAGE` and `MC_AWS_RUNTIME_FAIL_STAGE` inject failures at outer and runtime-key phases. Do not set either during normal operation.
