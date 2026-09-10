# ARM EC2 qualification handoff

**Snapshot:** 2026-09-10 disposable qualification artifacts  
**Status:** **qualification failed; implementation candidate, validation blocked**  
**Scope:** documentation of the user-authorized disposable EC2 shell-runner qualification only.

This handoff is the current evidence record for the disposable ARM64 EC2 attempt. It does not authorize another paid
run, production deployment, provider access, Minecraft qualification, a namespace bypass, or a full-suite gate. The
revised [first-shippable PRD](prds/first-shippable-ec2-agent-foundation.md), the canonical maintainer skill, and the
existing installer/runtime contracts remain authoritative.

Implementation modules are committed as `7959d680f61a788ed561a48d0bd8e695b98160c8` (toolchain, packaging, and runner
boundaries; tree `a0dec2a83763a445ff69a50fdc5fb1b6abdb81de`) and `7515fc1` (disposable lifecycle and shell probe).
The final local checks below ran against those source contents before their modular commits, not against a newly
qualified target. Documentation updates do not change the recorded runtime or host archive inputs.

## 1. Authorization and boundary

The user-authorized scope was account `096541555712` in `us-west-1`, using the authorized user transport. The
disposable hosts were not given role credentials. The recorded temporary per-run role and scheduler were lifecycle
plumbing only, not production authority.

The local records show the intended safeguards on every run: `t4g.medium`, encrypted 8 GiB `gp3`,
`deleteRootOnTermination: true`, `instanceInitiatedShutdownBehavior: terminate`, a temporary role, and a scheduled
termination deadline. Every manifest is `phase: cleaned`; the parent’s final read-only AWS reconciliation corroborated
that no run-owned instances, volumes, ENIs, security groups, key pairs, Scheduler groups, or prefixed IAM roles remain.
This cleanup result does not establish a zero billing total.

The host shell probe scope was only the two credentialless shell units. Every shell evidence manifest records:

```text
shellUnits: true
gateway: false
executor: false
hostBroker: false
minecraft: false
worldRoots: false
```

No namespace pass, shell behavior, Minecraft behavior, gameplay, resource, or release claim follows from these runs.

## 2. Final reviewed local package and last target package

The final post-review local package was built after the target attempts. It is the current reviewed package identity,
but it was **not installed or OS-tested on the target**. The last target-tested package was run 11’s package, listed
separately below; these identities must not be conflated.

| Artifact | Final reviewed local package | Last target-tested package |
| --- | --- | --- |
| Host release | `16,869,111` bytes; SHA-256 `f51863b7db19ed69c4ca80311211439c7f19e3857c3bff61ee56c0b8f7d92a66` | `16,861,436` bytes; SHA-256 `11f5a9b875d9a39b298179392cf6b9064cdc9c24a5f468465de5c80284ff4e53` |
| Release manifest | `14,628` bytes; SHA-256 `d35b41ce5113187261eb2a620950d3150e7893076246a20a028af8f2c2f61b63` | not separately recorded here |
| Embedded runtime archive | `12,302,346` bytes; SHA-256 `2d4e6470ee594f40c6b5c25a5e281b0e50903a280ce357d6c6692fa6c971bc15` | `12,300,885` bytes; SHA-256 `f66a88f3374dcea1efd73940230dcd392dda095359321bbf7c6e663a26268636` |
| Runtime manifest | `3,419` bytes; SHA-256 `4303f431668fd1ce501881efa9d18a1ae7a937d053b365e4a2df273f57fa8cc3` | same |
| Runtime bundle manifest | `8,449` bytes; SHA-256 `040c16b23b9317febed9ce028a35a1af3709495bfba6d1e51462556426cffb25` | `8,449` bytes; SHA-256 `7bb7b5d0ffd90673dab4969b9dda67f2ae524be18a1656db397858808b8448b0` |
| Node input | `22.19.0`, `linux-arm64`, `29,167,588` bytes; SHA-256 `0b2d9f564b6594222a62c82e1df2efe119dd4a4aff29644f4dd325bf360b6bcc` | same |
| Toolchain manifest | `2,678` bytes; SHA-256 `42995aec9022b04e5c11809347acbaa8b7150d9bd0d4da35a95ee3be8c2d312a` | `2,678` bytes; SHA-256 `dc2f42d78f390fcc6ee4ddde95b76d3158a5f5e324fb9694e35feda1dd3bd6ef` |
| Pinned toolchain lock | `294` bytes; SHA-256 `0abf0af10e87923383055304fdd167664e5a2dbab887db491e0c3e34ee5a3ffc` | not recorded |
| Toolchain `/bin/sh` | `1,127,576` bytes, mode `0755`; SHA-256 `a00157aada30be47277accd8f4ee8e93bbc55f3ac9722dd5e7008114d86a21c2` | same |

### Toolchain source and licensing boundary

The final toolchain manifest identifies BusyBox `1.38.0` source as `2,695,723` bytes with SHA-256
`34f9ea6ff8636f2c9241153b9114eefa9e65674a45318ae1ef95bb5f31c53bb2`, signed by fingerprint
`C9E9416F76E610DBD09D040F47B70C55ACC9965B`. The detached signature is `121` bytes with SHA-256
`a496ee9653bc7faa0fd159f171b257bb6df612018fd8e50be83d956c16107a5b`; the public key is `1,344` bytes with SHA-256
`41d0554e1abb52e962d52ed360181ca9def8876f512553dc660edd0a4a3cb160`.

The recorded build identity is GCC `13.3.0`, glibc `2.39`, and binutils `2.42`; BusyBox is `GPL-2.0-only`. The
manifest explicitly says `local-disposable-testing-only; public-distribution-blocked` and that static glibc
corresponding-source obligations are not staged. This toolchain is therefore local disposable qualification input
only, not a distributable or production release input.

## 3. Inventory of all 11 attempts

The rows are ordered by the manifest `createdAt`. Each row is a failed attempt even where cleanup or socket activation
completed. `deadlineEpoch` is retained in the source JSON; the times below are approximate recorded lifecycle walltime
from creation to manifest update, not launch-to-termination observations or AWS billing timestamps.

| Attempt / phase | Run ID | Instance / root volume | Created → updated (UTC) | Result |
| ---: | --- | --- | --- | --- |
| 1 / failed fixture | `f67e9110-6e70-4079-ac26-88e16547b4a6` | `i-03b3d26fb32508cdb` / `vol-0a76128c78ce102bc` | `02:25:48 → 02:47:54` | failed; no useful child-serving evidence |
| 2 / failed fixture | `da9d833f-a6d0-449d-ae83-0f9116a87f0f` | `i-0db264cd50cc3a7f2` / `vol-011c232524f4a6f91` | `02:48:20 → 02:56:32` | failed; installer toolchain step returned 0, qualification did not |
| 3 / failed fixture | `a60e9a8a-1050-4ddb-96c6-acde93b23130` | `i-08bfec2ceadbcb76c` / `vol-0b4ed87c8407863b5` | `02:56:59 → 03:04:40` | failed at static shell-unit verification |
| 4 / failed fixture | `ecf0d60f-b885-46c6-a7d0-4f4521752307` | `i-069983ef86b7b6a71` / `vol-0d3fcfeebe72a57cb` | `03:13:02 → 03:18:50` | failed; no child-serving evidence |
| 5 / failed fixture | `aa1270fe-8a86-40fd-8a77-89e0f59d2d8f` | `i-07bf656dcbfd82ced` / `vol-06d80e33f865ce368` | `03:28:23 → 03:37:20` | failed; sockets activated, child did not qualify |
| 6 / generic fail | `9f200b94-0915-406a-9f85-11f8e83faf5e` | `i-095b033c6fde0df2d` / `vol-0397d68e69624f6f8` | `04:11:58 → 04:57:07` | failed; bounded evidence retained no more specific safe code |
| 7 / sandbox | `924d9ed7-f207-4ba2-9d32-88bf9568b694` | `i-04701a864fd6cc8ab` / `vol-001fbd8013603e5ad` | `06:47:15 → 06:57:03` | failed during sandbox validation |
| 8 / launchfailure | `0a051822-9e1e-4462-a1b1-95904e368340` | `i-0d614c733db9f6bd5` / **not recorded** | `07:21:38 → 07:28:51` | failed while verifying the exact root volume; no root-volume ID was recorded |
| 9 / inaccessible-run | `6f663285-19aa-4ec9-af3c-d326b009eeaa` | `i-0edeca724980c2040` / `vol-02231180881689234` | `07:36:13 → 07:49:45` | failed; socket/listener evidence, no child-serving evidence |
| 10 / diagnostic tmpfs | `f027f99a-470c-49aa-a184-f07affc9b59f` | `i-06e8c66a6bb12cbb5` / `vol-0b31a3fb14b7d91f3` | `08:10:39 → 08:16:38` | failed with bounded `inaccessible-run` mount diagnostic |
| 11 / namespace226 | `be0b56f8-d333-45aa-af07-13d0f08563a7` | `i-0b79cdaaaddac16e1` / `vol-0cb9db363f9a6ad04` | `08:34:13 → 08:39:41` | failed with systemd exit `226/NAMESPACE` |

All eleven manifests are under `.local-artifacts/disposable-qualification/*.json`. The last target-tested values above
are from `be0b56f8-d333-45aa-af07-13d0f08563a7-shell-evidence.json`; final local identities come from the later package
build. Earlier runs used different host/runtime identities and must not be substituted for run 11.

## 4. Bounded phase evidence

- **Attempts 1–5:** These are recorded as failed fixtures. They establish repeated failed qualification attempts and
  cleanup records, not a passing matrix. Run 3's local telemetry retains the exact static diagnostics for both shell
  units: `Command /runtime/node-current/bin/node is not executable: No such file or directory`. Run 5 reached socket
  activation and then still failed qualification.
- **Attempt 6:** The safe result was a generic unavailable/qualification failure. Its evidence deliberately retains no
  raw secret-bearing error; do not manufacture a more specific root cause from the truncated terminal view.
- **Attempt 7:** The child reached the sandbox-validation path and failed there. The evidence records repeated
  `QualificationError` results and verified socket cleanup. This is not evidence that the namespace or sandbox passed.
- **Attempt 8:** The lifecycle manifest records `lastFailure.operation: verify exact root volume` and
  `awsCode: unavailable`. It is a launch/root-volume failure, not shell evidence.
- **Attempt 9:** The source phase is `inaccessible-run`. The bounded artifact records static diagnostics, socket start,
  generic runner-unavailable failure, and cleanup, with no successful request. The earlier RTK full tee reference is
  preserved only as an optional historical raw-log pointer:
  `/home/shane/.local/share/rtk/tee/1789026346_ssh_-i__home_shane__mc-aws-disposable_mc.log`. It is not copied into
  this repository and this handoff does not depend on that private absolute path.
- **Attempt 10:** The exact bounded diagnostic was:

  ```text
  mc-agent shell runner unavailable (sandbox-validation; sandbox=inaccessible-run; errno=none; run-root=filesystem-root; run-fs=tmpfs; run-access=rw; run-suid=suid; run-devices=dev; run-execution=exec).
  ```

  This is a finite enum diagnostic, not raw exception output. It reports a `tmpfs` `/run` view with unsafe observed
  flags; it does not prove a usable shell or a successful namespace.
- **Attempt 11:** The exact service result was `mc-agent-tool-read.service: Main process exited, code=exited, status=226/NAMESPACE`.
  No more detailed root cause was captured in the bounded local log. Do not bypass the failing namespace safeguard or
  classify this as a shell failure with a known root cause until a bounded fix produces stronger evidence.

In later attempts, including 9–11, both shell sockets reached a systemd listening state. The child nevertheless could
not serve a request. Socket listening is therefore not qualification, request-serving, namespace, or shell-behavior
evidence.

Startup diagnostics are intentionally finite: startup phases and sandbox phases are allowlisted, and errno values are
restricted to safe identifiers (`none`, `EACCES`, `ENOENT`, `ENOTDIR`, `ELOOP`, `EPERM`, `EIO`, `other`). Raw paths,
exception messages, environment values, and secrets are not part of the diagnostic contract.

## 5. Parent AWS cleanup reconciliation and cost envelope

The parent performed the final read-only check on 2026-09-10 UTC in account `096541555712`, region `us-west-1`.
The command prefix was the parent’s verified full AWS CLI path, represented below as `$AWS_CLI`; no AWS command was
run by this documentation pass:

```sh
AWS_CLI="/tmp/opencode/aws-cli-arm64-prep/bin/aws"
"$AWS_CLI" ec2 describe-instances --profile default --region us-west-1 --filters Name=tag:McAwsOwner,Values=mc-aws-disposable-qualification Name=instance-state-name,Values=pending,running,stopping,stopped,shutting-down --query 'Reservations[].Instances[].InstanceId' --output json --no-cli-pager
"$AWS_CLI" ec2 describe-volumes --profile default --region us-west-1 --filters Name=tag:McAwsOwner,Values=mc-aws-disposable-qualification --query 'Volumes[].VolumeId' --output json --no-cli-pager
"$AWS_CLI" ec2 describe-network-interfaces --profile default --region us-west-1 --filters Name=tag:McAwsOwner,Values=mc-aws-disposable-qualification --query 'NetworkInterfaces[].NetworkInterfaceId' --output json --no-cli-pager
"$AWS_CLI" ec2 describe-security-groups --profile default --region us-west-1 --filters Name=tag:McAwsOwner,Values=mc-aws-disposable-qualification --query 'SecurityGroups[].GroupId' --output json --no-cli-pager
"$AWS_CLI" ec2 describe-key-pairs --profile default --region us-west-1 --filters Name=tag:McAwsOwner,Values=mc-aws-disposable-qualification --query 'KeyPairs[].KeyPairId' --output json --no-cli-pager
"$AWS_CLI" scheduler list-schedule-groups --profile default --region us-west-1 --name-prefix mcaws-dq-group- --query 'ScheduleGroups[].Name' --output json --no-cli-pager
"$AWS_CLI" iam list-roles --profile default --region us-west-1 --query 'Roles[?starts_with(RoleName, `mcaws-dq-role-`)].RoleName' --output json --no-cli-pager
```

The recorded results were `[]` for each resource query: no active/stopped instances, volumes, ENIs, security groups,
key pairs, Scheduler groups, or IAM roles matching the required owner/name prefixes. All 11 local run records’ cleaned
state was corroborated. This confirms cleanup, but no billing API or invoice was read; actual bills remain unknown.

The manifests record a temporary scheduled shutdown deadline, intended as a 30-minute restriction, and each configured
root volume is 8 GiB encrypted `gp3`. The recorded `createdAt`/`deadlineEpoch` windows sum to approximately **5.764
hours** as a conservative upper-record envelope across the eleven attempts. This is not observed instance runtime, a
price, an invoice, or proof that every attempted instance ran for that window. The configured storage allocation is
11 × 8 GiB = **88 GiB** during the attempted runs; attempt 8 has no local root-volume ID, although the parent AWS check
corroborated that no matching volume remains.

Actual AWS bills are **unknown** here. Do not invent rates for `t4g.medium`, CPU credits, gp3, scheduler, networking, or
other services. Cleanup is corroborated, but a dollar total requires authoritative billing data.

## 6. Final local gate and package licensing

The final local gate logs are under `.local-artifacts/final-arm-local-gate/`. All listed checks passed; no new full
repository suite, worker suite, or code change was part of this final documentation update:

| Command | Result | Duration |
| --- | --- | ---: |
| `NODE_ENV=test pnpm check` | PASS | `3.604 s` |
| `NODE_ENV=test pnpm typecheck` | PASS | `10.053 s` |
| `NODE_ENV=test pnpm docs:check` | PASS | `0.788 s` |
| `NODE_ENV=test pnpm exec vitest run agent-runtime/src/shell-runner.test.ts agent-runtime/src/shell-runner-startup.test.ts agent-runtime/src/shell-toolchain.test.ts tests/agent-runtime-services.test.ts tests/host-release-contract.test.ts tests/profile-install-script.test.ts lib/server-profile.test.ts infra/lib/minecraft-stack.contract.test.ts` | PASS; 8 files, 142 tests | `14.736 s` |
| `NODE_ENV=test pnpm test:agent:e2e` | PASS; 2 files, 15 tests | `3.913 s` |
| `NODE_ENV=test python3 scripts/aws/test_disposable_qualification.py` | PASS; 9 tests | `9.179 s` |
| `NODE_ENV=test python3 scripts/aws/test_disposable_shell_qualification.py` | PASS; 20 tests | `0.674 s` |
| `NODE_ENV=test pnpm agent-runtime:check` | PASS | `3.371 s` |

The normal host package command, `NODE_ENV=test node scripts/setup/build-host-release.mjs package`, correctly exited 1
because the blocked-license toolchain lacks qualified corresponding-source obligations. The explicit
`NODE_ENV=test node scripts/setup/build-host-release.mjs package --local-disposable` command passed and produced the
final local package above. Its `packagingMode` is `local-disposable`; the toolchain manifest and pinned lock, per-file
size/digest bounds, and rollback-trap fixes are local-only post-target review evidence. They do not prove rollout,
installed-host operation, or target OS enforcement.

The final actual archive was also validated through the probe's pure extraction functions in fresh unprivileged
temporary directories: all 46 host members, nine toolchain files and reviewed lock, 45 runtime bundle members, and the
pinned Node archive passed. Staged Node reported `v22.19.0`. This check performed no service or namespace operation.

## 7. Historical source and test notes

Earlier engineering fixes included changing inaccessible metadata inspection from `stat` to `open`, checking staged
mount flags from `mountinfo`, and correcting root-relative paths and unit handling. Those changes improved diagnostics and
contract fidelity but did not qualify the assembled service. The final attempt reached `226/NAMESPACE`; no namespace
passing or shell behavior should be claimed.

Two unauthorized engineering full-suite attempts from a toolchain subagent timed out. They are historical process notes
only: no concurrency result and no full-pass result may be asserted from them. This was an engineering process
violation, not a user-authorized cloud operation. This handoff does not claim a current full-suite pass or use those
attempts as gate evidence. The historical normal full suite remains failed; no new full-suite rerun was attempted for
this final local gate or documentation update.

## 8. Recommendation and handoff actions

**STOP: do not run another paid qualification attempt.** First produce a bounded fix with strong evidence for the last
observed failure, including a local/static reproducer or equivalent target-side diagnostic, then rebuild and re-freeze the
exact host/runtime/toolchain identities. Do not weaken or bypass namespace safeguards to obtain a pass. The candidate
status remains **implementation candidate, validation blocked** after the final `226/NAMESPACE` runner failure.

The parent cleanup reconciliation is complete. Billing remains unknown, and G0/G3 remain blocked: this is a failed
disposable shell qualification, not Minecraft or release qualification.

### Evidence index

- Per-run lifecycle manifests: `.local-artifacts/disposable-qualification/*.json`
- Per-run shell evidence and bounded failure telemetry: `.local-artifacts/disposable-qualification/*-shell-evidence.json` and
  `.local-artifacts/disposable-qualification/*-failure-telemetry.log`
- Final local host archive and embedded manifests: `.local-artifacts/host-release/f51863b7db19ed69c4ca80311211439c7f19e3857c3bff61ee56c0b8f7d92a66.zip`
- Last target-tested host archive: `.local-artifacts/host-release/11f5a9b875d9a39b298179392cf6b9064cdc9c24a5f468465de5c80284ff4e53.zip`
- Final local toolchain manifest: `.local-artifacts/busybox-1.38.0/toolchain/shell-toolchain.json`
- Qualification procedure and historical payload notes: [`DISPOSABLE_SHELL_QUALIFICATION.md`](../../../../scripts/aws/DISPOSABLE_SHELL_QUALIFICATION.md)
