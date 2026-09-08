# mc-aws Project Context

mc-aws is an open-source control panel and runtime for operating a persistent Minecraft server on infrastructure owned by the operator. The current product combines a Cloudflare-hosted Next.js panel, an AWS/mock provider boundary, SSM-based host commands, Durable Objects/KV runtime state, DynamoDB lifecycle state and locks, content-addressed EC2 runtime assets, and an AL2023 Minecraft host hardened around the unprivileged `minecraft` service user.

Planning priorities are:

1. Preserve infrastructure and world ownership.
2. Make local mock mode a complete, cloud-free implementation and test path.
3. Put deterministic authorization, audit, recovery, and secret boundaries outside AI models.
4. Prefer stable mc-aws domain contracts and replaceable adapters over vendor coupling.
5. Keep direct live-server operation first-class; disposable clones are optional safeguards, not the only way to work.

## Current direction and document authority

The next product milestone is one capable, supervised agent for one owned Minecraft server, not a general hosting
platform rewrite. Preserve broad confined shell/file/console capability, direct operation, approvals and extensibility;
narrow the supported release paths and prove the assembled runtime before adding more recovery mechanisms.

The [Agent Foundation PRD](epics/ec2-agent-platform/live-server-agent-foundation/prds/first-shippable-ec2-agent-foundation.md)
is authoritative for this milestone. It replaces the previous parallel execution plan with stabilization gates G0-G5,
an authority model, useful task outcomes and a packaged execution/failure matrix. The current status is an implementation
candidate, not release-ready; compatibility inventory, activation scope and an approved offline runner remain gates.

[Competitive Product Strategy](COMPETITIVE_PRODUCT_STRATEGY.md) describes longer-term opportunities.
[Orca Feature Parity Research](ORCA_FEATURE_PARITY.md) is a dated comparison, not a commitment or release checklist.
[Agent Extensions](AGENT_EXTENSIONS.md) records the evolving implementation and cannot override the PRD or establish
readiness merely by describing a mechanism. Conflicting older recommendations yield to the current PRD.

Do not resume concurrent edits to shared authority protocols unchanged. Preserve existing backups, infrastructure,
lifecycle records and keys; speculative pre-release compatibility may be removed only after an inventory establishes
that it has no real consumer. Planning does not authorize cloud operations, deployment or privileged runner setup.
