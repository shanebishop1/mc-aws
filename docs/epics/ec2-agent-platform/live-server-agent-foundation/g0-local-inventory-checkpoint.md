# G0 local inventory checkpoint

**Snapshot:** `2026-09-08T17:57:30Z`
**Scope:** local inventory only; no cloud, network, privileged, deployment, or Git mutation was performed.

## Frozen input identity

- Baseline commit: `e3723c2018e07fec60f1314bd755226732a0d4b3`
- Baseline tree: `3353135f92f03661204f3eaa08993fa220e074ce`
- Worktree at capture: 161 modified tracked paths and 224 untracked paths (385 status entries with
  `--untracked-files=all`).
- Hashed inputs exclude secrets and generated artifacts. The digest record is
  `status<TAB>repo-relative-path<TAB>byte-count<TAB>sha256<LF>`, sorted by path; the recorded digest is
  SHA-256 of the concatenated records. File contents are not included in this document.

| Input set | Files | Manifest SHA-256 |
| --- | ---: | --- |
| Modified tracked inputs | 161 | `9a016ab5a01cd74c703fb41a8a8a688a901928ab2ede9e9049e88fa92856be6e` |
| Non-generated untracked inputs | 219 | `2ce5040e3060b27803a0c45b45d2efe406422933dbd61650b11bf043b7c5b2dc` |
| Combined input record | 380 | `776d957aff360aed0fd1cb30f0c272b4d8e42eeace8375d3f093aa796f92737d` |

## Unresolved input classification

- `infra/src/ec2/__pycache__/*.pyc` (4 files) are ordinary CPython bytecode artifacts. They are generated-cleanup
  candidates, excluded from the input digest, and were not deleted.
- Untracked `3` is a zero-byte regular file with no established repository meaning. It is not safely classifiable as
  generated or disposable; preserve it for its owner and exclude it from any commit until identified. No user data
  was deleted.
- No status-listed secret file was read or hashed. Ignored local secret/state paths remain outside this inventory and
  must not be staged.
- The current host is Ubuntu `x86_64`; local `systemd-analyze`, Docker, Node `22.19.0`, pnpm `10.30.3`, and Python
  `3.12.14` are present. Presence of these tools is not runner or isolation evidence.

## G0 questions still open

1. Which exact activation path, prerequisite state, recovery procedure, supported update/rollback boundary, and
   operator configuration are selected?
2. Is executable plugin installation in this release, and what reviewed path would own it? Until decided and qualified,
   tools and UI must continue to state that it is unavailable.
3. Which deployed agent versions, persisted sessions, retained keys/backups/lifecycle records, and external consumers
   require preservation? Persisted compatibility is **not known** from this local tree; migration/facade/lineage removal
   is not justified.
4. Which approved offline AL2023-compatible runner can provide the target service manager, isolation features,
   ARM64/reproducibility evidence, and any separately authorized privileged operations?
5. What threat-model statement covers a compromised Minecraft process and the final asset/principal/authority
   transitions? No local description substitutes for that decision.

## Gate status

- **G2 gaps remain:** broad shell is not satisfied by a four-operation inspection dispatcher; extension registry/schema
  validation has no demonstrated packaged-production load path; supervisor evidence/credentials separation and OS
  confinement are not proven by mocks or string-based service tests; narrow restart integration is not qualified.
- **G3 is blocked:** no approved disposable offline AL2023-compatible runner or privileged-runner authorization was
  identified, and none was provisioned or started. The current x86_64 development host cannot by itself prove the
  target ARM64/service/isolation composition. No artifacts were acquired over the network.
- No G2 implementation or audit reopening was performed. No validation suite was run under this G0-only scope.

## Bounded G1 recommendations

These are reproducible candidates, not claims that a failure was reproduced in this checkpoint (tests were intentionally
not run):

| Bounded task | Local reproduction anchor | Current disposition |
| --- | --- | --- |
| Backup syntax/contract correction | `infra/src/ec2/mc-backup.sh`; `tests/mc-backup-restore-contract.test.ts` | Actionable as one focused fixture/test failure; record the failing invocation before changing syntax. |
| Active-fence/operation-authority correction | `lib/agent/runtime/*`; `agent-runtime/src/gateway.ts`; `infra/src/ec2/mc-host-operation.py`; focused runtime/host-operation tests | Actionable as one serial, invariant-preserving local reproduction; one owner must control shared authority changes. |
| World-root/restore integration | `infra/src/ec2/mc-agent-world-roots.py`; `infra/src/ec2/mc-restore.sh`; `tests/agent-world-roots.test.ts`; `tests/mc-restore-script.test.ts`; `tests/mc-maintenance-persistence.test.ts` | Actionable as one fixture-backed integration task with one owner; retain existing root, backup, and rollback protections. |
| Installer activation | `infra/src/ec2/mc-agent-install.sh`; agent service/socket/config files; `tests/agent-runtime-services.test.ts` | Not activation-reproducible under current authorization; defer qualification until the G3 runner is approved. |

Recommended order is serial: reproduce one backup case, then one authority case, then world-root/restore integration;
do not resume parallel shared-protocol work or infer a fix from static code presence.

## Future commit inclusion/exclusion inventory

- **Include for this checkpoint only:** this file, if and when a human chooses to stage it.
- **Exclude:** all 161 pre-existing tracked modifications and all 219 non-generated untracked candidate inputs; they are
  frozen review inputs, not an authorized G1 patch. This includes runtime, control-plane, infrastructure, UI, tests,
  PRD/research, and extension files.
- **Always exclude:** the four `__pycache__` bytecode files, untracked `3`, ignored secrets/local state, and the local
  maintainer guidance under `.agents/` plus `AGENTS.md`/`CLAUDE.md` unless separately approved as maintainer changes.
- No commit was created. Cleanup was limited to classification; no file was removed.
