# Agent extensions and local maintenance

## Implementation status

This document describes an evolving implementation candidate, not verified release behavior. The
[Agent Foundation PRD](epics/ec2-agent-platform/live-server-agent-foundation/prds/first-shippable-ec2-agent-foundation.md)
governs intended scope and gates G0-G5. Descriptions of journal, migration and recovery mechanisms below are not a
requirement to retain every mechanism or proof that the assembled system is qualified.

Known review gaps to reconcile: broad shell cannot be replaced by four inspection operations; extension registry
validation must be backed by a working packaged-runtime load path; supervisor evidence/credentials must remain outside
arbitrary tool children; and mock/string-based service tests do not establish OS confinement. Plugin/runtime write
restrictions below describe the candidate boundary, not a claim that plugin installation is delivered.

Inventory real persisted obligations before changing compatibility machinery. Keep existing data and recovery protections
until an agreed replacement preserves their invariants. Migration, maintenance and resource-sizing descriptions below
need composition evidence against the frozen candidate; do not treat their presence as release acceptance.

mc-aws extensions are versioned, data-only bundles loaded through the public `loadAgentExtensionRegistry` export in
`lib/agent/`. The schema-v1 example is [`examples/agent-extensions/status-report/extension.json`](../examples/agent-extensions/status-report/extension.json),
with its referenced skill beside it. Adding that bundle requires no Pi adapter or portal edit.

## Bundle rules

- Declare schema version, stable extension/tool/skill/hook IDs, SemVer, contract/platform compatibility, and SHA-256
  provenance. The loader rejects incompatible versions, altered provenance, duplicate IDs, unknown fields, untrusted
  third-party provenance by default, and missing tool references. Ordering is extension ID, definition ID, and hook
  priority/ID, independent of discovery order.
- Tool manifests request an existing mc-aws capability. Skill `requestedTools` must resolve inside the same bundle.
  Hook `handlerRef` values are inert identifiers mapped only by trusted mc-aws runtime code; bundles cannot supply an
  executable callback to the credential-bearing gateway.
- Extensions cannot add providers, credentials, policy overrides, or immutable-boundary exceptions. Root/capabilities,
  host administration, metadata, AWS APIs/credentials, deployment and backup-provider secrets, gateway/provider
  credentials, and paths outside workspace/session scratch remain denied before side effects. Unknown requests fail
  schema validation. Provider profiles use opaque `secret-ref:...` values managed outside extension bundles.
- The generic agent tools also classify `paper.jar`, canonical `plugins/*.jar`, shell startup scripts, native libraries,
  systemd-unit paths under `systemd/`, and recognized executable/extensionless launcher paths under `bin/`, `lib/`, `native/`,
  `profile/`, `runtime/`, `scripts/`, `server-profile/`, or `systemd/` as immutable-denied. Matching is
  canonical and case-sensitive: traversal, duplicate separators, suffix/lookalike names, encoded spellings, and case
  changes do not become asset identities. Generic `workspace.write`, `workspace.delete`, and `network.download` cannot
  update these paths even with an exact approval or verified download digest. Updating one requires a separately reviewed
  rollout/profile extension with artifact provenance, exact digest and size, a successful backup, an active maintenance
  fence, and explicit operator approval; no such exception is granted by an ordinary extension bundle or approval card.
  The existing root-owned profile/runtime rollout is the review boundary and is not an agent shell capability.
- Approval and backup policy still applies. A hook may raise risk, never lower it. Exact approvals cannot override an
  immutable denial; only an authoritative terminal backup execution failure pauses for an explicit proceed-or-cancel
  decision. Conflicts, in-progress work, cancellation, unavailability, and ambiguity fail closed. Extensions cannot mint,
  alter, renew, consume, or finalize the control-plane-signed, lease-generation-fenced backup authorization. An active
  lifecycle owner cannot expire into takeover, and the executor validates its latest signed generation immediately before
  the host commit point. Backup create/recovery first validates the current active invocation and live task lease; a completed
  operation lookup cannot mint a fresh fence for a cancelled, expired, replaced, or revoked invocation. The gateway durably
  records exact-bound `awaiting-backup` and `awaiting-executor` handoffs, obtains an authenticated executor `reserved`
  entry for the exact request, and only then persists `dispatching` before `execute`; restart recovery consults authoritative
  lease/task and executor state before dispatch or fence release. An exact `reserved` entry proves `begin` and the host
  effect were not entered, so the same request can resume under current authority or be cancelled if authority was withdrawn.
  This automatically recovers a pre-dispatch proven-never-started effect, but elapsed time
  alone never permits takeover while the effect may still commit.
  The executor journal itself is canonical-HMAC authenticated with a root-generated 32-byte systemd credential isolated
  from the shared Minecraft UID. Schema v3 uses a small authenticated manifest, alternating atomic checkpoints, one
  complete authenticated transaction frame per append generation, and an authenticated monotonic generation floor.
  A transaction is validated wholly before any of its ordered mutations are applied, and acknowledged-entry compaction
  publishes folded evidence plus deletion in one atomic checkpoint. Recovery validates every candidate and chooses
  the newest generation at or above that floor; an old replay, partial checkpoint switch, missing manifest-selected
  sidecar, invalid MAC, deletion, or malformed complete transaction fails closed. An incomplete final append frame is ignored wholly,
  then the selected append file is truncated and synced to its last complete authenticated byte boundary before reuse;
  publication errors recover the newest durable generation rather than rolling state back in memory;
  the protected gateway checkpoint then classifies a lower recovered generation as indeterminate. Older inactive slots
  may be absent only before their first rotation. The protected gateway checkpoints the journal sequence before durable dispatch;
  state below that checkpoint is indeterminate and retains the fence, never `not-started`, terminal trust, redispatch,
  or release. Before returning authenticated `reserved` state, the executor reserves logical byte and entry capacity for a maximum bounded
  terminal/fallback record, so capacity exhaustion is rejected before the effect and cannot strand its terminal commit.
  A fresh no-handoff invocation alone may initialize safely.
    The executor's pre-start world-root verifier is installed at the exact path inside its `RootDirectory` (with only
    its pinned Python interpreter bind-mounted), so preflight cannot accidentally run the host helper outside the
    executor filesystem. The root host-operation verifier reads the executor's manifest, checkpoint, append, and generation-floor records from
   this same contract, including authenticated epoch, compaction evidence, and publication acknowledgement fields. It
   blocks reserved work, every retained gateway handoff, unknown/indeterminate truth, and committed effects without an
   exact publication acknowledgement. An HMAC-authenticated terminal carrying `mutationCommit: { committed: false }`
   is accepted as proven no-effect without pretending that a host mutation occurred.
   Backup, restore, destroy, and automatic idle shutdown pass durable gateway-handoff context plus a journal checkpoint:
   an absent executor journal is idle only for an explicit never-used or proven-no-dispatch context, and fails closed
   after durable dispatch. Idle shutdown acquires the shared host lifecycle lock, establishes the maintenance fence, drains
   the gateway, masks activation paths, and requires this root verifier before stopping the executor or instance.
  For now, every canonical write, delete, or download to
  the workspace-root `server.properties` is classified as
  destructive permission/access-control configuration. Every non-deny base rule therefore becomes an exact
  invocation-digest-bound `ask-always` approval; Autopilot also applies its default before-destructive backup. The
   Before every executor attempt, including effects that need no backup, the gateway atomically claims one exact
   runtime-wide execution owner in its protected StateDirectory and checkpoints the authenticated executor journal
   before marking dispatch. A different session, task, lease generation, or invocation cannot claim that slot. On
   authorization, the control plane compares the complete activeRuntimeInvocation—runtime ID, session/task, lease
   ID and generation, invocation ID/digest, capability, and target scope—so a retained proposal cannot authorize a
   current lease or a different request. The executor wire context carries the runtime ID and enforces the same
   equality for authorization and request ownership.
   restart the gateway compares every durable handoff with the executor's authenticated in-flight identity before it
  requests work; active, pending, cancellation-pending, indeterminate, publication-pending, missing, rolled-back, or
  corrupt state blocks all new leases. The executor independently serializes all effects globally and rejects a
   distinct invocation while a reserved, entered, indeterminate, or unacknowledged terminal entry owns its journal. Every durable executor terminal uses the
   privileged terminal-only recovery mutation, including while the original work lease is still current. In one
   transaction it persists the centrally redacted result, records both the original executor digest and the persisted-result
   digest, clears the exact lease/runtime invocation, and establishes immutable task/session publication statuses. It is
   bound to the durable runtime owner/handoff, prior lease generation, invocation digest, journal sequence, result digest,
   and terminal receipt, and grants no execution authority. Only after successful idempotent publication does the control
   plane return a signed acknowledgement bound to those immutable publication facts. The gateway then releases any exact
   lifecycle fence and sends that authorization to the executor before removing the gateway handoff. The executor emits an authenticated receipt for
   every durable terminal result (committed, failed, cancelled, or indeterminate); `mutationCommit` is true only for an
   observed commit point, false for proven no-effect, and omitted only when effect truth remains unknown. Only that exact acknowledgement makes a
  non-indeterminate terminal entry compactable. The latest acknowledged full result remains replayable across a lost
  acknowledgement response; a later start folds older acknowledged terminals into constant-size HMAC-authenticated
  aggregate/checkpoint evidence (`acknowledgedCount`, latest terminal sequence, aggregate digest, and a fixed 1-MiB,
  seven-hash replay filter); unbounded per-invocation `claims` are not part of schema v3. Waiting, active,
   unacknowledged, and indeterminate records are never pruned. The executor persists the signed terminal receipt in the
   same durable entry before responding, so a lost publication response remains recoverable after receipt-key rotation
   with the retained old verifier; recovery never renews a finalized fence merely because that receipt uses an older key.
   For reserved or proven-not-started work, cancellation withdraws executor authority first and requires the exact
   no-effect result/receipt before releasing the lifecycle fence. The
  approval summary explains this conservative classification and identifies
  exact security-sensitive keys when present; nested, suffixed, case-changed, or merely similar filenames and keys do not
   match. The root-owned immutable `/etc/mc-agent/world-roots-generations/<digest>/world-roots.json` is the canonical
   validated allowlist, published through the single `/etc/mc-agent/world-roots-current` generation symlink. On first install it
   is derived from Java-properties `server.properties` `level-name` plus `_nether` and `_the_end` (or the same safe `world`
   defaults when the property is absent); `=`, `:`, unescaped whitespace, escapes, and continuations are parsed with
    Java semantics (only CR, LF, and CRLF terminate physical lines; form-feed and Unicode separators do not) and malformed
    escapes fail closed. Profile install and existing-host rollout preserve an existing valid
   custom allowlist when the level name is unchanged; an explicit `server.properties` level-name transition derives and
   publishes a new complete generation plus only explicitly reviewed additions rather than preferring stale generated roots. They
  render identical roots into gateway and executor configs; they reject malformed or conflicting legacy configs before
   replacing either one. An operator changes roots explicitly by reviewing and atomically publishing a new complete generation,
    then rerunning the profile reconciliation. A reviewed profile `server.properties` level-name change is committed
    through the same stopped-host transaction as its derived root generation; publication failure restores both the
     prior file and prior generation before any service restart. Approved agent writes, downloads, and deletes of the root
    `server.properties` use the same transaction through the root-owned `mc-agent-world-roots.service` broker. Its
    root:mc-agent mode-0660 Unix socket and domain-separated executor-journal HMAC authenticate the confined executor;
    the broker consumes only one bounded digest-bound staging file and returns one generation identity. Every install, rollout, rollback, and service-start path verifies exact
   three-way equality and fails closed on mismatch. Backups embed the canonical roots as hidden archive metadata; the durable
   restore journal carries the exact prior generation and reviewed/active root records; restore
   preserves exact authenticated custom roots even when the current profile overlays a different level name, validates and
   publishes that staged generation before activation, removes the metadata from the installed server tree,
   and reactivates the exact prior generation together with the prior server directory before services during precommit rollback. Writes, deletes, and downloads at or below those roots are destructive without
  case-folding, substring, or lookalike matching. Console policy is similarly fail-closed: only a narrow explicit set of
  read-only commands is low risk and a narrow non-persistent set is risky; all other commands, including nested
  `execute`, functions, datapacks, and plugin namespaces, are destructive and receive exact approval summaries plus the
   configured destructive backup gate.

## Network download content identity

The download tool uses a strict policy for both executable and non-executable data: **every** download request must
carry operator-supplied `expectedSha256` (lowercase SHA-256) and `expectedBytes` values in its tool arguments. A mutable
URL, `maxBytes` bound, MIME type, or `Content-Length` header is never an identity. The exact digest and size are included
in the invocation digest, sanitized proposal, approval scope, gateway download grant, and executor authorization. A
data-only extension that requests a download must collect these values from the operator; extension prose cannot weaken
the requirement or mint a grant.

The credentialless relay follows only the exact canonical HTTPS resource. It audits and signs the final URL, rejects
redirects that change that resource, streams bytes into an exclusive staging file, and verifies the exact byte count and
SHA-256 before the executor's atomic rename. Any mismatch, cancellation, redirect swap, or truncated response removes
staging and crosses no mutation commit point. Successful result evidence includes the verified final URL, exact byte
count, and SHA-256.

Portal approval cards show the source, destination, byte bound, exact expected size, expected SHA-256, and redirect/staging
policy so an operator can review the complete content identity before approving. Approval records are exact invocation
and scope bindings; transplanting an approval to another URL, destination, digest, size, session, or lease is rejected.

After editing a bundle, compute its digest with `computeExtensionIntegrity`, put the same digest in bundle and skill
provenance, and run:

```sh
pnpm exec vitest run lib/agent/extensions.test.ts tests/agent-runtime-package.test.ts tests/agent-runtime-services.test.ts
pnpm typecheck
pnpm check
pnpm docs:check
pnpm agent-runtime:check
```

For the focused release security evidence and cloud-free runtime slice, run:

```sh
pnpm test:agent:e2e
```

That command runs only `tests/agent-security-adversarial.test.ts` and
`tests/agent-local-vertical-slice.test.ts`. It creates collision-free temporary roots, installs process-level guards
against Fetch/HTTP/HTTPS/TCP/TLS access, and uses only the in-memory authoritative store, fake provider/harness,
typed deterministic backup adapter, runtime gateway, guarded executor, and local test host. The slice records ordered
inspect/proposal/exact-approval/backup/edit/console/evidence/completion events, reconnects from a cursor, and verifies
the outside sentinel and zero-network/AWS/provider-call counters. The adversarial suite covers immutable-boundary,
approval/replay, event/lease, redaction, provider endpoint, extension provenance, and cancellation denials before host
effects. It never starts the production server or invokes a cloud provider.

The default Vitest configuration excludes those two dedicated suites so `pnpm test` remains the unit/contract gate.
Baseline CI runs `pnpm test:agent:e2e` as a separate required network-disabled job rather than relying on accidental
discovery by the default test command.

All required checks are cloud-free. Do not enable real-provider smoke tests or run deployment, SSM, host lifecycle,
secret, publication, or production commands. Runtime/systemd review is local: inspect package manifests and checksums,
run service/package tests, use `bash -n` for changed scripts, and optionally use local `systemd-analyze verify`; never
install or operate the units as part of extension validation.

## Provider-stream and host resource sizing

The production Pi/OpenAI-compatible path treats provider token limits as advisory. The gateway independently caps each
incoming response body at 4 MiB before JSON parsing, each raw SSE line at 128 KiB, each raw SSE event at 256 KiB, one
response at 4,096 SSE events, and all streamed tool-argument fragments in one response at 128 KiB. Pi-to-gateway
publication can retain at most 64 events or 512 KiB, whichever is reached first. The provider body wrapper uses pull
backpressure and requests identity encoding. Any raw-body, framing, event-count, tool-argument, or publication-queue
overflow aborts and cancels the response transport, fences later tool calls, and emits only the sanitized audited
`provider-response-limit` failure. These ceilings are compiled local hard limits and cannot be raised by a provider
profile or a claimed token count.

`mc-agent-gateway.service` adds `MemoryHigh=192M`, `MemoryMax=256M`, and `TasksMax=64`. The default `t4g.medium` has 4
GiB of RAM while `minecraft.service` reserves a 3,276 MiB Java heap. Capping the gateway at 256 MiB leaves about 564 MiB
after the Java heap for the JVM's native memory, the OS, and short-lived executor work; the gateway is throttled or
terminated inside its own cgroup instead of consuming Minecraft's heap allowance. Treat `t4g.medium` as the minimum for
this exact 3,276 MiB heap. Before increasing the gateway cap, first move to a larger instance or deliberately reduce the
Minecraft heap, and preserve at least the same non-heap headroom. Provider/model limits are not a reason to raise the
service cap.

## Durable agent state and lease budgets

The authoritative session aggregate is capped at 900,000 UTF-8 JSON bytes. Ordinary writes stop at 772,000 bytes,
leaving 128,000 bytes for terminal/result reconciliation. Before a write, the state store deterministically removes
old turns and replayable model/reasoning/progress data; approvals, task status, invocation/audit digests, active tool
proposals, and terminal receipts remain authoritative. Event replay reports the updated retention floor, so an old SSE
cursor receives `replay-truncated` rather than silently skipping the new cursor.

A runtime work lease is independently capped at 240,000 encoded response bytes, including its JSON success envelope.
Only a bounded recent session context is sent to the gateway; the full historical session remains in durable state.
The store validates that exact encoded lease before committing the lease CAS, preventing a durable lease that cannot be
returned through the gateway's 256,000-byte response reader. A legacy or poison candidate that still cannot fit is
durably quarantined by exact session revision before CAS. The poll releases only that candidate's coordinator claim and
may continue through at most eight one-candidate grants, so poison candidates cannot permanently hide later healthy work. A newer
ordinary session revision clears only the encoded-response quarantine after compaction; migration quarantines remain
fail-closed until per-session recovery.

Each production session aggregate is authoritative in its own deterministically named `AgentSessionShardDurableObject`.
The shard retains CAS, idempotency records, ordered event replay, and revision waits. A successful idle session, and every
terminal session, is immediately moved from the shard's active slot to its archive slot. Its compact summary remains in
the separately paged actor/global index, so it stays listable; detail and replay are loaded only when that session is
opened. Continuing an idle session CAS-moves the aggregate back to the active slot. This deterministic archive policy has
no global session-count cap, so hundreds of ordinary successful idle sessions cannot block a new session.

`AgentSessionIndexDurableObject` stores no turns, task content, event payloads, or approval arguments. Summary pages hold
100 revision-stamped entries and listing returns at most 100 current summaries. Pending/running projections enter
append-only 100-entry work queue pages; a full page atomically spills to a new page instead of rejecting an already
accepted task. Polling cleans stale revision entries from at most four pages and orders candidates by exact retry claim,
then oldest task creation time and session ID. The coordinator atomically issues one opaque token bound to the runtime,
client retry claim, exact session/task, source revision, and expiry. The shard validates that grant back against the
coordinator before lease CAS, so absent, forged, expired, wrong-runtime, wrong-revision, and cross-shard tokens fail closed
and racing claim IDs cannot lease multiple shards. Lease renewal first extends that same coordinator ownership; if the
coordinator cannot confirm it, shard renewal does not occur. Idle/archive detail is never scanned or transferred by polling.
Draining the final page normalizes the queue head and tail to one empty page before a later append, so accepted work
cannot be written behind the visible head.
Each shard also keeps a revision-stamped summary outbox; a failed coordinator update schedules a Durable Object alarm and
retries idempotently, so a committed session cannot remain permanently absent from summary or work indexes.

The production adapter treats the v2 singleton binding as a read-only migration source. Each list or lease request probes
and imports at most one legacy aggregate and advances a durable cursor. The import endpoint accepts the source's actual
positive revision, verifies a SHA-256 content digest, and can establish an empty shard at that exact revision. Every shard
stores an explicit migration source epoch plus source revision/digest watermark. Aggregate create, CAS, read, and import
use raw UTF-8 state bodies with metadata in bounded headers; escape-heavy valid state therefore stays below the transport
limit even when wrapping that state in another JSON envelope would exceed one megabyte.

After a digest-matched import, the singleton atomically retains its source in a migration slot, replaces the historical
v1 record with an invalid write-fence sentinel, and enables a compatibility facade that forwards legacy read/CAS/wait
calls to the authoritative shard. Worker versions that know the facade remain compatible; versions old enough to ignore
the fence fail closed on the sentinel and cannot create or CAS a split-brain record. **Once any session is fenced, do not
roll back to a Worker version predating this compatibility facade.** Re-upgrade reconciliation merges distinct turns,
tasks, approvals, events, and idempotency evidence from a pre-fence divergent lineage at a new monotonic revision;
conflicting reuse of append-only IDs or immutable approval identity/scope, or an over-budget merge, fails closed instead
of overwriting either lineage. Approval lifecycle merge is monotonic: denial, cancellation, revocation, and consumption
facts dominate pending or active grants and remain migration tombstones so a later lineage cannot restore authority.
An over-budget merge archives the exact legacy source plus bounded digest/revision/size audit metadata in that session
shard, retains the current branch, publishes a compact summary with work durably quarantined, records the migration
watermark, and advances the global cursor; one poison session therefore cannot block listing, migration, or leasing for
other sessions. Cancellation and terminal session/task facts are separately retained as monotonic tombstones. During a
divergent merge they dominate later active lineage, terminalize newly discovered active children, and prevent a later
CAS from recreating cancelled work even after aggregate compaction. Compatibility-facade writes always carry the exact
migration epoch, and the shard rejects stale facade epochs or any reversal of terminal facts. Re-upgrade retries
are idempotent. Keep all three bindings until reviewed migration evidence and the rollback-retention window permit a
later removal of the legacy class and retained migration source.

## Restore maintenance boundary

Host restore is a runtime-wide exclusion boundary, not an executor tool. The root maintenance marker prevents the
gateway from leasing another task; `SIGUSR1` lets the current `runOnce` drain before the host verifies the executor
journal is idle. Restore runtime-masks and stops `mc-agent-gateway.service`, `mc-agent-executor.socket`,
`mc-agent-executor.service`, and `minecraft.service` before profile or replacement changes, so a socket connection cannot
reactivate the executor or Minecraft. It stages the reviewed profile in the replacement directory, verifies and renames
that tree, commits the authenticated restore generation and journal, and only then unmasks services and exposes Minecraft
protocol readiness. Recovery rolls back precommit state but never a generation proven committed by the authenticated
restore floor.

Existing-host release activation uses a separate root-owned, content-addressed attempt journal. Its pre-state covers
all cooperating release destinations, setup links, agent configuration and runtime links, mutable profile/plugin
destinations, canonical world-root state, and exact unit enable/mask/active state. Rollback is attempt-scoped: a
no-transition failure does not invoke runtime rollback, global previous-runtime markers are never consumed, and a
changed link must still match this attempt before restoration. Commit requires bounded loopback Minecraft protocol and
plugin readiness plus functional expected executor, socket, and gateway endpoints; `Type=simple` active state is not
accepted as readiness. The outer command holds the canonical dual-protocol lifecycle fence before host mutation. A
durable boot marker plus systemd generator masks Minecraft, DNS, the executor socket/service, and gateway after power
loss; the recovery unit only reasserts the volatile gateway fence. The journal publishes exact service state before its
active pointer and uses one checksummed snapshot envelope with durable parent-directory publication and retirement.
Reruns validate and retire a matching commit or idempotently restore precommit state, starting only units recorded active.
Recovery executes in the trapping shell so a recovery failure retains the reconstructed journal/fence ownership and
enters the same fail-closed rollback path. Readiness captures the Minecraft log boundary before any service restoration,
functionally connects to an active executor socket (including socket-only activation), and restores candidate-started
Minecraft and DNS to their exact inactive pre-state. A same-AMI replacement rollout may explicitly adopt the outer
`host-replacement` maintenance owner; it keeps that exact durable operation and volatile fence through rollout, nested
restore, protocol readiness, receipt pinning, output persistence, and the outer commit boundary rather than creating an
unfenced handoff. Resume accepts only that explicit parent and leaves release to the outer renewable lifecycle owner. A
failed rollout or resume never clears an adopted parent hold or volatile fence, and both installers accept only that
exact `host-replacement` parent operation.
Failed or corrupt rollback retains the journal, durable marker, and masks rather than exposing a mixed generation.
Replacement-host orchestration binds the canonical lifecycle fence to a dedicated durable operation record and renews it
through every long CloudFormation, EC2, SSM, AMI, and health wait. Each generation is atomically recorded with the lock
before being fsynced locally. The protected SSM bridge includes its operation/owner identity so an exact rerun can finish
an interrupted initial binding, while generic expired-lock acquisition remains unable to cross `agentFenceActive`.
Preparation journals every backup, quiesce, stop, snapshot, change-set, and execution request boundary; immutable client
tokens/names make ambiguous snapshot and CloudFormation requests reconcilable. Crash recovery reconciles the exact owner
and latest generation. Before quiescence, expiry can roll back; after durable quiescence intent, recovery must physically
stop and freshly prove the old host stopped, terminated, or absent before a dedicated deterministic owner rotates the
protected lock and operation together. A retry can reconcile that exact owner and repair a stale compatibility mirror.
CloudFormation execution records and classifies the exact change-set status rather than inferring execution from stack
status. A completed CloudFormation rollback safely resumes the exact original host and terminalizes the operation as
rolled back. Nonterminal operation rows have no DynamoDB TTL; terminal rows that still carry lifecycle ownership also
remain TTL-free until exact reviewed cleanup. Compatibility cleanup retains every nonterminal row and every terminal row
whose authoritative DynamoDB lifecycle lock is still owned, regardless of stale compatibility-mirror state. Renewal ends only after the operation reaches a
durable committed or rolled-back terminal phase. Receipt-verifier publication treats the deployment manifest as the
authoritative checkpoint and idempotently reconciles every `=`, `:`, whitespace, and `export` dotenv assignment before
releasing the lifecycle fence. Standalone rollout promotes its lock to protected ownership and fsyncs a local
reconciliation checkpoint before host mutation, and the host retains its local maintenance barriers until verifier
publication succeeds. Manifest and checkpoint publication fsync their files and parent directories;
`reconcile-runtime-receipt` can finish local verifier reconciliation without host availability while deliberately
retaining host and lifecycle ownership for a later exact `rollout-runtime` completion. When verifier authority is new or
rotated, host release stops and disables agent units before removing maintenance barriers. After deploying the Worker
with the pinned verifier set, an exact unchanged-verifier rollout may re-enable those units.

## Local maintainer skill and release boundary

OpenCode and Codex discover the root `AGENTS.md`; Claude Code discovers `CLAUDE.md`. Both point to the one canonical,
developer-only `.agents/skills/mc-aws-agent-maintainer/SKILL.md`. `.agents/` is excluded from Next/OpenNext panel traces
and the EC2 runtime stage, and package validation rejects its path or unique content marker.

Review `git status`, focused diffs, `git diff --check`, validation results, compatibility, and provenance before handing
off. Do not run `pnpm release:prepare` from the skill: that command performs network and Git publication actions.
Recovery is fail-closed—discard contaminated local artifacts, correct the source/exclusion or restore the reviewed
bundle, rerun cloud-free checks, and report the failure. Deployment is always a later, separately approved operator
operation; extension readiness never authorizes cloud access, packaging into panel/EC2, or production changes.
