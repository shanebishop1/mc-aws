# Competitive Product Strategy

Research date: 2026-09-01

## Current decision

This is a research-backed opportunity map, not the current release backlog. The
[Agent Foundation PRD](epics/ec2-agent-platform/live-server-agent-foundation/prds/first-shippable-ec2-agent-foundation.md)
supersedes the original near-term sequence: deliver one generalized, supervised agent for one owned server, validate
the packaged system, and stabilize one supported activation path before expanding the platform.

Direct edits to the actual server are first-class. Clones are optional safeguards, not prerequisites for ordinary work;
maintenance edits may stop the same server. Broad confined shell is intended, unrestricted host/cloud shell is not.
The PRD's effective permissions, supervisor/child separation and execution/failure matrix govern that distinction.
The older phases below are optional future directions, not dependencies to implement before the agent can ship.

## Goal

Build the best open-source platform for safely creating, configuring, operating, sleeping, restoring, and evolving Minecraft servers on infrastructure the operator owns.

“Best” does not mean cheapest subsidized compute, the largest unverified mod count, or the most dashboard buttons. It means the strongest combined outcome across:

- Ease of use.
- Infrastructure and data ownership.
- Secure defaults.
- Reproducibility.
- Portability and verified recovery.
- Configurability without forks.
- Evidence-backed automation and AI.
- Honest cost and performance information.
- A complete deterministic path when AI is disabled.

See [Orca Feature Parity Research](ORCA_FEATURE_PARITY.md) for the direct Orca comparison.

## Market reviewed

### Commercial hosting

- [Aternos](https://aternos.org/)
- [exaroton](https://exaroton.com/)
- [BisectHosting](https://www.bisecthosting.com/minecraft-servers)
- [Apex Hosting](https://apexminecrafthosting.com/pricing/)
- [Shockbyte](https://shockbyte.com/games/minecraft-server-hosting)
- [PebbleHost](https://pebblehost.com/minecraft-server-hosting/)
- [Bloom.host](https://bloom.host/minecraft/)
- [Nodecraft](https://nodecraft.com/pricing)
- [Minehut](https://www.minehut.com/server-plans)
- [FalixNodes](https://falixnodes.net/free-minecraft-server-hosting)
- [Minefort](https://minefort.com/pricing)
- [Server.pro](https://server.pro/pricing)
- [ScalaCube](https://scalacube.com/hosting/server/minecraft)
- [Hostinger](https://www.hostinger.com/vps/minecraft-hosting)
- [WiseHosting](https://wisehosting.com/)
- [Sparked Host](https://sparkedhost.com/minecraft-server-hosting)
- [Minecraft Realms](https://www.minecraft.net/en-us/realms)

### Open-source control planes

- [Pterodactyl](https://pterodactyl.io/)
- [Pelican](https://pelican.dev/docs)
- [Crafty Controller](https://docs.craftycontrol.com/)
- [PufferPanel](https://docs.pufferpanel.com/en/latest/)
- [MCSManager](https://docs.mcsmanager.com/)
- [LinuxGSM](https://docs.linuxgsm.com/)
- [GameAP](https://github.com/gameap/gameap)
- [Agones](https://agones.dev/site/docs/overview/)
- [itzg/docker-minecraft-server](https://github.com/itzg/docker-minecraft-server)

### Creation and operational tooling

- [Orca Client](https://orcaclient.com/docs)
- [MCreator](https://www.mcreator.net/)
- [bridge.](https://bridge-core.app/)
- [Blockbench](https://www.blockbench.net/)
- [Modrinth API](https://docs.modrinth.com/api/)
- [mclo.gs API](https://api.mclo.gs/)
- [spark](https://spark.lucko.me/docs/)
- [Paper profiling](https://docs.papermc.io/paper/profiling/)

## Competitive map

| Segment leader | What it does well | Opening for mc-aws |
| --- | --- | --- |
| Aternos | Mature free hosting, broad software support, shared access, world upload, backups | Transparent resources, no queue, owned infrastructure, reproducible config, stronger recovery |
| exaroton | Usage billing, join-to-start, idle shutdown, API, Discord, shared credits, metrics | Open source, direct provider cost, portable state, policy, GitOps, verified backups |
| Nodecraft Lite | Polished hibernation, friend wake links, backup on sleep | True infrastructure ownership, stronger hibernate economics, open automation |
| Bloom.host | Explicit CPU tiers, server splitting, Borg incremental backups and file restore | Portable backup proofs, declarative config, AI evidence, no provider lock-in |
| WiseHosting/Apex | Beginner-friendly modpack setup and migration | Equivalent ease with inspectable plans and reversible changes |
| Minecraft Realms | Lowest-friction official private vanilla experience | Modded extensibility, open infrastructure, cost control, richer operations |
| Pterodactyl | Mature multi-tenant Docker panel, nodes, APIs, SFTP, backups | Minecraft-native GitOps, compatibility lockfiles, safer extensions, real reconciliation |
| Pelican | Pterodactyl model plus plugins, RBAC, OAuth, and webhooks | Stable security model, sandboxed extensions, signed marketplace, non-beta foundation |
| Crafty Controller | Strong single-host Minecraft UX, backups, schedules, metrics, roles | Cloud ownership, provider adapters, isolated changes, portability and hibernation |
| MCSManager | Cross-platform distributed nodes and marketplace | Stronger security history, supply-chain policy, reproducibility, constrained execution |
| Agones | Real scheduling, fleets, health, and autoscaling | Persistent-world semantics, approachable compact edition, backups, content management |
| Orca | Unified AI creation, catalog, hosting, CLI, MCP, and launcher | Open source, model choice, reproducible outputs, verified recovery, policy, evidence, ownership |

## Current mc-aws advantages

mc-aws should preserve these instead of hiding them under a generic panel rewrite:

- Infrastructure is owned and directly billed by the operator.
- EC2 compute automatically stops after validated zero-player observations.
- Hibernate backs up the server and removes the attached root volume.
- Resume supports fresh, latest, or named recovery.
- Backup and restore scripts defend against links, traversal, special files, ambiguous uploads, and interrupted swaps.
- Lifecycle actions use a durable global lock, fencing, idempotent operation state, and retry reconciliation.
- The web panel has explicit admin, allowed-user, authenticated-public, and anonymous boundaries.
- SSH ingress is closed by default; operator access uses SSM Session Manager.
- External bootstrap and plugin artifacts are URL/checksum pinned.
- Deployment, migration, key rotation, teardown, and release workflows include preservation and recovery controls.
- AWS cost visibility is built into the panel.
- Mock mode supports deterministic local development without cloud access.

These are hard-to-market engineering strengths. The product work should expose them as understandable user guarantees.

## Current weaknesses that block a winning product

### Product boundaries

- One server, one EC2 instance, one global lifecycle lock.
- Paper-only pinned runtime.
- No Modrinth/CurseForge content lifecycle.
- No live file, console, player, or Minecraft-whitelist panel.
- No public friend wake link or protocol-aware wake path.
- No Java/Bedrock crossplay profile.
- No Discord integration.
- No provider-neutral server domain model.

### Reproducibility and portability

- Profiles are copied during provision/restore, not continuously reconciled.
- Profile removals do not remove live files.
- No immutable resolved mod/plugin lockfile.
- Backups are Drive-hosted tarballs without application-layer encryption.
- Restore capability is careful but not automatically exercised on a schedule.
- Backups are coupled to the current mc-aws archive workflow rather than a documented portable manifest.

### Operations and observability

- No user-facing diagnostic bundle.
- No structured log parser, compatibility engine, or spark integration.
- No durable exported audit trail.
- CLI does not poll asynchronous operations to terminal completion.
- No semantic plan showing cost, downtime, backup requirements, and rollback before mutation.
- No first-class restart, console command, resize, runtime upgrade, or artifact installation contract.

### Security debt to resolve before expansion

- Game TCP port is public to all IPv4 addresses.
- Worker compromise has high-impact EC2, Lambda, SSM, and secret-read authority.
- Sessions last 30 days without a server-side revocation list.
- Google Drive uses broad scope and backup archives are not independently encrypted.
- Human deployment expects temporary administrator-level AWS access.
- No durable CloudTrail trail is configured by default.
- OS package updates require reviewed host replacement rather than an automated maintenance channel.
- The provider abstraction can still be bypassed by raw SDK compatibility exports.

## Product thesis

The winning position is:

> Minecraft operations you can trust: open source, infrastructure you own, reproducible profiles, verified recovery, and AI that must show its evidence and rollback plan.

This is stronger and more defensible than “another free host,” “another Pterodactyl skin,” or “prompt in, JAR out.”

## Design principles

1. The domain model is provider-independent; AWS is the first complete adapter.
2. Desired state is declarative, versioned, exportable, and resolved to immutable inputs.
3. Every mutation has a plan, authorization decision, idempotency key, audit event, and rollback story.
4. Distinguish backup creation/integrity from restore verification; show consistency, recovery point and last restore evidence honestly.
5. Generated and third-party code is untrusted even when signed or scanned.
6. AI proposes typed operations; deterministic code authorizes and executes them.
7. Every AI workflow has a complete non-AI path.
8. Standard source projects and open artifact formats are preferred over proprietary editors.
9. Compact single-server operation remains first-class; Kubernetes is optional.
10. Claims are tied to public compatibility tests and measurable service objectives.

## Target architecture

### Stable domain objects

For future provider/server expansion, consider these domain objects. Do not freeze all of them as public APIs or
introduce new services before a concrete consumer requires them:

- `ServerProfile`: desired Minecraft, Java, loader, content, settings, resources, networking, access, backup, and idle policy.
- `ResolvedLock`: exact runtime image, artifact IDs, versions, hashes, dependencies, licenses, and generated configuration hashes.
- `OperationPlan`: semantic change, risk, downtime, estimated cost, required backup, policy decisions, and rollback point.
- `ServerStatus`: observed revision, health, endpoint, player count, tick health, backup freshness, and drift.
- `BackupManifest`: portable file hashes, runtime compatibility, encryption metadata, source revision, consistency class, and restore proof.
- `AuditEvent`: actor, role, server, request, policy result, before/after state, operation ID, and evidence references.

### Privilege separation

- Web/API service: identity, authorization, plans, and status only.
- Reconciler: computes transitions and invokes provider capabilities.
- Node agent: narrowly scoped process, filesystem, and game-console operations.
- Artifact resolver: downloads, verifies, scans, locks, and stages content.
- Backup controller: quiesces, exports, encrypts, replicates, and restores.
- Diagnostic service: redacts, parses, correlates, and packages evidence.
- Optional agent gateway: exposes only typed tools with scoped OAuth tokens.

The web UI and AI model must never receive a container socket, host-admin shell, AWS credentials, Drive credentials,
or unrestricted filesystem access. Confined workspace commands use the PRD's approved execution boundary.
The responsibilities above are logical boundaries, not a requirement to deploy a separate service for each one.

### Deployment editions

Potential future editions, not a commitment to build two deployment stacks now:

- Compact: one small deployment, one or a few servers, SQLite or PostgreSQL, AWS/local Docker adapters, S3-compatible backup storage.
- Fleet: optional Kubernetes operator, external database, node pools, policy adapters, and multi-region routing.

Do not make Kubernetes a prerequisite for a household or small community.

## Flagship differentiators

### 1. Restore proof

Every backup should show:

- Application-consistent or crash-consistent status.
- Encryption and storage destinations.
- Runtime/profile revision.
- Estimated RPO and RTO.
- Last isolated restore result and duration.
- Export instructions that do not require the original control plane.

No major reviewed host makes automated restore proof the center of its product.

### 2. Reproducible Minecraft lockfiles

Resolve mutable names into exact IDs, versions, hashes, environment classification, dependencies, conflicts, licenses, Java version, loader, and configuration hashes. This enables reviewable upgrades, drift detection, migration, and rollback.

### 3. Clone-and-test changes

For future workflows that opt into disposable testing, a change can use this sequence. It is not required for ordinary
direct-live agent operation; the current PRD instead requires mode-specific maintenance and recovery:

1. Verify a current backup.
2. Restore or clone into isolation.
3. Apply the proposed lock/profile.
4. Start Minecraft and require protocol readiness.
5. Run compatibility and acceptance checks.
6. Record logs, timings, and hashes.
7. Promote only after approval.

### 4. Evidence-linked diagnostics

A diagnosis must distinguish:

- Observed facts with line/metric references.
- Deterministic compatibility findings.
- Hypotheses and confidence.
- Missing evidence.
- Proposed low-risk and high-risk actions.
- Cost, downtime, and rollback.

Use mclo.gs-style deterministic parsing and spark/Paper measurements before model reasoning.

### 5. Open agent contract

Expose the same typed operations through web, JSON CLI, REST, and MCP. Support multiple model providers and local inference. Never bind the platform to one model vendor.

### 6. Secure content lifecycle

The user experience can feel one-click, but the implementation must resolve, pin, scan, stage, test, and atomically activate content. Preserve upstream publisher, source, license, digest, dependency, and compatibility metadata.

### 7. Honest sleep-to-play telemetry

Measure the complete join path:

1. Wake requested.
2. Compute ready.
3. Storage attached or restored.
4. Java process started.
5. Protocol ready.
6. Player login accepted.
7. Spawn ready.

This enables a better intermittent-hosting experience than vague “starts in seconds” claims.

## Phased roadmap

Durations are sequencing guidance, not delivery commitments.

### Phase 0: Baseline integrity

Objective: remove known contradictions and establish measurable product contracts.

Deliverables:

- Resolve CLI documentation contradiction.
- Document all active rate limits.
- Align dependency-audit documentation and CI behavior.
- Add a stable operation-result schema.
- Make the CLI poll accepted operations to completion.
- Add a first-class restart operation.
- Add a redacted capability/status export.
- Define a security threat model for multi-server, console, files, uploads, and AI.

Exit criteria:

- Documentation consistency checks cover the corrected contracts.
- Every lifecycle CLI command exits according to terminal operation state.
- No new mutating endpoint can bypass shared validation, authorization, locking, and audit helpers.

### Phase 1: Declarative single-server core

Objective: turn profiles from provisioning inputs into safe desired state.

Deliverables:

- Versioned `ServerProfile` schema.
- Immutable resolved runtime/content lockfile.
- Semantic plan and diff.
- Drift detection without automatic deletion.
- Explicit prune policy.
- Maintenance windows.
- Profile revision history and rollback.
- Vanilla, Paper, and Fabric server profiles with a published tested matrix.
- Safe instance resize planning.

Exit criteria:

- A fresh server can be rebuilt from profile, lockfile, and backup without undocumented state.
- The same input resolves to the same runtime and artifact hashes.
- Changes that require downtime or risk world conversion say so before approval.

### Phase 2: Diagnostics and verified recovery

Objective: become the safest platform to troubleshoot and recover.

Deliverables:

- Sanitized diagnostic bundles.
- Deterministic log and crash parser.
- Runtime, Java, loader, duplicate, missing dependency, disk, OOM, and permission checks.
- Optional spark profile ingestion.
- Portable encrypted backup manifest.
- S3-compatible backup adapter alongside Drive.
- Automated isolated restore drills.
- Restore freshness and proof in the panel.
- Durable external audit export.

Exit criteria:

- A fixture corpus measures diagnostic accuracy and redaction failures.
- Scheduled restore drills prove a backup can boot and pass protocol readiness.
- Backups can be exported and restored without Google Drive or the original control-plane database.

### Phase 3: Safe content management

Objective: match the most important managed-host convenience without sacrificing trust.

Deliverables:

- Modrinth search and metadata integration.
- Plugin/mod/modpack inventory.
- Dependency/conflict/environment resolution.
- License and provenance display.
- Staged installation and atomic promotion.
- Backup requirement and optional disposable clone test; direct activation requires the reviewed maintenance path.
- Rollback to previous lock/profile.
- World import with archive and path safety.
- Curated crossplay profile using Geyser/Floodgate.

Exit criteria:

- Installation never relies on a mutable project slug alone.
- Every activated artifact has an immutable source/version/hash record.
- Failed readiness automatically restores the previous known-good profile and content set.

### Phase 4: Complete operator experience

Objective: match strong panels while keeping every action constrained and auditable.

Deliverables:

- Sanitized live logs.
- Constrained web console with command policy.
- Player list, OP, ban, whitelist, and allowlist administration.
- Semantic settings editor.
- Root-confined file manager with archive safety.
- Schedules, webhooks, and Discord notifications.
- Friend wake/invite tokens with narrow scopes and expiration.
- Server health and backup dashboards.

Exit criteria:

- Roles can separately grant wake, console, player, file, content, backup, and infrastructure permissions.
- All console and file mutations produce before/after audit records.
- A compromised friend wake token cannot access administrative operations.

### Phase 5: Model-neutral AI and agent interfaces

Objective: beat Orca on trust and interoperability, not just chat UX.

Deliverables:

- Canonical typed tool registry.
- Stable JSON CLI.
- OAuth 2.1/PKCE MCP server with audience-bound, short-lived scopes.
- Read-only diagnostic assistant.
- Evidence-linked plan generation.
- Explicit confirmation for consequential operations.
- Bring-your-own model and local model adapters.
- Prompt-injection evaluation corpus for logs, chat, metadata, and uploaded files.

Exit criteria:

- The model never receives downstream infrastructure credentials.
- Tool authorization is deterministic and independently testable.
- Every AI proposal can be reviewed and executed without AI.
- Unsafe-action rejection and unsupported-claim rates are measured in CI/evaluation runs.

### Phase 6: Open creation pipeline

Objective: provide reproducible prompt-to-source creation.

Deliverables in order:

1. Datapacks.
2. Paper plugins.
3. Fabric server-side mods.
4. Forge/NeoForge after compatibility evidence.
5. Bedrock add-ons and 3D assets later.

Every output includes:

- Complete editable source.
- Original prompt and implementation plan.
- Exact template and toolchain versions.
- Dependency lockfile.
- Build-container digest.
- Compiler, static-analysis, and test logs.
- Disposable-server load report.
- Generated acceptance tests.
- SBOM, artifact hashes, signature, and provenance attestation.

Exit criteria:

- Public benchmark fixtures report compile, load, acceptance, and false-success rates separately.
- Generated code cannot reach production without the normal content plan, backup, test, and approval path.
- Outputs remain buildable without the hosted mc-aws service.

### Phase 7: Multi-server and provider platform

Objective: expand from one excellent server to an open control plane.

Deliverables:

- Server identity and per-server RBAC.
- Multiple servers without a global cross-server lifecycle lock.
- Placement and quota model.
- Local Docker adapter.
- Pterodactyl adapter.
- Additional cloud adapters based on community demand.
- Portable migration rehearsal.
- Optional compact node agent.

Exit criteria:

- Provider capability differences are visible during planning.
- Backup/profile/lock formats remain provider-independent.
- A server can migrate through backup/restore rehearsal with measured downtime and rollback window.

### Phase 8: Governed ecosystem and fleet option

Objective: enable community scale without turning extensions into an unaudited supply chain.

Deliverables:

- OCI-distributed profiles, policy packs, and extension bundles.
- Signed publisher identities, provenance, SBOMs, and digest revocation.
- Trust levels: Official, Verified Publisher, Reviewed, Community, Revoked.
- Compatibility test farm.
- Out-of-process gRPC or capability-limited WebAssembly extensions.
- Optional Kubernetes operator and fleet edition.
- Protocol-aware sleep/wake proxy and warm pools.

Exit criteria:

- Marketplace code cannot execute inside the control plane by default.
- Revoked digests can be blocked without deleting historical audit evidence.
- Compact and fleet editions consume the same profile, lockfile, backup, and policy formats.

## Success metrics

### Reliability and recovery

- Backup restore verification success rate.
- Median and p95 restore duration.
- Wake-to-protocol-ready and wake-to-spawn latency.
- Failed-change rollback success rate.
- Reconciliation convergence time.

### Security

- Percentage of runtime and content artifacts pinned by digest.
- Percentage with provenance and SBOM.
- Unauthorized-tool rejection rate.
- Secret/redaction regression count.
- Mean time to block a revoked artifact.
- Percentage of destructive actions preceded by a verified backup.

### Reproducibility

- Rebuild hash match rate.
- Profile drift age.
- Compatibility test pass rate by exact Minecraft/Java/loader tuple.
- Generated project compile, load, and acceptance pass rates.

### Product experience

- Time from repository clone to local mock panel.
- Time from configured cloud account to playable server.
- Time to install and safely roll back a modpack.
- Percentage of common tasks completed without shell access.
- Percentage of incidents resolved from diagnostic evidence without unrestricted console access.

### Cost

- Idle monthly cost by lifecycle mode.
- Cost per player-hour.
- Backup storage and restore-test cost.
- Predicted versus actual operation cost.

## Security gates before major capabilities

| Capability | Required gates |
| --- | --- |
| Web console | Per-command policy, fine-grained role, output redaction, immutable audit, rate limit |
| File manager | Root confinement, symlink/hard-link/special-file rejection, archive limits, audit, no secret paths |
| Artifact upload | Size/count/decompression limits, path safety, quarantine, hash, provenance, scan, sandbox |
| Content install | Exact artifact identity, dependency checks, required backup, reviewed maintenance/activation, verification and explicit recovery; isolated test where selected |
| MCP mutations | OAuth scopes, audience binding, short-lived tokens, confirmation, no token passthrough |
| AI diagnosis | Deterministic redaction, prompt-injection treatment, evidence references, uncertainty |
| Generated code | Network-restricted build/test, pinned toolchain, static checks, SBOM, provenance, acceptance test |
| Multi-server | Per-server tenancy, lock isolation, quotas, node trust model, secret separation |
| Marketplace | Publisher verification, signatures, revocation, no in-process arbitrary code, moderation |

## Explicit non-goals

- Subsidizing free compute to beat Aternos or Orca on headline price.
- Rebuilding Minecraft, Modrinth, CurseForge, Blockbench, bridge., or a general coding model.
- Supporting every Minecraft version and loader before there is a tested compatibility matrix.
- Claiming horizontal scaling for one persistent survival world.
- Making Kubernetes mandatory.
- Building billing, affiliate, or creator monetization before the open-source product is excellent.
- Treating signatures, scans, or AI review as proof that third-party code is safe.
- Offering unrestricted host/cloud shell through the browser or AI; broad confined workspace execution remains a current goal.
- Promising seamless live cross-cloud migration.

## Historical epic sequence

The original sequence below is retained as research context, not the current execution plan. Use PRD gates G0-G5 for
the next release. Do not start these ten epics as prerequisites or resume broad parallel implementation from this list.

1. Baseline contract/documentation corrections and complete CLI operation polling.
2. Versioned declarative `ServerProfile` and resolved lockfile.
3. Diagnostic bundle and deterministic compatibility engine.
4. Portable encrypted backup manifest and automated restore proof.
5. Modrinth-backed staged content lifecycle.
6. Constrained operator panel features.
7. Typed agent tools, JSON CLI, and OAuth-scoped MCP.
8. Reproducible Paper plugin creation.
9. Multi-server/provider architecture.
10. Governed ecosystem and optional fleet edition.

## Bottom line

No current competitor combines all of these properties:

- Orca's conversational creation and operational ease.
- exaroton's intermittent-use model.
- Bloom's serious backup ergonomics.
- Pterodactyl's hosting control plane.
- Crafty's Minecraft-specific usability.
- GitOps-style reproducibility and drift detection.
- Open, portable backup and profile formats.
- Evidence-linked, policy-constrained, model-neutral AI.
- Direct infrastructure ownership.

mc-aws can occupy that space, but only by sequencing trust foundations before breadth. The shortest credible route to “beat them all” is to become the platform that makes sophisticated Minecraft changes easy without asking users to surrender ownership, inspectability, or recovery confidence.
