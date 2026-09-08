# G2 extension loading handoff

**Date:** 2026-09-08  
**Status:** implementation candidate, validation blocked  
**Authority:** The revised first-shippable PRD remains authoritative. This is a bounded G2 slice, not gate completion.

## Inputs and scope decisions

- Starting HEAD: `c675992a6bf0981dc0a2c4a3b5d73a98171e060a`; tree:
  `490b0f7ce9326b8266d3df15c8b74f2d8a3f49e2`.
- Starting worktree had only untracked zero-byte `3`. Its SHA-256 is
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`; it remains untouched.
- User delegated activation-path selection. Selected existing-host complete host-release
  `host:upgrade rollout-runtime` with explicit agent enablement, not a replacement/rebuild expansion.
  Prerequisites include matching maintenance guards, reviewed artifacts/configuration/credentials,
  lifecycle ownership and reconciled idle executor state. Retain journaled precommit rollback;
  uncertain recovery retains exclusion. No automatic postcommit rollback guarantee is added.
  Exact operator configuration and recovery runbook still require G3/G5 qualification.
- User does not know deployed-agent compatibility obligations. Preserve existing migration, keys,
  state, backup, infrastructure and ownership protections; no compatibility removal is justified.
- User prefers executable-plugin installation in scope. Plan one reviewed artifact/maintenance path;
  installation remains unavailable until implemented and qualified. Configuration edits remain in scope.
- User explicitly requires compromised Minecraft/plugin containment from provider/supervisor
  credentials, evidence and control channels. Shared UID is not a boundary. Root/kernel compromise
  is excluded. The concrete asset/entry-point/authority-transition design remains required before
  generalized shell or shared-protocol changes.
- Offline runner qualification is deferred. Another machine may be available, but no specific runner,
  image, ARM64 artifacts, acquisition or privileged operations have been qualified or authorized here.
- No cloud, infrastructure destruction, deployment, download, secret-management, commit or push was
  performed. A Google Drive backup report is not treated as verified restore evidence.

## Implemented slice

- Generic production registry loading from protected installed runtime-relative bundle paths, with
  bounded input, provenance/integrity validation and existing capability schema enforcement.
- Omitted extension configuration defaults disabled; the reviewed packaged configuration explicitly
  enables the sample. Workspace-driven executable extension loading remains unavailable.
- Validated tool aliases pass through existing executor capability, policy and approval enforcement;
  skill guidance reaches the harness without a sample-specific Pi or portal branch.
- Inert hook references map only to trusted mc-aws behavior. Read hook output is a non-authoritative
  display projection; authenticated executor results remain unchanged for publication and replay.
- Deterministic runtime packaging includes the sample assets; profile reconciliation preserves the
  extension configuration, and package/service inventory tests cover the added assets.

Focused inspection identified a slice-local error: applying hook evidence to an authenticated result
before terminal publication would change receipt-bound truth. The correction preserves the original
result and adds an authenticated Unix transport regression:
`publishes and replays the original receipt when an enabled hook adds only display evidence`
in `agent-runtime/src/protocol.test.ts`. No terminal-publication protocol redesign was introduced.

## Local evidence

The one full suite ran **before** this slice, on unchanged `c675992`: `pnpm test` passed 192 files and
2,474/2,474 tests in 306.93s wall time (Vitest 305.79s). Log:
`.local-artifacts/pnpm-test-c675992-20260908.log`. No integration failures needed fixing.
The suite generated `infra/src/ec2/__pycache__/mc-agent-world-roots.cpython-312.pyc`, left untracked.

Final code-slice checks were serial; the full suite was not rerun after edits:

| Check | Result | Elapsed |
| --- | --- | --- |
| Focused extension/config/gateway/protocol/package/service Vitest | 147 tests, 7 files passed | 16.92s |
| `pnpm typecheck` | PASS | 10.76s |
| `pnpm check` | PASS, 545 files plus Lambda check | 3.74s |
| `pnpm agent-runtime:check` | PASS | 2.72s |
| `pnpm host-release:check` | PASS | 1.75s |
| `pnpm test:agent:e2e` | PASS, 15 tests | 3.35s |

Focused command:

```sh
pnpm exec vitest run agent-runtime/src/extensions.test.ts agent-runtime/src/gateway-config.test.ts agent-runtime/src/gateway.test.ts agent-runtime/src/protocol.test.ts lib/agent/extensions.test.ts tests/agent-runtime-package.test.ts tests/agent-runtime-services.test.ts
```

Final runtime archive: 12,241,575 bytes; independently checked SHA-256:
`9500314d0f57c8d380b7f9d89df2be87b3acd5d262c9ca7ef3c85241dcf178db`.
This identifies a local package, not ARM64 execution or installed-system qualification.

The build prerequisite command exactly matched the production namespace arguments:

```sh
time /usr/bin/unshare --user --map-root-user --net --pid --fork --kill-child=KILL --mount-proc -- /usr/bin/true
```

It failed in 0.004s with `write failed /proc/self/uid_map: Operation not permitted` on Linux x86_64.
No production build was attempted, no privileged retry occurred, and isolation was not bypassed.

## Remaining gates

- G0: finish explicit authority-transition design, runner/artifact matrix and recovery/operator details.
- G1: current committed integrated suite is green; installed activation remains unqualified.
- G2: generalized confined subprocesses, supervisor/child and Minecraft-side containment, effective
  writable-shell destructive authorization, narrow maintenance/restart with independently observed
  Minecraft results, and reviewed executable-plugin installation remain missing.
- G3: prove the actual packaged extension invocation alongside the other product/failure scenarios
  on an approved offline service-manager runner. Current unit/Unix transport/package checks do not
  establish installed service behavior, ARM64 compatibility, crash safety or live Minecraft outcomes.
- G4/G5: no frozen final candidate review or release-ready handoff is claimed. Changes are uncommitted.

Next implementation priority is one owner for the confined subprocess/authority boundary design,
followed by its bounded implementation and narrow maintenance integration. Parallel work must remain
independent leaves. Do not reopen platform-wide recovery auditing or remove compatibility machinery.
