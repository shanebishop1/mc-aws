# Disposable 30-minute shell composition probe

**Current local package (not a target run):** host release `f51863b7db19ed69c4ca80311211439c7f19e3857c3bff61ee56c0b8f7d92a66`
(`16,869,111` bytes), release manifest `d35b41ce5113187261eb2a620950d3150e7893076246a20a028af8f2c2f61b63`
(`14,628` bytes), embedded runtime `2d4e6470ee594f40c6b5c25a5e281b0e50903a280ce357d6c6692fa6c971bc15`
(`12,302,346` bytes), runtime bundle manifest `040c16b23b9317febed9ce028a35a1af3709495bfba6d1e51462556426cffb25`
(`8,449` bytes), and toolchain manifest `42995aec9022b04e5c11809347acbaa8b7150d9bd0d4da35a95ee3be8c2d312a`
(`2,678` bytes). This package uses the exact `packagingMode: local-disposable` marker required for the blocked-license
BusyBox input and is not a target result.

**Last target package/run:** host release `11f5a9b875d9a39b298179392cf6b9064cdc9c24a5f468465de5c80284ff4e53`
(`16,861,436` bytes), embedded runtime `f66a88f3374dcea1efd73940230dcd392dda095359321bbf7c6e663a26268636`,
documented separately in the [ARM EC2 qualification handoff](../../docs/epics/ec2-agent-platform/live-server-agent-foundation/arm-ec2-qualification-handoff.md).
It remains failed qualification evidence; no shell/Minecraft or release pass is implied.

`disposable_shell_qualification.py` is the target-side probe for the initial
G2 slice. It is intentionally separate from the EC2 lifecycle wrapper,
installer, toolchain recipe, and production services. It performs no AWS or
SSH operation and must only be invoked as root on a disposable native ARM64
Amazon Linux 2023 target.

The probe uses the original packaged `mc-agent-install.sh install-toolchain`
path, the exact packaged runtime manifest, the exact Node `22.19.0` ARM64
archive, and the original four shell unit files. It starts only
`mc-agent-tool-read.socket` and `mc-agent-tool-write.socket`; their real
socket activation then starts the actual packaged `shell-runner-cli.mjs`.
Gateway, executor, Minecraft, host-broker, world-root, Paper, Java, rclone,
plugin, and provider acquisition are not part of this slice. The installer
may initialize fixture-only credential files as part of its existing layout
contract; the probe never reads or records those bytes and the shell units
cannot see their paths.

## Local preparation (before the paid target)

Use already approved local dependencies and the repository's package commands.
Do not run these commands on the target and do not acquire anything from the
target. The shell-toolchain payload must already exist; its BusyBox source,
signature, public key, config, recipe, lock, and `bin/sh` are all verified by the
existing builder/installer. The probe verifies that exact nine-file prebuilt
payload before calling `install-toolchain`; that command copies the payload and
does not build BusyBox or require Docker, Podman, an image, or any other image
tool. Paper, plugin, Java, and rclone acquisition is not needed.

```sh
MISE_AUTO_INSTALL=0 pnpm agent-runtime:check
MISE_AUTO_INSTALL=0 pnpm host-release:package -- --local-disposable
```

If the reviewed Node archive is absent, acquire it separately through the
approved artifact process, then record and verify its bytes locally from the
`agent-runtime/runtime-manifest.json` URL and SHA-256. The target command
below still verifies the same digest and an operator-supplied byte count.

```sh
NODE_ARCHIVE=/path/to/node-v22.19.0-linux-arm64.tar.xz
NODE_BYTES=$(stat -c '%s' "$NODE_ARCHIVE")
NODE_SHA=$(sha256sum "$NODE_ARCHIVE" | cut -d' ' -f1)
printf 'node version=22.19.0 platform=linux-arm64 source=https://nodejs.org/dist/v22.19.0/node-v22.19.0-linux-arm64.tar.xz bytes=%s sha256=%s\n' "$NODE_BYTES" "$NODE_SHA"
```

The `NODE_SHA` line must equal the `node.sha256` value in the packaged runtime
manifest. Do not use a mutable URL, a system Node, or a host shell as a
substitute. Record the host-release archive path, byte count, and SHA-256 in
the transfer log as well. A missing archive or missing BusyBox payload is a
blocker, not a reason to weaken the probe.

At this checkout, the locally observed candidate payloads are:

```text
qualification script: scripts/aws/disposable_shell_qualification.py
  sha256=f4008e987ebb9221f65348998f2db6322974a2f2fb2c782ac6282dc62b960f5b
current local host release: .local-artifacts/host-release/f51863b7db19ed69c4ca80311211439c7f19e3857c3bff61ee56c0b8f7d92a66.zip
  bytes=16869111 sha256=f51863b7db19ed69c4ca80311211439c7f19e3857c3bff61ee56c0b8f7d92a66
  release manifest bytes=14628 sha256=d35b41ce5113187261eb2a620950d3150e7893076246a20a028af8f2c2f61b63
  embedded runtime bytes=12302346 sha256=2d4e6470ee594f40c6b5c25a5e281b0e50903a280ce357d6c6692fa6c971bc15
  embedded runtime manifest bytes=8449 sha256=040c16b23b9317febed9ce028a35a1af3709495bfba6d1e51462556426cffb25
  embedded shell-toolchain manifest bytes=2678 sha256=42995aec9022b04e5c11809347acbaa8b7150d9bd0d4da35a95ee3be8c2d312a
  embedded shell-toolchain lock bytes=294 sha256=0abf0af10e87923383055304fdd167664e5a2dbab887db491e0c3e34ee5a3ffc
  packagingMode=local-disposable
last target host release: .local-artifacts/host-release/11f5a9b875d9a39b298179392cf6b9064cdc9c24a5f468465de5c80284ff4e53.zip
  bytes=16861436 sha256=11f5a9b875d9a39b298179392cf6b9064cdc9c24a5f468465de5c80284ff4e53
Node archive: .local-artifacts/node-22.19.0/node-v22.19.0-linux-arm64.tar.xz
  bytes=29167588 sha256=0b2d9f564b6594222a62c82e1df2efe119dd4a4aff29644f4dd325bf360b6bcc
Node record: .local-artifacts/node-22.19.0/acquisition-record.json
  sha256=57a0531bcdd317d97120767150ea41103712f3e44d01a1d9282568643fa8a217
```

These ignored local artifacts are not release inputs until the final source
snapshot is frozen and the package commands are rerun. Recompute the values
with `sha256sum` and `stat` immediately before transfer; do not copy a digest
from this document if the archive changed. The Node source and checksum source
are recorded in `acquisition-record.json`; the Node archive's upstream
`LICENSE` member is retained and the target probe stages it beside `bin/node`.

## Target marker and execution

The parent-owned disposable lifecycle must first establish the unique marker
as root. The marker is deliberately outside the shell namespace and must be
created before invoking the probe:

```sh
RUN_ID=00000000-0000-4000-8000-000000000000
install -d -o root -g root -m 0700 /etc/mc-agent/disposable-qualification
printf 'mc-aws-disposable-qualification:%s\n' "$RUN_ID" > "/etc/mc-agent/disposable-qualification/$RUN_ID.marker"
chown root:root "/etc/mc-agent/disposable-qualification/$RUN_ID.marker"
chmod 0400 "/etc/mc-agent/disposable-qualification/$RUN_ID.marker"
```

Transfer these files by the parent-approved offline/SSH process: this script,
the exact host-release ZIP, the exact Node archive, and the script checksum.
Then run the following as one explicit root command. Substitute the recorded
paths, archive digest, archive bytes, Node bytes, and marker path; do not use
`systemd-run`, `sh`/`bash` in place of the packaged toolchain, or service-unit
overrides.

```sh
sha256sum disposable_shell_qualification.py host-release.zip node-v22.19.0-linux-arm64.tar.xz
python3 disposable_shell_qualification.py \
  --run-id "$RUN_ID" \
  --target-marker "/etc/mc-agent/disposable-qualification/$RUN_ID.marker" \
  --host-release-archive /var/tmp/qualification/host-release.zip \
  --host-release-sha256 HOST_RELEASE_SHA256 \
  --host-release-bytes HOST_RELEASE_BYTES \
  --node-archive /var/tmp/qualification/node-v22.19.0-linux-arm64.tar.xz \
  --node-bytes NODE_ARCHIVE_BYTES
```

For example, the parent-owned transfer may use an already authorized SSH
identity (the probe itself never opens SSH):

```sh
scp -i QUALIFICATION_KEY \
  scripts/aws/disposable_shell_qualification.py \
  .local-artifacts/host-release/f51863b7db19ed69c4ca80311211439c7f19e3857c3bff61ee56c0b8f7d92a66.zip \
  .local-artifacts/node-22.19.0/node-v22.19.0-linux-arm64.tar.xz \
  .local-artifacts/node-22.19.0/acquisition-record.json \
  ec2-user@DISPOSABLE_HOST:/var/tmp/qualification/
```

The SSH command is an operator transport placeholder, not an instruction for
this script to discover a host. The parent must keep the target offline from
package/model/provider endpoints and must terminate it after the evidence is
copied. Preparation is feasible only when the host-release ZIP, the exact Node
archive, the reviewed BusyBox payload embedded in that ZIP, and the explicit
AL2023 ARM64 target are all present; otherwise the result is **validation
blocked**, never a partial pass.

The script fails closed unless the target is root, native `aarch64`, AL2023,
and PID 1 is systemd; the marker is an exact root-owned file bound to the
UUIDv4 run ID; all archives and manifests are exact-byte verified; and the
original unit paths have no drop-ins. It also requires a fresh target: no
`/opt/mc-agent` tree, live pointers, toolchain, workspace, agent state,
agent users/groups, or installed shell units may already exist. Existing unit
files and pointers are never overwritten. No EC2 mutation occurs in this
command.

The source unit bytes are checked against the host-release manifest and their
exact Node command, `RootDirectory`, and runtime bind paths are checked before
installation. `systemd-analyze verify --recursive-errors=no` remains enabled;
systemd 252 documents this mode as making only the specified units affect the
exit status while still reporting dependency diagnostics. The two expected
static-only diagnostics for the absent pre-bind path
`/runtime/node-current/bin/node` are tolerated. Other requested-unit
diagnostics fail the probe; unrelated host-unit diagnostics are retained as
advisory static evidence, while unrelated `mc-agent-*` diagnostics still fail.
Runtime socket activation is the actual execution check.

## Evidence and interpretation

Evidence is written to:

```text
/var/lib/mc-agent-executor/disposable-qualification-RUN_ID/evidence.json
```

Because a fresh target has no executor state directory, the probe creates the
fixed `/var/lib/mc-agent-executor` parent only after the fresh-target guard;
it must be a newly-created root-owned `0700` directory before the installer
takes ownership of its normal layout.

The record contains package source/digest/byte identity, sanitized event
status and output digests, and the explicit scope (`shellUnits: true`, all
gateway/executor/Minecraft paths false). It contains no credential or secret
bytes. Fixed canaries prove that the child cannot read `/etc/mc-agent`,
executor evidence, or `/run/mc-agent` control paths. The deterministic cases
prove a real pipeline, read-only workspace write denial, exact staged result,
AF/network denial, and timeout process cleanup. After timeout the probe checks
the fixed canonical cgroup path `/sys/fs/cgroup/system.slice/<unit>`; if it
still exists, `cgroup.events` must report `populated 0` and `cgroup.procs` must
be empty (an absent canonical cgroup path is also accepted). An empty
`ControlGroup` value from `systemctl show` is valid for an inactive service and
is not used as cgroup proof. The probe has a 120-second total wallclock bound;
each subprocess and socket exchange is also independently bounded, including
partial reads. Fixed exception-class failure events are retained in evidence
without command output or credential material. The timeout case is expected to
return the runner's failure envelope (`exitCode: 126`); any
successful network, write, sentinel read, malformed response, missing cgroup
cleanup, or unit boundary is a failed qualification.

The final output and `evidence.json` must be copied off the target before its
parent-owned termination. If evidence cannot be read, if cleanup cannot be
verified, or if the target is not disposable, stop and report the run as
failed. This is honest partial G2 OS evidence, not a broader cleanup or full
PRD/G3 qualification.
