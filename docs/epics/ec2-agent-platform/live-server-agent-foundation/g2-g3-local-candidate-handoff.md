# G2/G3 local candidate handoff

**Status:** implementation candidate, validation blocked; **not release-ready**. G2 has implementation additions but remains
unqualified. G3 has partial local evidence only. No deployment, production host action, cloud lookup, secret read,
service start, production build, Minecraft gameplay/resource measurement, or Git mutation is authorized by this
handoff.

This handoff records the current implementation against [the first-shippable PRD](prds/first-shippable-ec2-agent-foundation.md),
especially its section 3 authority model, section 7 execution/failure matrix, and G0-G5 gates. The files cited below
are the protocol and contract authorities; this document records what is present and what is still unproved rather
than restating those protocols.

## Reviewed implementation assets

The local candidate includes the following implementation additions and their intended boundaries:

| Area | Implemented assets | Local meaning, not qualification |
| --- | --- | --- |
| Shell runner | `agent-runtime/src/shell-runner.ts`, `shell-runner-server.ts`, `shell-runner-cli.ts`, `shell-client.ts` | Two one-request-lived Unix runners: `--read-only` and `--staged-write`; bounded `/workspace` execution, reviewed `/toolchain/bin/sh`, bounded output, process-group cleanup, and cgroup cleanup checks. Staged write produces only an untrusted regular-file replacement stage; it is not a general live write. |
| Toolchain contract | `agent-runtime/src/shell-toolchain.ts`, `shell-toolchain.test.ts` | Requires a root-owned exact-byte `linux-arm64` manifest and exactly one reviewed `sh` executable. No target `/etc/mc-agent/shell-toolchain.json`, `/opt/mc-agent/toolchain`, or ARM64 toolchain artifact is present in this checkout. |
| Runner units | `infra/src/ec2/mc-agent-tool-read.{service,socket}`, `mc-agent-tool-write.{service,socket}` | Unit/socket definitions describe separate credentialless read and staged-write services with private roots, no network, cgroup limits, inaccessible control paths, and a no-exec workspace/changes boundary. Static unit assertions are not running-service proof. |
| Executor composition | `agent-runtime/src/live-host-effects.ts`, `executor-cli.ts`, `infra/src/ec2/mc-agent-executor.{service,socket,json}` | The executor selects the fixed runner socket by shell mode, retains journal/receipt authority, and connects to the host broker only through the authenticated fixed socket. It does not grant shell children supervisor credentials or host-service authority. |
| Installer/layout | `infra/src/ec2/mc-agent-install.sh`, `mc-profile-install.sh`, `scripts/setup/build-agent-runtime.mjs`, `scripts/setup/build-host-release.mjs` | Installer and deterministic package inputs include the runner entrypoint, units, sockets, and runtime layout. They do not constitute an installed target or a successful production build. |
| Workspace DAC | `infra/src/ec2/mc-agent-workspace-dac.py`, `infra/src/ec2/minecraft.service` | Root-owned reconciliation grants the executor's dedicated workspace group controlled DAC access without changing Minecraft ownership; legacy `minecraft:minecraft` startup remains optional. Shared workspace DAC is not a Minecraft containment boundary. |
| Maintenance contract | `lib/agent/maintenance.ts`, `agent-runtime/src/live-host-effects.ts` | `maintenance.apply` is typed to `server.properties`, `motd`, exact pre/post byte identities, `restore-prior`, and a loopback protocol MOTD observer. It is not broad shell or arbitrary systemd control. |
| Host broker | `infra/src/ec2/mc-agent-host-broker.py`, `mc-agent-host-broker.{service,socket}`, `mc-agent-world-roots.service` | Root host authority adopts only the exact active invocation/backup fence, quiesces only `minecraft.service`, uses the existing world-root transaction, restores exact service intent, and independently observes MOTD through `mcstatus`. The credentialless console bridge supports only namespaced list/kick; list queries, and kick requires pre-query plus exact post-query absence. |
| Profile/plugin path | `lib/server-profile.ts`, `config/plugins.lock.json`, `infra/src/ec2/mc-profile-install.sh`, `tests/profile-install-script.test.ts` | Executable plugin installation remains a reviewed host/profile rollout concern, not an agent tool. Ordinary non-executable plugin configuration edits remain in scope. New or changed plugin entries require the actual exact byte identity; digest-only entries are legacy-installed compatibility only. The checked-in profile lock is empty, so no plugin bytes may be invented. |
| Durable task disposition | `agent-runtime/src/gateway.ts`, `lib/agent/runtime/service*`, `lib/agent/runtime/validation*` | Terminal publication carries `taskDisposition` and preserves the distinction between continuing and terminating the task/session. This is publication/recovery authority, not effect truth. |

The implementation was committed and pushed in the following modules:

| Commit | Module |
| --- | --- |
| `7eec9dc` | Reviewed packaged data-only extension loading |
| `7e8ec0e` | Authenticated invocation publication before task continuation; real Pi offline regression |
| `4ec3866` | Coherent shell, principal separation, lifecycle inventory, maintenance/console and reviewed artifact boundary |
| `f4837f3` | Exact shell/maintenance approval presentation and explicit plugin unavailability |
| `5f57f24` | Actual local workerd/Durable Object publication fixture |
| `6086531` | Workspace-group read access for the read-only mounted shell runners |

The shell and host-maintenance implementation share installer ownership, workspace permissions, lifecycle inventories
and executor capability consumers; they were committed together rather than publishing an internally inconsistent
principal/service transition. No AWS resources, credentials, deployment state or real profile players were changed.

## Principals, entrypoints, and shared authority

The PRD's principal split is retained. The exact implementation entrypoints are:

- **Portal/control plane:** owns task intent, policy, exact approval, lease identity, backup authorization, and durable
  publication. It is represented by the runtime/control contracts and `AgentRuntimeGateway`; it does not delegate
  root or provider credentials to model output.
- **Harness gateway:** `agent-runtime/src/gateway-cli.ts` loads only the immutable installed extension release,
  connects the Pi adapter to the configured provider, and sends authenticated executor requests. Provider/runtime
  credentials remain gateway-side.
- **Trusted executor supervisor:** `agent-runtime/src/executor-cli.ts` and `protocol.ts` own effect entry, the
  authenticated journal, terminal receipt, and recovery classification. `taskDisposition` controls post-publication
  task continuation, never whether a host effect occurred.
- **Tool child:** `shell-runner-cli.mjs` is reached only through the fixed socket-activated runner services. The child
  receives the approved workspace and fixed environment/toolchain, not supervisor evidence, journal keys, provider
  credentials, AWS metadata, or host control sockets. `staged-write` is a bounded stage for a later typed commit; it
  does not permit broad live writes.
- **Existing host maintenance authority:** `mc-agent-host-broker.py` owns the narrow MOTD transaction and namespaced
  console bridge. `mc-agent-world-roots.py`, the existing backup fence, and the host-operation verifier remain the
  authorities for world-root publication, backup identity, and durable effect state.
- **Minecraft process/plugin code:** untrusted. Compromised Minecraft/plugin containment is required: workspace DAC
  must not be confused with isolation, and the service must not reach executor credentials, evidence, or control
  channels. Root/kernel compromise is explicitly outside the guarantee. The assembled process, filesystem, descriptor,
  socket, and environment boundary has not yet been proven on the target runner.

The supported transition is control-plane exact authorization and reservation -> gateway handoff -> executor
reservation/effect journal -> typed shell or host-broker effect -> authenticated terminal evidence -> idempotent
control-plane publication -> exact fence release. Unknown effect truth retains exclusion and is never blind-retried.
Maintenance specifically adopts the caller's active fence, does not wait for executor idle, and never accepts a
caller-selected service/path/socket authority. These ownership rules are implemented across the cited files; the
assembled transition still needs one-candidate runner evidence.

## Release-scope decisions

- **Existing-host rollout:** the selected path is the existing-host `host:upgrade rollout-runtime` flow with explicit
  agent enablement, not a replacement-host or rebuild expansion. Existing release journal, lifecycle ownership,
  precommit rollback, and uncertain-recovery exclusion remain in force. Exact operator configuration and recovery
  qualification remain G3/G5 work.
- **Unknown legacy obligations:** deployed versions, persisted sessions, retained keys/backups, migration/facade
  consumers, and external compatibility obligations are not known from this local tree. Preserve the existing legacy
  machinery and do not remove or silently migrate it.
- **Plugins:** configuration edits are in scope. Executable plugin installation is only through the separately reviewed
  host/profile rollout path; it is not available through ordinary agent tools or extension bundles. New/changed lock
  entries must carry actual bytes and digest identity. Existing digest-only entries are accepted only when the already
  installed artifact matches; no fabricated size is acceptable. The current empty `config/plugins.lock.json` is not
  evidence of plugin-install qualification.
- **Compromised Minecraft:** containment is a release requirement, not an implied property of the shared workspace
  group or of a successful unit-string test. The target composition must demonstrate that Minecraft/plugin code
  cannot read supervisor/provider credentials or reach evidence/control channels.
- **Operator reconciliation:** the supported broker command is exactly
  `sudo /usr/local/bin/mc-agent-host-broker.py --reconcile-agent-maintenance <invocation-id>`.
  It reconciles the retained exact operation and must not replay the effect. A retained marker is evidence and must
  not be deleted to make the host appear idle. If the retained marker is missing, the existing outer-terminal/manual
  reconcile path cannot prove the operation's identity or outcome; report that as a recovery gap, not as no effect.
- **No resource guarantee:** no instance-size, memory-headroom, gameplay-impact, or production resource claim is made.
  The PRD resource row remains open until measured with Minecraft running.

## Gate progress

| Gate | Current status | Boundary |
| --- | --- | --- |
| G0 | **Incomplete: runner/artifact inventory pending** | The selected scope and authority direction are recorded, but the approved disposable AL2023-compatible ARM64 runner, exact target artifacts/toolchain, and their acquisition/authorization record are absent. |
| G1 | **Local integrated gates pass** | All final repository gates below passed on committed implementation `5f57f24`; installed activation remains unqualified. |
| G2 | **Implementation additions; unqualified** | Shell, staged-file transport, DAC helper, broker, maintenance types, disposition publication, and installer/unit assets exist. Broad confined shell, Minecraft-side containment, and effective destructive authorization are not proven by local mocks or assertion methods. |
| G3 | **Partial local evidence only** | Offline Pi/executor and local workerd/DO evidence exist as separate fixtures. No single approved target runner has exercised the packaged runtime, real service manager, isolation, maintenance, crash/recovery, and resource composition. |
| G4 | **Not started as final composition review** | Do not freeze or conduct the final full composition review until the target runner/build evidence exists. |
| G5 | **Not deployment** | No production or deployment authorization is implied. |

## Section 7 matrix: fixture evidence and missing target-runner evidence

Every row below names the strongest current local fixture/test anchor, the expected result, and the evidence still
missing on the same candidate runner. A fixture result is not silently promoted to target qualification.

| PRD section 7 row | Fixture/test anchor | Expected local outcome | Missing target-runner evidence |
| --- | --- | --- | --- |
| Product outcomes | `tests/agent-local-vertical-slice.test.ts` — `inspects, pauses for exact approval, backs up, edits, runs console, replays, and completes locally`; `agent-runtime/src/shell-runner.test.ts` — `runs a real local POSIX composition...`; `tests/mc-maintenance-broker.test.ts` — MOTD and namespaced console cases | Local typed flow proves approval/evidence sequencing, real local subprocess plumbing, narrow MOTD semantics, exact player query/kick behavior, and non-replay classifications. | Real packaged server behavior on the target runner: useful composed shell, same-server setting/restart, actual Minecraft observer, and gameplay/resource effect. |
| Packaged composition | `tests/agent-runtime-package.test.ts` — package/socket inventory and deterministic package tests; `tests/agent-runtime-services.test.ts` — service boundary tests; `agent-runtime/src/shell-client.test.ts` — one-request socket framing | Release inputs, units, credentials lists, socket paths, and protocol framing reject malformed/static mismatches. | Built package installed into an actual target root; real systemd socket activation; supervisor and real child process; effective mounts, descriptors, credentials, and service sandbox verified at runtime. |
| Harness/provider | `tests/agent-offline-provider-composition.test.ts` — `uses real Pi to inspect, obtain exact approval, and write sequentially through one authenticated executor`; `tests/fixtures/agent-offline-provider/scripted-transport.ts` | Real Pi registration consumes scripted SSE/tool translation and drives an `ExecutorProtocolServer`/`ExecutorProtocolClient` Unix socket over the local test host, performs the approved local write, emits no external network attempt, and keeps provider canaries out of events. | Same packaged gateway/runner candidate on the approved service-manager runner with offline transport injection and recorded enforcement; no real provider is required or authorized. |
| Control plane | `tests/agent-worker-composition.test.ts` — `publishes one approved tool result with taskDisposition continue and replays authoritative events`; `tests/fixtures/agent-worker/{worker.ts,wrangler.jsonc}` | Actual local Wrangler/workerd HTTP fixture binds the three Durable Object classes, crosses HTTP transport, verifies bearer auth, stores/replays events, and accepts a fixture-signed terminal receipt. The terminal result explicitly records `executorEffect: false`: this is control-plane publication evidence, not executor evidence. | Production transport/configuration and cross-process composition on the same candidate; Worker-side and executor-side evidence must remain separately attributed. Workerd OS egress is explicitly `not-qualified` by the fixture. |
| Backup integration | `tests/mc-backup-auth.test.ts`; `tests/mc-backup-restore-contract.test.ts`; `agent-runtime/src/runtime-backup.test.ts` | Typed exact-bound backup authorization, local archive/restore contracts, fence ownership, and indeterminate/retry rules reject replay and preserve exclusion in fixtures. | Actual local backup/archive effect and restore verification on the target runner, with the offline provider endpoint and no real Drive/cloud account. |
| Install/activation | `tests/host-release-contract.test.ts`; `tests/profile-install-script.test.ts`; `tests/agent-runtime-services.test.ts` — activation/rollback and service inventory cases | Manifest-driven assets, installer inputs, repeated/rollback contract paths, config reconciliation, and service definitions are checked statically/fixture-backed. | Target ARM64 build and install, service readiness, socket-only activation, process restart, exact existing-host rollback, and operator-configured activation on the packaged target. |
| Isolation | `tests/agent-security-adversarial.test.ts`; `tests/agent-runtime-services.test.ts`; `tests/mc-agent-workspace-dac.test.ts`; `agent-runtime/src/shell-runner.test.ts` | Local adversarial policy/path checks, DAC symlink/hard-link rejection, and shell cleanup/output bounds fail closed without touching sentinels. | Actual process/filesystem/descriptor/link/process-visibility checks from tool child and Minecraft-side code against credentials, evidence, control sockets, metadata, forbidden paths, inherited descriptors, and network; actual `NoNewPrivileges`, mounts, cgroups, and namespace enforcement. |
| Dispatch crashes | `agent-runtime/src/protocol.test.ts` — reservation/dispatch/effect-entry crash and uncertain console cases; `agent-runtime/src/executor-journal.test.ts` — in-flight/terminal recovery cases; `tests/mc-maintenance-broker.test.ts` — `retains exact intent and barriers across root-process death at effect entry` | Recovery distinguishes reserved/not-started from entered/unknown, retains the fence, and does not duplicate an uncertain host effect. | Kill/restart at each real target service boundary before/after reservation, dispatch, and host effect entry; count actual Minecraft/file effects and prove one-effect recovery. |
| Publication crashes | `agent-runtime/src/protocol.test.ts` — receipt/publication response-loss cases; `agent-runtime/src/executor-journal.test.ts` — committed-without-receipt/replay cases; `tests/agent-worker-composition.test.ts` — duplicate recovery publication | Durable terminal evidence remains replayable, publication is idempotent, and `taskDisposition` controls continuation without changing effect truth. | Actual packaged executor/gateway/control-plane process restarts, terminal persistence, publication/ownership-release/acknowledgement loss, and exact recovery on the target runner. |
| Authority changes | `tests/agent-security-adversarial.test.ts`; `agent-runtime/src/protocol.test.ts`; `tests/mc-host-operation-contract.test.ts` | Expired/revoked approvals, stale identities, cancellation, lease loss, and missing/indeterminate journal authority fail closed before unsafe effect or prevent redispatch. | Same races through actual socket/systemd/process boundaries, including renewable fence loss immediately before target commit and Minecraft-side attempts while authority changes. |
| Maintenance | `tests/mc-maintenance-broker.test.ts` — exact MOTD edit, service restoration, marker retention, crash, protocol unresolved, and namespaced list/kick cases; `tests/mc-maintenance-persistence.test.ts`; `tests/agent-world-roots.test.ts` | Broker tests cover signed active authority, Java-properties semantics, exact service intent, world-root transaction, independent observation, retained marker/no auto-retry, and operator reconciliation shape. | Actual `systemctl`, `runuser`/`screen`, `mcstatus`, world-root service, backup fence, and Minecraft protocol on the target runner; interrupted maintenance/reboot/idle-shutdown and selected rollout races. |
| Resource exhaustion | `agent-runtime/src/provider-response-guard.test.ts`; `agent-runtime/src/shell-runner.test.ts` — `stops a byte flood...`; `agent-runtime/src/executor-journal.test.ts` — bounded terminal capacity; response-limit and state-limit tests | Provider/body/SSE, shell output, journal terminal, response, replay, and state bounds fail closed with recoverable evidence. | Combined Minecraft-running workload with actual RSS/disk/process/runtime ceilings, slow consumer, model/tool loop, disk-full, process/memory exhaustion, latency, and gameplay impact measurements. |

## Runner/artifact blocker and planned evidence

The exact namespace prerequisite was attempted only as a read-only local check:

```text
/usr/bin/unshare --user --map-root-user --net --pid --fork --kill-child=KILL --mount-proc -- /usr/bin/true
-> write failed /proc/self/uid_map: Operation not permitted
```

The current development host is x86_64. No approved target ARM64 AL2023 runner/image is available in this local
candidate, and no production build was attempted or retried with broader privilege. In particular, the current
`assertRuntimeSandbox`/`assertShellRunnerSandbox` methods and service tests are runtime assertions/configuration
contracts; they are not evidence that the actual runner service is sandboxed. There is no production service, live
Minecraft gameplay, or combined resource evidence.

The missing runner must be separately identified and authorized, not provisioned by inference. Required capabilities
are: disposable offline AL2023-compatible ARM64 execution (or explicitly documented emulation limits); real systemd
unit/socket activation; user/mount/PID/network namespaces; cgroups and process cleanup; DAC, no-new-privileges,
capability, descriptor, and inaccessible-path enforcement; offline-only test-local transports; and reboot/crash control.
Required reviewed artifacts are the exact runtime archive and manifest, host-release archive and manifest, pinned
ARM64 Node/Pi inputs, the exact root-owned shell toolchain plus `/config/shell-toolchain.json`, all referenced units,
helpers, configs, world-root/backup fixtures, and the reviewed profile/plugin lock. No provisioning authorization is
assumed, and no network acquisition should be performed implicitly.

The nonempty reviewed plugin fixture exposed a five-field/four-field TSV producer/consumer mismatch. That bounded
integration defect was corrected before `4ec3866`; local fixtures now cover nonempty installation, repeated exact
reconciliation, digest/size mismatch, and legacy installed-artifact compatibility. The actual profile lock remains
unchanged. This is installer evidence, not a running plugin or a target rollout qualification.

## Final local evidence

The final complete local gate ran on the unchanged committed implementation:

- HEAD: `5f57f24de12f951bc853f66e906e565dc7c4fce4`.
- Tree: `a6febde0e8e6672ebae5ccabee7715a29f2ed87f`.
- Logs: `.local-artifacts/final-gate-5f57f24/`.
- No test/build/cleanup process was running before or after the gate.
- Unexplained zero-byte `3` remains untracked, with SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
  Test-generated `infra/src/ec2/__pycache__/` remains untracked and excluded from commits.

| Command | Result | Wall time |
| --- | --- | ---: |
| `pnpm check` | PASS; 563 files and Lambda check | 4.186s |
| `pnpm typecheck` | PASS | 11.381s |
| `pnpm docs:check` | PASS | 0.576s |
| `pnpm test` | PASS; 200 files, 2,547/2,547 tests | 324.141s |
| `pnpm test:agent:e2e` | PASS; 2 files, 15/15 tests | 3.597s |
| `pnpm agent-runtime:check` | PASS | 2.907s |
| `pnpm host-release:check` | PASS | 1.816s |

Final local package identities:

- Agent runtime: 12,290,197 bytes;
  SHA-256 `4e72c1711a7c693d4981410586a5b501950435c007b7f7051de4571dfddfaadc`.
- Host release at that full-suite snapshot: 12,957,444 bytes;
  SHA-256 `e14e4b6a352b1d2088a49e2a26ee71f1b1a3ae3b7706a819d9302e38049152be`.

A final bounded DAC correction (`6086531`, tree `2cd3dff4f882b0b7e10cd20c6e417cf497af4351`) grants
the tool principal the workspace group in both installer and runner units. This lets it read group-protected
Minecraft files through the existing **read-only** bind mount; it adds no credential/control-socket group and does
not grant a live writable mount. Without that group, newly created Minecraft files under `UMask=0007` would be
unreadable to shell children. The affected service/DAC/runner suite passed 31 tests in 1.487s. This service-only
correction did not trigger another full-suite run.

Final incremental checks on `6086531` passed: `pnpm check` (4.58s), `pnpm typecheck` (13.37s), `pnpm docs:check`
(0.70s), `pnpm agent-runtime:check` (3.03s), `pnpm host-release:check` (1.78s), installer shell syntax and
`git diff --check`. Runtime bytes/digest above are unchanged. The **final host release** is 12,957,538 bytes,
SHA-256 `8a48d9c5513b0f2624194d6881cd2a89a5cabc554c427bc50d7335bc2947a3ec`.

Changed shell/Python syntax and diff-whitespace checks passed during integration. Documentation added after the
committed-source gate receives a separate docs/whitespace check; it does not change the runtime package inputs.
GitHub reported no workflow runs for this branch when queried; remote CI success is not claimed.

Earlier validation is retained as history, not substituted for the final result: the initial committed checkpoint
passed 2,474 tests; a delegated unintended full run hit a 120-second tool timeout and produced no full result; the
first planned integrated run failed on capability/unit/DAC fixtures and an outdated E2E transport; bounded fixes
closed those failures. A later complete run passed 2,545 tests before the final nonempty-plugin fixture correction.
The final 2,547-test run above is the evidence for committed source. No concurrent full-suite runs were used.

## Next authorized dependencies

The local implementation and deterministic gates above are complete for this slice. Remaining acceptance work is
not represented as more local mock tests or an unrestricted audit:

1. Identify and authorize the disposable target-like runner and its exact image/artifact acquisition. Do not use
   privileged setup or weaken isolation merely to make the current machine pass.
2. Supply or approve acquisition of the reviewed ARM64 shell toolchain, including exact bytes, digest, license/source
   evidence and useful applet composition. The source manifest/loader intentionally cannot manufacture this artifact.
   The selected installation must inventory and retain that toolchain together with its approved configuration.
3. Prepare the offline Minecraft/profile fixtures and query configuration. Namespaced player observation requires
   working loopback query with an exact player list; do not invent real authorized players or mutate a real whitelist.
   A real executable plugin candidate needs its reviewed artifact identity and fresh startup readiness evidence.
4. Exercise the section 7 matrix on that single installed candidate, including interrupted maintenance recovery,
   actual process containment and combined Minecraft resource measurements. Only then perform G4/G5 qualification.

Until those dependencies and outcomes are qualified, the release label remains **implementation candidate,
validation blocked**, not release-ready.
