#!/usr/bin/env python3
"""Grant the confined executor DAC access without changing Minecraft ownership."""

from __future__ import annotations

import grp
import os
import stat
import sys
from pathlib import Path


SERVER = Path(os.environ.get("MC_AGENT_WORKSPACE", "/opt/minecraft/server"))
GROUP = os.environ.get("MC_AGENT_WORKSPACE_GROUP", "mc-agent-workspace")
GID_FILE = os.environ.get("MC_AGENT_WORKSPACE_GID_FILE", "")


def fail(message: str) -> None:
    raise SystemExit(message)


def reconcile() -> None:
    if not SERVER.exists():
        return
    metadata = SERVER.lstat()
    if not stat.S_ISDIR(metadata.st_mode):
        fail("Minecraft workspace is not one regular directory")
    if GID_FILE:
        try:
            gid = int(Path(GID_FILE).read_text(encoding="ascii").strip())
        except (OSError, ValueError) as error:
            raise SystemExit("workspace group identity file is invalid") from error
    else:
        try:
            gid = grp.getgrnam(GROUP).gr_gid
        except KeyError:
            # The Minecraft service is also used by legacy hosts without the
            # agent package.  DAC reconciliation is optional until that group
            # exists; the ordinary minecraft:minecraft ownership setup still
            # remains authoritative there.
            return

    for current, directories, files, descriptor in os.fwalk(SERVER, topdown=True, follow_symlinks=False):
        root_metadata = os.fstat(descriptor)
        if not stat.S_ISDIR(root_metadata.st_mode):
            fail(f"Minecraft workspace directory changed: {current}")
        os.fchown(descriptor, -1, gid)
        os.fchmod(descriptor, stat.S_IMODE(root_metadata.st_mode) | stat.S_ISGID | 0o070)
        for name in [*directories, *files]:
            child = Path(current) / name
            try:
                child_fd = os.open(
                    name,
                    os.O_RDONLY | os.O_NOFOLLOW | (os.O_DIRECTORY if name in directories else 0),
                    dir_fd=descriptor,
                )
            except OSError as error:
                raise SystemExit(f"Minecraft workspace entry changed: {child}") from error
            try:
                child_metadata = os.fstat(child_fd)
                if stat.S_ISLNK(child_metadata.st_mode):
                    fail(f"Minecraft workspace contains a symlink: {child}")
                if not stat.S_ISDIR(child_metadata.st_mode) and not stat.S_ISREG(child_metadata.st_mode):
                    fail(f"Minecraft workspace contains an unsupported entry: {child}")
                if stat.S_ISREG(child_metadata.st_mode) and child_metadata.st_nlink != 1:
                    fail(f"Minecraft workspace contains a hard-linked file: {child}")
                os.fchown(child_fd, -1, gid)
                mode = stat.S_IMODE(child_metadata.st_mode)
                if stat.S_ISDIR(child_metadata.st_mode):
                    mode |= stat.S_ISGID | 0o070
                else:
                    mode |= 0o060
                os.fchmod(child_fd, mode)
            finally:
                os.close(child_fd)


if __name__ == "__main__":
    if os.geteuid() != 0:
        fail("workspace DAC reconciliation requires root")
    if len(sys.argv) != 2 or sys.argv[1] != "reconcile":
        fail("usage: mc-agent-workspace-dac.py reconcile")
    reconcile()
