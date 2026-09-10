# G0 offline runner preparation

**Status:** inventory only; implementation candidate, validation blocked

**Snapshot:** `060f06e5789b942e8d47d0d155119d9fcf9c0844` (`ddbf7a817cc606ba7b89cb73558e76c8a7a71760` tree)

This is a bounded preparation record for the revised [first-shippable PRD](prds/first-shippable-ec2-agent-foundation.md)
section 7 and G0. It does not authorize acquisition, runner provisioning, namespace creation, service operation,
cloud/provider calls, deployment, secret access, or Git mutation. It does not claim a runnable matrix or release
qualification. The authoritative contracts remain the PRD and the existing runtime/host-release manifests; this file
does not create a second authority protocol.

## 1. Local availability at this snapshot

The repository declares Node `22.19.0` and pnpm `10.30.3` in `mise.toml`, `.tool-versions`, and the root
`package.json`. The agent-runtime package also requires Node `22.19.0`. The following was observed during bounded
inspection. No `pnpm install` or repository dependency install was run. One version probe through the mise shim
unexpectedly triggered mise's managed Node download/install; this is recorded below as an authorization deviation, it
was not retried, and the resulting host executable is not treated as reviewed runner input.

| Input/tool | Observation | G0 meaning |
| --- | --- | --- |
| Node/pnpm/Python | pnpm `10.30.3`, Python `3.12.13`, and a mise-managed ARM64 Node `22.19.0` executable are available outside the checkout | Tool presence is not target-runner or provenance evidence; do not substitute the host Node for the reviewed staged input |
| `node_modules` / `agent-runtime/node_modules` | Missing | Root and runtime package commands cannot currently resolve declared local dependencies |
| pnpm store | Local store directory exists | A store directory does not prove that the exact lockfile, Pi shrinkwrap, native packages, or executable links are complete |
| `.local-artifacts` | Missing | No current runtime or host-release ZIP is available in this checkout |
| shell toolchain | `config/shell-toolchain.json` and `/config/shell-toolchain.json` are missing | The exact root-owned reviewed ARM64 toolchain remains a blocker |
| systemd / Docker | `systemd-analyze` and Docker binaries are present | No service/container operation is authorized; Docker is not evidence of the required isolation |
| ARM64 emulator / cloud CLIs | `qemu-aarch64`, `aws`, and `cdk` are missing | No emulation or cloud check is available or permitted |
| namespace probe | `/usr/bin/unshare` exists, but an unauthorized namespace attempt fails at `uid_map` with `Operation not permitted` | This was not a read-only check and is not runner evidence; no further namespace probe or privileged retry is permitted |
| Current host platform | aarch64 Ubuntu `24.04.4` Apple VM; kernel `7.0.0-30-generic` (`#30~24.04.1-Ubuntu`, `PREEMPT_DYNAMIC`); PID 1 is `systemd` in `/init.scope`; systemd `255.4-1ubuntu8.17` | Same host, not a separate colleague VM; not an approved AL2023-compatible runner |
| Current host capacity | `free -b`: memory total `10,393,989,120`, available `6,162,558,976`; swap total `8,589,930,496`; `/dev/vda1`: `386,346,164,224` bytes total, `271,555,371,008` available | Observation only; no resource qualification or instance minimum follows |
| Current host isolation | `/dev/kvm` absent; `qemu-system-aarch64` and `qemu-aarch64` absent; cgroup paths use unified `0::` layout and expose `cpuset cpu io memory hugetlb pids rdma misc dmem`; root `cgroup.type` is absent; pre-existing Docker is reported active but was not used | No KVM/QEMU/emulation evidence; Docker presence is not approved isolation or a substitute for the required runner |
| LXC wrapper | Its `--version` path attempted Snap bootstrap | Explicitly excluded; do not invoke, provision, or use it |

The local store and the host-side ARM64 Node observation are not accepted as reviewed runner inputs. No target image,
runtime archive, host-release archive, Minecraft/Paper bytes, shell-toolchain bytes, credentials, or worker deployment
artifact was read from outside the bounded paths above.

### Execution deviations and exact probes

The Node acquisition occurred while running this existing availability command (the relevant subcommand is shown
exactly):

```sh
command -v node
node --version
```

`command -v node` returned `/home/shane/.local/share/mise/shims/node`. The subsequent `node --version` emitted:

```text
mise node@22.19.0 [1/3] install
mise node@22.19.0 [1/3] download node-v22.19.0-linux-arm64.tar.gz
mise node@22.19.0 [2/3] checksum node-v22.19.0-linux-arm64.tar.gz
mise node@22.19.0 [3/3] extract node-v22.19.0-linux-arm64.tar.gz
mise node@22.19.0 [3/3] node -v
mise node@22.19.0 [3/3] npm -v
mise node@22.19.0                      ✓ installed
v22.19.0
```

This was an unauthorized acquisition deviation from the requested no-download/no-install boundary. No explicit
`mise install` command was issued, and no further shim, network, auto-installer, namespace, or package acquisition
command was run. The internal network request, if any, is not independently characterized here; the emitted `download`
and `install` lines are the complete observed evidence.

The exact namespace command was:

```sh
/usr/bin/unshare --user --map-root-user --net --pid --fork --kill-child=KILL --mount-proc -- /usr/bin/true
```

It was attempted without separate namespace/privileged authorization, was not read-only, failed in `0.00 s` with
`write failed /proc/self/uid_map: Operation not permitted`, and was not retried.

## 2. Exact reviewed pins and source obligations

These values are read from the checked-in manifests. URLs identify the required source, not evidence that the resource
was fetched or remains available offline.

| Input | Exact identity in repository | Source/checksum and license obligation |
| --- | --- | --- |
| Node | `22.19.0`, `linux-arm64`; SHA-256 `0b2d9f564b6594222a62c82e1df2efe119dd4a4aff29644f4dd325bf360b6bcc` | Node URL and `SHASUMS256.txt` in `agent-runtime/runtime-manifest.json`; retain upstream notices with the staged binary |
| Pi coding agent | `@earendil-works/pi-coding-agent@0.84.4`, MIT; `@earendil-works/pi-ai@0.84.4` | Published Pi shrinkwrap SHA-256 `a137fbb6530359fda4aa1212eb1d8ad54157bddced042ea24d8e566eea21ec54`, 136 package entries, licenses `0BSD`, `Apache-2.0`, `BSD-3-Clause`, `BlueOak-1.0.0`, `ISC`, `MIT`; preserve source/license notices |
| Runtime direct dependencies | `typebox@1.3.7`, `undici@8.9.0`; runtime dev tools `esbuild@0.27.2`, `typescript@5.9.3` | Exact versions are in `agent-runtime/package.json` and the lockfile; package license/source notices must come from the staged dependency inventory |
| Worker tooling | `wrangler@4.123.0`, `workerd@1.20260811.1` resolved by `pnpm-lock.yaml` | Lockfile integrity is present; local Worker fixture execution and package notices are still unavailable |
| Paper | Minecraft `1.21.11`, build `132`; SHA-256 `5ffef465eeeb5f2a3c23a24419d97c51afd7dbb4923ff42df9a3f58bba1ccfba` | Exact URL/checksum source in `config/bootstrap-pins.json`; Paper license/source notices are not represented in the pin manifest and must accompany any staged byte |
| rclone | `1.71.2`, Linux ARM64; SHA-256 `e2e2efc7ed143026352d60216ef0d46d3fa4fe9d647eff1bd929e6fea498e6f1` | Exact URL and `SHA256SUMS` source are pinned; license/source notice is unresolved in this checkout |
| mcstatus | `12.0.2`; SHA-256 `b2ee5ff189a4ebf255c658e3983b3e2c74a1e0d222d3e74cfe04c2b4f64f66e6` | Exact PyPI wheel and release JSON are pinned; wheel license metadata and any independently required notices remain to be recorded |
| asyncio-dgram | `2.2.0`; SHA-256 `7afe5a587d1d57908c7a02fe84c785f075d3fb59b555039a6ff8aead28622743` | Exact PyPI wheel and release JSON are pinned; license/source notice is unresolved in this checkout |
| dnspython | `2.7.0`; SHA-256 `b4c34b7d10b51bcc3a5071e7b8dee77939f1e878477eeecc965e9835f63c6c86` | Exact PyPI wheel and release JSON are pinned; license/source notice is unresolved in this checkout |
| mise (preparation tooling only) | `2026.8.14`, Linux ARM64; SHA-256 `bc2c447a7e498b0bed0a421cc2101b407fef09a3195670d35a4aa3f43cd868a1` | Exact release URL and checksum source are in `config/mise-pins.json`; license/source notice is unresolved for the runner record |

The checked-in `config/plugins.lock.json` is empty. No executable plugin identity, bytes, digest, size, or license may be
invented for this G0 record. The reviewed sample extension is repository-owned data: `schemaVersion: 1`, extension
version `1.0.0`, and integrity `sha256:ddf3ad8c4458ecf5c9f591e4ffebbe9a0a003576529fff505d9b5c5f47dc735a`.

Historical handoffs record, but do not make locally available, these package identities: runtime ZIP
`12,290,197` bytes / SHA-256 `4e72c1711a7c693d4981410586a5b501950435c007b7f7051de4571dfddfaadc`, and final host-release
ZIP `12,957,538` bytes / SHA-256 `8a48d9c5513b0f2624194d6881cd2a89a5cabc554c427bc50d7335bc2947a3ec`. They were not revalidated at this
snapshot because the archives are absent. They must not be presented as current runnable inputs.

## 3. Bounded composition proposal

The offline runner should receive a reviewed, content-addressed staging directory. Its staging phase must not resolve
packages, reach the network, mint production authority, or generate production credentials. An explicitly approved
disposable fixture installation may use the existing installer/runtime initialization to generate test-only keys and
journals; those are isolated fixture state, never production authority, and must be recorded as such. Assembly uses the
existing builders and contracts in this order:

1. Prepare the exact repository snapshot plus already-reviewed local dependency trees. `agent-runtime/package.json`,
   `runtime-manifest.json`, `dependency-inventory.json`, the lockfile, and the sample extension are the inputs to
   `scripts/setup/build-agent-runtime.mjs`.
2. The runtime package builder bundles the existing `gateway-cli.mjs`, `executor-cli.mjs`, and
   `shell-runner-cli.mjs`; the Pi adapter and Pi dependencies are bundled into that ZIP, and the extension is copied
   from `examples/agent-extensions/status-report`. `bundle-manifest.json` and the dependency inventory remain part of
   the package evidence. Node is a separately pinned host input, not an npm/pnpm runtime install.
3. `scripts/setup/build-host-release.mjs` consumes the runtime ZIP and its explicit `hostFiles` list. That list carries
   the gateway/executor configuration, socket/service units, installer, world-root and backup helpers, and
   `mc-agent-host-broker.py` plus its service/socket. `release-manifest.json` binds each host member, destination, mode,
   size, digest, bootstrap pin set, and embedded runtime identity. No file outside that explicit list is silently added.
4. The Worker/control-plane side remains separate. The local fixture is `tests/fixtures/agent-worker/worker.ts` with
   its three Durable Object bindings in `tests/fixtures/agent-worker/wrangler.jsonc`; it is exercised by local
   Wrangler/workerd, not embedded in the EC2 host ZIP. The production `wrangler.jsonc` points at a generated
   `worker.mjs`/`.open-next` build, which is absent here. Therefore no production Worker package identity is claimed.
5. On an approved target, install/activation must use the existing root-owned installer and reviewed host-release
   contract, then run the services and fixture workloads under the runner's separately authorized service-manager
   harness. The installer is mutating and root-required; its invocation, fixture image, credentials, and rollback
   procedure still need an approved runner wrapper. Do not replace it with a new broker, bypass, or authority path.

This composition keeps the existing ownership split: gateway/provider credentials remain gateway-side; executor
journal/receipt authority remains supervisor-side; tool children receive neither; the root host broker is the only
bounded maintenance/console authority. Worker publication evidence and executor effect evidence must remain separately
attributed.

## 4. Section 7 commands: available versus blocked

This table records commands that are safe to identify at G0. “Declared” means the repository names the command; it does
not mean this checkout can run it. No missing command is assigned an assumed result.

| Section 7 area | Command or anchor | Local status now | Target-runner gap |
| --- | --- | --- | --- |
| Source/config identity | `git status --short --untracked-files=all`; `git diff --check`; Python JSON parsing | Available and deterministic | Re-freeze all staged inputs and record their digests |
| Shell/script syntax | `bash -n` on reviewed `infra/src/ec2/*.sh` | Available; syntax-only | Does not prove installed paths or service behavior |
| Unit syntax | `/usr/bin/systemd-analyze verify` against checked-in units | Available; static-only | Real systemd socket activation and installed target paths |
| Namespace prerequisite | `/usr/bin/unshare --user --map-root-user --net --pid --fork --kill-child=KILL --mount-proc -- /usr/bin/true` | Available but fails `uid_map: Operation not permitted` | Separately authorized runner with namespaces/cgroups and documented enforcement |
| Repository docs | `pnpm docs:check` | Package command blocked by missing `tsx`; underlying checker passed directly with existing Node, as recorded below | Re-run package command after dependencies are supplied offline |
| Contract/type/style checks | `pnpm check`; `pnpm typecheck` | Blocked: `biome`/`tsc` absent; not run | Same offline dependency tree |
| Runtime package | `pnpm agent-runtime:check` | Blocked: runtime dependencies/`esbuild` absent; not run | Build twice from reviewed inputs and compare archive/manifest bytes |
| Host package | `pnpm host-release:check` | Blocked by runtime dependencies; not run | Assemble and install the exact runtime plus host manifest |
| Focused runtime tests | `pnpm exec vitest run agent-runtime/src/extensions.test.ts agent-runtime/src/gateway-config.test.ts agent-runtime/src/gateway.test.ts agent-runtime/src/protocol.test.ts lib/agent/extensions.test.ts tests/agent-runtime-package.test.ts tests/agent-runtime-services.test.ts` | Blocked: `vitest` absent; not run | Run only after the exact local dependency tree is staged |
| Offline Worker/control plane | local Wrangler/workerd fixture from `tests/fixtures/agent-worker/` | Blocked: `wrangler`/`workerd` absent; not run | Start only a local fixture with OS egress enforcement recorded |
| Section 7 e2e slice | `pnpm test:agent:e2e` | Blocked: `vitest` absent; not run | Still only a fixture gate; it does not replace packaged composition |
| Full repository suite | `pnpm test` | Authorized by the gate plan but blocked by missing root/runtime dependencies; not run | Run when the exact dependency tree is supplied offline; it remains separate from composition evidence |
| Product/failure composition | no existing one-command runner | Missing | G0 must approve the runner wrapper before G3; do not fabricate a command or matrix result |

The full `pnpm test` is authorized by the gate plan but was not run: the root and runtime dependency trees are absent,
so Vitest and its pretest path are unavailable. No new code tests were added or run. Production build,
`bootstrap:upgrade`, `ami:*`, release preparation, deployment, SSM, AWS, Cloudflare, real-provider, service start/stop,
and privileged install paths remain outside this bounded checkpoint.

## 5. Executed bounded checks

These are the exact local commands actually run during this checkpoint. They are static or inventory checks only; none
installed dependencies, started a service, created a namespace successfully, or contacted a provider.

| Command | Result | Elapsed |
| --- | --- | ---: |
| `rtk git diff --check` | PASS | `0.06 s` |
| `/usr/bin/python3 -c 'import json; from pathlib import Path; paths=["agent-runtime/package.json","agent-runtime/runtime-manifest.json","agent-runtime/dependency-inventory.json","config/bootstrap-pins.json","config/mise-pins.json","config/plugins.lock.json","examples/agent-extensions/status-report/extension.json"]; [json.loads(Path(p).read_text()) for p in paths]; print(f"parsed {len(paths)} JSON files")'` | PASS; parsed 7 JSON files | `0.02 s` |
| `/usr/bin/bash -n infra/src/ec2/*.sh` | PASS for first expanded script only; remaining arguments are not checked by Bash | `0.00 s` |
| `/usr/bin/bash -c 'for script in infra/src/ec2/*.sh; do /usr/bin/bash -n "$script" || exit; done'` | PASS for every matching script | `0.02 s` |
| `/usr/bin/uname -a; /usr/bin/arch; /usr/bin/systemd-analyze --version; /usr/bin/free -b; /usr/bin/df -B1 /` | PASS; host architecture, kernel, systemd, memory, swap, and root-disk observations are recorded in section 1 | not timed |
| `/usr/bin/systemd-analyze verify infra/src/ec2/*.service infra/src/ec2/*.socket` | NONZERO; static diagnostics report missing installed absolute executables such as `/runtime/node-current/bin/node` and `/usr/local/bin/mc-agent-host-broker.py` | `0.05 s` |
| `/usr/bin/unshare --user --map-root-user --net --pid --fork --kill-child=KILL --mount-proc -- /usr/bin/true` | FAIL; unauthorized, non-read-only namespace attempt; `write failed /proc/self/uid_map: Operation not permitted` | `0.00 s` |

The `pnpm docs:check` wrapper requires missing `tsx`. Inspection confirmed its underlying checker imports only Node
built-ins, so it was run without acquisition or shims using
`/home/shane/.local/share/mise/installs/node/22.19.0/bin/node --experimental-strip-types scripts/validation/validate-docs-consistency.ts`.
The first two runs (0.12 s and 0.14 s) flagged wording in this new document under the Worker privilege rule; the wording
was corrected without changing validation rules. The final run passed in 0.11 s, with Node's module-type warning only.
This is direct checker evidence, not a package-command result
or approval of the acquired Node as target runtime input.

## 6. Zero-cost path and approval requirements

A possible zero-cost path is a user-supplied, already-owned native ARM64 disposable VM or host running an
AL2023-compatible image with real systemd, cgroups, namespaces, and offline controls. No such environment has been
identified or supplied. The current aarch64 Ubuntu Apple VM lacks KVM/QEMU and is not AL2023 evidence; pre-existing
Docker is not approved isolation. No paid compute or hosted runner is proposed. If no suitable user-owned target exists,
G3 remains blocked rather than being approximated with Ubuntu, Docker, LXC, or weakened isolation.

Before G3 execution, reviewers must separately approve and record:

- the disposable AL2023-compatible ARM64 runner, exact image identity, service manager, namespace/cgroup behavior,
  reboot/crash controls, offline transport policy, and any architecture/emulation limitation. The current Apple VM is
  not this approval: Ubuntu 24.04.4 plus systemd 255.4 does not establish AL2023 compatibility, and its missing KVM/
  QEMU and active pre-existing Docker do not establish the required isolation. The LXC wrapper is excluded because it
  attempted Snap bootstrap on `--version`;
- transfer of each exact artifact above, including byte identity, source, license notices, and the unresolved
  shell-toolchain manifest/bytes. This is a separate artifact-acquisition/transfer approval outside the runner; the
  runner must have no package or artifact network path;
- the exact runtime and host-release archive digests regenerated from the frozen snapshot, plus the production Worker
  fixture/build identity if it is included in the same composition evidence;
- non-secret test credentials and fixture server/profile/world data, with no real provider account, cloud credential,
  player identity, whitelist mutation, or deployment state;
- the root-required installation/activation and rollback wrapper, including who owns lifecycle fences and recovery
  evidence, plus explicit approval for the bounded privileged actions it performs (root staging, systemd activation,
  process termination/reboot, and any namespace/cgroup setup). Privileged operations must not be simulated by
  weakening isolation;
- one named owner for each existing control-plane, gateway/executor, journal/receipt, lifecycle, and host-broker
  authority, with approval that the runner invokes those existing contracts rather than introducing a new authority
  protocol.

Until these are recorded, G0 remains incomplete and G3 remains **implementation candidate, validation blocked**. The
next feasible work is to stage reviewed dependencies/artifacts through an approved process, then run the bounded local
checks above; no unrestricted audit or new authority protocol is needed.

## 7. Bounded local preparation execution (2026-09-09)

This section records the separately approved local preparation pass. It did not identify an account, profile, or region,
and it performed no AWS API call, provisioning, deployment, service operation, credential copy, or shell-toolchain/Paper/
plugin acquisition.

### Official AWS CLI ARM64 input

- Source URL: `https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip`
- Signature URL: `https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip.sig`
- Official verification documentation: `https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html`
- Published AWS CLI key fingerprint matched: `FB5D B77F D5C1 18B8 0511 ADA8 A631 0ACC 4672 475C`
- Signature key: `A6310ACC4672475C` (`AWS CLI Team <aws-cli@amazon.com>`)
- ZIP: `70,853,622` bytes; SHA-256 `cf64084aafa091b68392ca585c87325c67137ab6d740f9d43f12c55f7fd6b297`
- Detached signature: `566` bytes; SHA-256 `660bff5685067cfa41f4f7d345c2a0c18d29bf89f012f8cb068f317fd5722150`
- Verification: **GOOD signature** by the published AWS CLI key; GnuPG reported `TRUST_UNDEFINED` because the
  documentation-published key was imported directly into the isolated verification keyring, which is expected here.
- Artifact identity: `aws-cli/2.36.42`, ARM64 ELF; installed without sudo under
  `/tmp/opencode/aws-cli-arm64-prep/{install,bin}`. The isolated install's `aws` executable SHA-256 is
  `d192338e53c48c2bdc528be062f4f52f8bb9ec6374e7e81dfd4d96a422712d1f`.

The install script was inspected after signature verification and before execution. No system path was modified.

### Frozen repository dependencies

Using the already-installed exact pins Node `22.19.0` and pnpm `10.30.3`:

```text
pnpm install --frozen-lockfile --ignore-scripts       PASS, 26.78 s, 635 packages
pnpm rebuild @biomejs/biome esbuild sharp workerd       PASS, 7.54 s
```

The lifecycle sources were inspected before the approved rebuild. Biome only resolves its package-local platform
binary. esbuild `0.25.4`, `0.27.2`, and `0.28.1` and workerd `1.20260811.1` have package-local ARM64 optional binaries;
their inspected fallback npm/network paths were not entered. sharp has no install lifecycle script. Native ARM64 inputs
observed include Biome (`25,424,512` bytes, SHA-256
`f0f0f3e7cdec78420a600b05bfc364aa9b804811bd3bbae04e7bf090828ae970`), esbuild `0.27.2` (`10,158,264` bytes,
SHA-256 `136015b18f887187ebaeb5f1fc48caf3e82fd86b4a4aefa53780fc0be5e4d41a`), workerd (`155,273,552` bytes,
SHA-256 `6a46e193de0f414814d52d47368e543a9a1d8099fda349b6b941e2d156bcb898`), sharp (`530,120` bytes, SHA-256
`ca16f6b4af700f2eb8fb43e9f32103b50c39a16fe882bb1282d3d76c975069ac`), and libvips (`17,800,568` bytes, SHA-256
`56f7e7c98d134371c07990a318e41178cf0b6a956b8d5cd73779881c17deaaab`). No dependency version or lockfile entry was
changed.

Focused checks then ran serially:

| Command | Result | Elapsed |
| --- | --- | ---: |
| `pnpm exec vitest run agent-runtime/src/shell-toolchain.test.ts agent-runtime/src/shell-runner.test.ts agent-runtime/src/shell-client.test.ts tests/agent-runtime-services.test.ts` | PASS; 4 files, 32 tests | `1.32 s` |
| `pnpm docs:check` | PASS | `0.64 s` |

The reviewed shell toolchain remains unavailable: `config/shell-toolchain.json`, `/config/shell-toolchain.json`, and
`/opt/mc-agent/toolchain/bin/sh` were absent. No host `/bin/sh` substitution, source build, or acquisition was attempted.
The next artifact proposal requires an explicitly approved ARM64 source build that produces exactly one root-owned,
non-writable `/toolchain/bin/sh` plus the schema-v1 `linux-arm64` manifest containing its exact bytes, mode, and SHA-256;
the source/toolchain choice and useful applet composition are not declared by this checkout.

Two local-only AWS CLI probes were accidentally included in a combined final version probe. `aws configure list` read
the local CLI configuration sources and printed profile/access-key/secret-key/region as `<not set>`. An attempted
`aws sts get-caller-identity --dry-run` was rejected by the CLI as an unknown option before any request. No credential
values were exposed or copied, no AWS API request was made, and neither command was repeated.

## 8. Current local qualification pass (2026-09-09)

The current source was `HEAD 654905906f3d134cc91055a4b6eafa08a00ce750`, tree
`c814d052bcf853cf5e2de24ad856408242e443ec`. The only tracked worktree change during the gate was this evidence document.
Untracked `3` and `infra/src/ec2/__pycache__/` appeared during local validation; they were absent at the initial clean
checkout, and are left unstaged. Logs are retained in the ignored
directory `.local-artifacts/current-gate-6549059/`.

The runtime and host builders were inspected before execution. They read checked-in manifests and local dependency
trees, invoke local esbuild/Python, and copy the explicit checked-in host file list. They contain no artifact fetch,
`curl`, `wget`, npm/pnpm install, mise install, Paper, plugin, or shell-toolchain acquisition path. `host-release:check`
records the checked-in bootstrap URLs and digests but does not fetch those artifacts. All commands below used the
already-installed Node `22.19.0` and pnpm `10.30.3`, with `MISE_AUTO_INSTALL=0`; no service, credential, account/profile/
region, or AWS configuration probe was run in this pass.

| Command | Result | Elapsed | Log |
| --- | --- | ---: | --- |
| `pnpm check` | PASS; Biome 563 files and Lambda type check | `15.06 s` | `01-pnpm-check.log` |
| `pnpm typecheck` | PASS | `82.54 s` | `02-pnpm-typecheck.log` |
| `pnpm docs:check` | PASS; final evidence-document validation also PASS | `0.88 s; final 0.42 s` | `03-pnpm-docs-check.log`, `11-pnpm-docs-check-final.log` |
| `pnpm test` | FAIL; 14/200 files, 108/2,547 tests failed; 722.10 s | `722.10 s` | `04-pnpm-test.log` |
| `NODE_ENV=test pnpm test` | FAIL; 8/200 files, 43/2,547 tests failed; diagnostic PATH/test-only build rerun | `379.49 s` | `05-pnpm-test-node-env-test.log` |
| `NODE_ENV=test pnpm test -- --no-file-parallelism --maxWorkers=1` | FAIL; 7/200 files, 46/2,547 tests failed; 2,501 passed | `391.76 s` | `06-pnpm-test-serial.log` |
| `NODE_ENV=test pnpm test:agent:e2e` | PASS; 2 files, 15/15 tests | `3.74 s` | `07-test-agent-e2e.log` |
| `NODE_ENV=test pnpm agent-runtime:check` | PASS; reproducibility check | `5.02 s` | `08-agent-runtime-check.log` |
| `NODE_ENV=test pnpm host-release:check` | PASS | `2.55 s` | `09-host-release-check.log` |

The exact first `pnpm test` run exposed an untrusted mise config through a child PATH and then accumulated workstation
timeouts. The constrained rerun removed mise shims from PATH and used the repository's test-only build path rather than
attempting the unavailable privileged production namespace. Its remaining failures are timeout/cleanup and protocol,
backup, restore, journal, offline-provider, and destroy test failures. Subsequent bounded
[ARM triage](ARM-local-gate-triage.md) reran every previously failing file: five complete files passed, while protocol
and executor-journal retained timing-sensitive failures that passed individually. No concrete source defect was
established, no timeout was increased, and the full-suite gate remains failed. These are not target authority
qualification or release evidence.

### Produced package identities

- Runtime archive: `12,290,197` bytes; SHA-256
  `4e72c1711a7c693d4981410586a5b501950435c007b7f7051de4571dfddfaadc`.
- Runtime bundle manifest: `8,449` bytes; SHA-256
  `2d9a9ed12b6e36f13790b796d2b89472a9eb6006fb96d9ea320f8151c711783c`.
- Host release archive: `12,957,538` bytes; SHA-256
  `8a48d9c5513b0f2624194d6881cd2a89a5cabc554c427bc50d7335bc2947a3ec`.
- Host release manifest: `12,028` bytes; SHA-256
  `127d0de3ce8ac407f337d262dc51a5ef5e226c9b17ceadaf285d480d7700d5b8`.

These are cloud-free local package identities only. They do not establish an installed target, real systemd/socket
activation, effective isolation, Minecraft behavior, resource qualification, G3 assembly, or release readiness.

## 9. Updated EC2 authorization and historical pending-target state

This section records the pre-launch state and is superseded by section 10 and the final [ARM EC2 qualification
handoff](arm-ec2-qualification-handoff.md). It must not be read as a current claim that no disposable run occurred.

The operator subsequently authorized disposable EC2 matching the intended Minecraft server specifications, with the
explicit requirement to shut it down when not in use and use the lowest necessary running time. Official ARM64 AWS CLI
and repository-pinned dependency acquisition were separately approved. This supersedes the earlier prohibition on paid
runner creation only within that disposable qualification scope; it does not authorize production deployment, production
secrets/backups, real-provider calls, or arbitrary shell-toolchain acquisition.

The checked-in default was `t4g.medium`, ARM64 AL2023, and an encrypted 8 GiB gp3 root disk. Region and exact AMI were
operator-selected. At this historical checkpoint no EC2 instance or other AWS resource had been created. The subsequent
11 disposable attempts and their parent-reconciled cleanup are recorded in section 10.

Preparation and local builds happen before paid runtime. The proposed disposable lifecycle must explicitly set and
verify root-volume deletion on termination, collect evidence before termination, and verify no run-owned billable
resources remain. A guest shutdown-to-terminate setting and cleanup deadline are planned, not implemented safeguards;
an independent cleanup mechanism must cover a failed guest or lost workstation. Stopping alone leaves EBS charges.
No NAT gateway, Elastic IP, retained snapshot, production instance role, or production security group is proposed.

## 10. Current disposable qualification handoff (2026-09-10)

The authorized disposable ARM64 EC2 qualification attempts are documented in the current [ARM EC2 qualification
handoff](arm-ec2-qualification-handoff.md). It inventories all 11 cleaned local run records, exact final artifact
manifests, bounded failure phases, parent-corroborated cleanup, remaining billing evidence gaps, and the recommendation not to run another paid attempt
until the `226/NAMESPACE` failure has a bounded fix with strong evidence. This link supersedes the pending-target
language above for the current qualification status; it does not authorize AWS calls or deployment.
