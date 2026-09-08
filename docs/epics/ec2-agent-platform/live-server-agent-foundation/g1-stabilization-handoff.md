# G1 stabilization handoff

**Snapshot:** `2026-09-08T19:21:44Z`  
**Status:** **implementation candidate — NOT release ready**  
**Scope:** bounded local checkpoint work only; no cloud, network, privileged, deployment, publication, or push action.

## Reviewed inputs and exclusions

- Baseline remains the G0 snapshot commit `e3723c2018e07fec60f1314bd755226732a0d4b3`.
- Current pre-stage inventory: 159 modified tracked paths and 221 untracked status entries.
- All prior implementation, source, tests, revised PRD/research/planning documents, runtime assets, and focused
  integration work in this tree were reviewed as intended checkpoint inputs.
- The local maintainer skill under `.agents/` and its `AGENTS.md`/`CLAUDE.md` discovery files are repository
  deliverables included in the follow-up checkpoint; they remain excluded from production artifacts.
- The unexplained zero-byte `3` remains untracked and preserved. Generated Python bytecode was cleaned during
  integration. Ignored local artifacts, real secrets, deployment-local
  manifests, binaries, caches, and generated archives remain excluded and were not read or staged.

## Bounded G1 work completed

- Applied repository formatting corrections and reduced the two lint complexity/format failures without changing the
  execution boundary.
- Corrected the fixed Drive-token broker request validation so caller-supplied parameter names and unknown fields are
  rejected before SSM access.
- Updated stale IAM, Cloudflare recovery, executor-receipt, service-inventory, and restore timing fixtures to match
  the reviewed contracts. Existing backup, world-root, restore, lifecycle, and authority protections were retained.

## Local evidence

| Gate | Result | Timing/evidence |
| --- | --- | --- |
| `pnpm typecheck` | PASS | 9s measured rerun |
| `pnpm check` | PASS | 4s measured rerun; 542 files and Lambda typecheck |
| `pnpm docs:check` | PASS | 1s measured rerun |
| Changed shell `bash -n` gate | PASS | 16 changed scripts |
| Extension/runtime/service focused tests | PASS | 27 tests |
| G1 backup/restore/world-root/host/runtime focused tests | PASS | 315 tests |
| Post-fix focused regression set | PASS | 172 tests; 98s measured rerun |
| `pnpm agent-runtime:check` | PASS | deterministic package; ignored local archive only |
| `pnpm host-release:check` | PASS | deterministic host package; ignored local archive only |
| `pnpm test:agent:e2e` | PASS | 15 tests, 3.31s; network-disabled local harness |
| `pnpm test` | **FAIL on first and only full run** | 369.17s; 186 files passed, 6 failed, 2,465/2,474 tests passed |

The full default test run's nine failures were bounded fixture/format/integration issues addressed above, plus one
restore subprocess test exceeding Vitest's default 5s under parallel full-suite load; its focused rerun passed after a
15s test-local timeout. The full suite was intentionally not rerun, so full-suite green status is not claimed.

## Remaining G0 decisions and gates

The following original G0 decisions remain open: exact activation/prerequisite/recovery/update-rollback path; whether
executable plugin installation is in this release; deployed agent/session/key/backup/external-consumer compatibility
obligations; an approved offline AL2023-compatible runner with service-manager/isolation/ARM64 evidence; and the
threat-model decision covering a compromised Minecraft process and authority transitions.

- **G2 gaps remain:** broad confined subprocess capability, packaged-production extension loading, supervisor/child
  credential and evidence separation, enforced OS confinement, and qualified narrow restart integration are not proven
  by this local batch.
- **G3 remains blocked:** no separately approved disposable offline AL2023-compatible or privileged runner was
  identified or started. The x86_64 development host cannot prove target ARM64, service-manager, namespace, or
  isolation composition. No production build, cloud lookup, deployment, host, or real provider operation was run.
- Deferred interrupted work remains deferred: installer activation qualification, packaged composition/failure matrix,
  compatibility inventory/migration decisions, plugin-install decision, resource measurements, and deployment/recovery
  expansion outside the selected path.

This handoff records local evidence for human review only. It is not G2/G3 qualification, a release approval, or
authorization for deployment or production action.
