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
