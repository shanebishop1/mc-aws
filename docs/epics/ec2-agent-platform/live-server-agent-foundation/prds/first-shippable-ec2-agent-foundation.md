# PRD: First Shippable EC2 Agent Foundation

**Status:** Replanned; implementation candidate, not release-ready  
**Target branch:** `feat/ec2-agent-foundation`  
**Decision:** Preserve generalized capability; narrow release paths and reduce overlapping authority protocols.  
**Authority:** This PRD supersedes the earlier ST-1 through ST-4 execution sequence and conflicting near-term recommendations in the competitive strategy and Orca research. It specifies intended behavior, not proof that the current implementation provides it.

## 1. Product outcome

Deliver one capable, supervised Minecraft operator for one owned server. An admin can diagnose problems, run confined commands, edit server files, use the Minecraft console, approve consequential actions, and inspect durable results through the portal. Work targets the real server installation; a duplicate world or clone is not mandatory.

A four-command inspection dispatcher is not broad shell execution. A schema-valid extension that cannot load through the packaged production runtime is not a working extension feature. Neither may be used to claim completion of this PRD.

Keep mc-aws-owned public contracts, a replaceable Pi harness adapter, OpenRouter and generic OpenAI-compatible BYOK profiles, sessions, approvals, ordered streaming, protected execution evidence, lifecycle exclusion, reproducible runtime packaging, and the developer-machine maintainer skill. Read exact reviewed runtime/toolchain pins from the repository manifests; changing them requires dependency and packaging review, not a second version declaration here.

### Authority to operate

This plan authorizes no deployment, production host action, cloud API call, secret rotation, publication, or Git mutation. Do not infer current production state from an old planning snapshot. Local privileged VM/container creation, namespace setup, service operation, or runner provisioning requires separate explicit authorization. Do not weaken isolation when the available runner cannot enforce it.

## 2. Release scope

### Required user outcomes

| Scenario | Observable success |
| --- | --- |
| Diagnose a failure | Explain supplied logs/configuration with evidence references; distinguish observed facts from hypotheses |
| Confined shell | Execute a real subprocess using a reviewed toolchain, including useful command composition, without access to forbidden host paths, credentials, or control channels |
| Configuration change | Approve and apply a restart-required setting on the same server, use a narrowly scoped maintenance/restart operation, and verify the setting took effect |
| Player administration | Perform an authorized console/player operation and independently observe the requested result |
| Extension use | Load an explicitly enabled sample skill/tool/hook bundle through the packaged runtime and complete its task without a Pi or portal special case |
| Interrupted task | Recover after disconnect/restart without duplicating an uncertain effect; show exact known outcome or an actionable reconciliation state |

Plugin configuration edits are included. Installing/replacing executable plugins requires the reviewed artifact/maintenance path and is not an ordinary unrestricted write. Gate G0 must decide whether one such path is included in this release; until implemented and qualified, installation is explicitly unavailable in tools and UI. Generated plugin/mod build pipelines, full catalog management, and a browser file manager are deferred. This is not permission to restrict all generalized shell/file work to inspection.

### Keep the release small

- One server and one active host mutation owner; do not add multi-server tenancy or multiple active gateway support as implicit prerequisites.
- Select one reviewed end-to-end activation path at G0, including its prerequisite state, recovery procedure, supported update/rollback boundary, and operator configuration.
- Preserve real deployed compatibility obligations: existing backups, infrastructure ownership, lifecycle operations, retained keys, and deployment manifests.
- Defer unshipped agent migration/facade/lineage machinery only after confirming that no valuable agent data or external consumer depends on it.
- Defer advanced replacement, deployment recovery, and key-rotation expansion outside the selected release path. Do not remove already-shipped protections or leave excluded paths callable as if safe with an active agent.
- Multi-provider hosting, MCP, fleet editions, marketplace infrastructure, mandatory clone testing, and subscription-specific harness integrations are not release prerequisites.
- The meta-agent remains a local developer skill, never a credential-bearing assistant embedded in the panel.

## 3. Threat model and execution boundary

Before further shared-protocol changes, write down assets, principals, supported entry points, and authority transitions. Treat model output, provider responses, server logs/files, extensions, tool children, and plugin code as untrusted. State explicitly whether and how a compromised Minecraft process is contained. A compromised root/kernel is outside the sandbox guarantee; shared Unix UID alone is not a security boundary.

### Principals

| Principal | Authority | Must not expose |
| --- | --- | --- |
| Portal/control plane | Admin identity, policy, exact approvals, task intent and durable publication | Cloud/provider secrets to model or tool requests |
| Harness gateway | Model connection and bounded orchestration using scoped runtime credentials | Provider/runtime credentials to tools or extension callbacks |
| Trusted executor supervisor | Validate execution grants, contain children, record effect truth and authenticate evidence | Journal/receipt keys, evidence storage, privileged sockets or supervisor control to tool children |
| Tool child | Approved workspace/scratch mounts, command budget and narrowly permitted I/O | Root, host administration, metadata, AWS APIs/credentials, deployment/backup secrets, unrelated paths or cross-session scratch |
| Existing host maintenance authority | Quiesce/restart, backup/restore and reviewed activation | General root shell to the model |

These are trust boundaries, not a mandate for one new daemon per row. Prefer existing mechanisms where they actually enforce the boundary. The shipped arrangement must isolate arbitrary children from supervisor credentials/evidence even when code runs under a Minecraft-domain identity. Verify process, filesystem, descriptor, socket and environment boundaries in the assembled runtime. Code written into the server may execute later as Minecraft/plugin code; its eventual authority must be included in the threat model, not assumed confined by the original tool invocation.

### Honest capability semantics

- Distinguish read-only shell from writable shell using enforced mounts and process/network limits, not command-name classification alone.
- General writable shell is potentially destructive within its writable scope. Effective authorization includes that authority; allowing shell must not bypass a denied delete/write capability. Reject incompatible policy combinations or require an explicit destructive grant with an accurately displayed effective scope.
- Unknown/broad effects receive conservative classification. Hooks may raise risk, never lower it. Exact approval does not override immutable boundaries.
- Network access is denied by default. Any supported download/egress path must independently constrain destination, bytes, redirects, content identity and exposure of private server data. Provider connection permission does not grant tool networking.
- Bind approval to actor, task, invocation or declared batch, scope, policy revision, expiry and relevant preconditions. Recheck authorization and expected configuration/artifact identity immediately before execution.
- Keep Copilot, Maintainer, Autopilot and Custom as visible presets. No preset means unlimited authority. Exact destructive approvals apply to general writable shell regardless of preset; session grants are bounded, revocable, and cannot survive incompatible policy/scope changes.
- Allow a deterministic non-AI way to inspect and approve the same operation. Cancellation prevents new work but does not assert rollback of an effect already entered.

## 4. Direct operation, maintenance and backups

Direct operation means the actual installation, not necessarily concurrent file modification while Minecraft runs.

| Mode | Examples | Required behavior |
| --- | --- | --- |
| Online inspection | Logs, configuration, directory inspection | Bounded reads; disclose potentially changing observations |
| Supported online mutation | Validated console/player operation | Command-specific policy, protected execution and independently checked result |
| Maintenance edit | World files, executable artifacts, restart-required configuration | Acquire maintenance ownership, quiesce/stop the same server, take required backup, edit, restore intended service state and verify |

An agent lock does not stop Minecraft from writing files. Backups must identify their consistency class and recovery point. A file write or accepted console command is not proof that the requested game state is active. Restart uses a narrow host operation, never arbitrary systemd management from shell.

Keep backup modes `never`, `before-destructive`, `before-risky` and `before-any-mutation`. Default Copilot to before-any-mutation, Maintainer to before-risky and Autopilot to before-destructive. Backup policy never relaxes immutable denials. Only an authoritative terminal backup execution failure may offer explicit proceed-without-backup or cancel; conflicts, unavailability, cancellation and unknown outcomes remain blocked.

A declared bounded edit batch may share one approval and backup while protected by the same maintenance ownership and validated preconditions. New scope requires new authorization. Do not reuse a backup merely because it is recent; intervening writes and loss of ownership invalidate the assumption. Avoid a full remote backup for each tiny edit when one protected batch suffices.

Approval UI shows effective write/destructive scope, downtime, backup status, verification method and rollback limitations. Do not promise automatic rollback of arbitrary shell effects. Restoring a world backup can discard intervening player progress and requires explicit handling of that consequence.

## 5. Minimal authority and recovery model

| Fact | Authoritative owner |
| --- | --- |
| Task intent, policy and approval | Control plane |
| Whether an effect was reserved, entered, completed or remains unknown | Trusted host execution evidence |
| Whether host maintenance permits work | Existing host/lifecycle authority |
| Delivery/retry ownership | Queue/lease mechanism; never proof of effect truth |
| Displayed status and replay | Projections of durable control-plane publication |

Require one active mutation owner, one terminal-publication contract, and explicit unknown-outcome handling. Authentication across trust boundaries remains necessary; simplification must preserve the invariants rather than deleting signatures, journals or fences by count.

1. Authorize and reserve an exact invocation before dispatch; durably record its ownership.
2. The supervisor records effect entry and terminal truth. Lost responses never authorize blind redispatch.
3. Publish the authenticated terminal result idempotently, preserving original evidence and centrally redacted display data without conflating their digests.
4. Release the exact lifecycle ownership only when authoritative evidence permits it, then acknowledge publication and retire the matching handoff. Retries reconcile the same identities.
5. Unknown outcomes retain exclusion until an explicit supported recovery establishes truth. Lease expiry and elapsed time alone are not evidence of no effect.
6. A clean-start/no-active proof establishes that the old execution cannot continue; it does not prove that earlier changes never happened. Reconcile committed state before offering retry or rollback.

Document operator-visible recovery: reason, blocked resource, last verified phase, exact supported resume/reconciliation action, and what must not be deleted. Fail-closed safety without an operable recovery procedure is not release completion.

Choose storage topology from measured single-server needs. Compare a server-scoped coordinator with bounded separate session/event/work records against the existing shard/index design before adding coordination layers. Keep one authority per fact, bounded replay/retention and backpressure; do not put unbounded history into every lease or repeatedly rewrite it for each streamed token.

## 6. Extensibility and runtime budgets

Keep public mc-aws contracts for capabilities, invocations/results, policies/approvals, sessions/events, provider profiles and extension manifests. Validate security-relevant fields strictly. Freeze only contracts used by an actual consumer; internal checkpoints and orchestration objects are not automatically public APIs. Pi-specific shapes remain inside the adapter.

Distinguish data-only skills/presets using existing capabilities from reviewed code extensions shipped through the runtime release process. Untrusted executable plugins in the credential-bearing gateway are deferred. The sample bundle must work through production loading, not merely pass registry validation. Provider credentials use protected references; secrets never belong in prompts, contracts or event payloads. Redaction is defense in depth, not proof that arbitrary server text contains no sensitive information.

Before acceptance, declare measured defaults and hard limits for gateway and executor memory, CPU, processes, elapsed execution, output and temporary disk; model turns, tool calls, retries and task duration; queued/streamed events and retained state. Show bounded usage and estimated model spend without presenting uncertain provider pricing as an exact guarantee. Budget exhaustion stops new effects and preserves reconciliation evidence.

Measure combined workload with Minecraft running. JVM heap arithmetic and gateway-only limits do not establish adequate OS/native/executor headroom or qualify an instance size. Record idle overhead, peak RSS/disk, task latency, approval count, backup duration and gameplay impact for the supported workload.

## 7. Execution and failure matrix

G0 records exact fixtures, expected outcomes, runner requirements and evidence locations for this minimum matrix. Every row must pass on the same identified candidate. A command not yet implemented is a blocker, not an assumed test result.

| Area | Required evidence |
| --- | --- |
| Product outcomes | All required scenarios in section 2; assert files and server behavior, not only emitted events |
| Packaged composition | Actual packaged gateway, real Unix socket, supervisor and real confined subprocess; production configuration parsing and installed paths |
| Harness/provider | Pi adapter driven by an offline scripted provider, including streaming/tool translation; fake harness remains a separate fast test |
| Control plane | Actual local Worker/Durable Object adapter and production transport contracts, plus in-memory conformance; approvals, replay and publication cross process boundaries |
| Backup integration | Typed coordination plus real local backup/archive effects and restore verification; provider endpoint is an offline fixture, not a real Drive account |
| Install/activation | Selected path, repeat install, service readiness, socket-only activation, process restart and supported rollback on the packaged target environment |
| Isolation | Tool and Minecraft-side attempts against secrets, evidence storage, control sockets, metadata, path/link escapes, process visibility, inherited descriptors and denied network paths |
| Dispatch crashes | Termination before/after reservation, dispatch and effect entry; count actual effects and prove uncertain work is not duplicated |
| Publication crashes | Terminal persistence, publication, ownership release and acknowledgement response loss; correct idempotent recovery |
| Authority changes | Approval expiry/revocation, lease loss, cancellation and stale/forged identity while queued and executing |
| Maintenance | Backup, restore, idle shutdown and selected rollout race against work; interrupted maintenance and reboot preserve exclusion and intended service state |
| Resource exhaustion | Output flood, model/tool loop, disk full, process/memory limits and slow consumer; bounded impact and recoverable evidence |

Fast unit/mock tests remain necessary and cloud-free. They are not substitutes for composition or OS enforcement. Use a disposable offline AL2023-compatible environment with the actual target service manager, isolation features and reviewed ARM64 artifacts; document any architecture/emulation limits. The runner needs separate authorization if privileged operations are required. Permit only test-local transports, deny external cloud/model traffic, and record the enforcement. Real-provider smoke tests are optional and separately authorized.

Prepare a reviewed runner/image/toolchain and required artifacts before offline execution. If acquisition needs network or a privileged runner is unavailable, report the dependency and obtain authorization; do not download implicitly or bypass the boundary. Missing composition/build evidence means **implementation candidate, validation blocked**, not release-ready.

## 8. Stabilization sequence

Do not resume the previous eight-engineer allocation unchanged. Earlier T-1.1 through T-4.3 labels are historical references, not proof of completion or instructions to restart parallel lanes. Map existing work to these gates without discarding valid fixes.

| Gate | Work | Exit evidence |
| --- | --- | --- |
| G0: Freeze and inventory | Identify baseline commit plus all dirty/untracked input digests; inventory supported paths, persisted data, keys and external consumers; settle plugin scope, activation path, threat model and matrix; assign shared-protocol owners | Reviewed inventory and explicit unresolved blockers; no assumed agent migration obligation or implicit privileged-runner approval |
| G1: Stabilize prerequisites | Resume concrete backup syntax, installer activation and active-fence/operation-authority fixes serially where reproduction confirms them; give world-root/restore integration one owner | Reproductions fixed on a coherent snapshot; existing data/ownership protections retained |
| G2: Complete capability | Implement genuine confined subprocess execution, supervisor/child separation, effective destructive policy, working extension loading and narrow restart integration | Product and confinement scenarios work without widening forbidden authority |
| G3: Prove composition | Assemble packaged runtime and local control plane; exercise approvals, backup, maintenance and durable publication on the approved offline runner | Execution/failure matrix, resource measurements and reproducible package identities |
| G4: Review candidate | Freeze inputs again; run normal repository gates and one composition-focused review against exactly those inputs | No confirmed reachable credential-exposure, data-loss or duplicate-dispatch blocker; no missing required outcome, configuration, build or matrix gate |
| G5: Handoff | Document supported activation/recovery, excluded-path guards, compatibility window, configuration and evidence | Qualified candidate for separately authorized deployment, not an automatic production action |

Only independent leaf work with agreed contracts may run in parallel. One owner controls each shared authority protocol and its consumers. Protocol changes invalidate affected evidence and require a coherent retest; reviewers must not assess a moving tree.

Each finding records snapshot identity, category (security, functionality, configuration, compatibility or validation), supported entry point, preconditions, reachable failure, reproduction, impact, owner and closing evidence. Hypotheses remain labeled as such. Unsupported scenarios must be explicitly guarded or placed in a backlog, not repeatedly added to the release boundary through audits.

## 9. Decisions still requiring evidence

- Which agent versions, if any, were deployed, and which valuable agent sessions/external consumers require preservation? Do not remove migration support based only on absence from the current branch.
- Which exact activation path and recovery/update window must serve this release? Existing production assets retain their protection even when a new agent path is deferred.
- Is executable plugin installation included now, and through which reviewed path? If not, tools and UI must state the limitation.
- Which approved offline runner can exercise the target isolation, service activation and crash/reboot matrix? Record authorization separately.
- What tested resource defaults meet the intended Minecraft workload? Do not invent a minimum-instance guarantee before measurement.

These decisions gate implementation scope and qualification. This document does not assert they have been resolved or that engineers have been paused/resumed by tooling.
