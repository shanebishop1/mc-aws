# Releasing

## Invariants

- `package.json` is the sole application version source and must keep `private: true`.
- Versions are strict stable SemVer; tags and GitHub Releases use the matching immutable `vX.Y.Z`.
- Releases contain deployment source, not an npm package.
- Only a successful **Baseline Validation** push run on protected `main` may publish, at that run's exact validated SHA. Never tag manually, move/reuse a tag, or publish an unvalidated commit.

## Prepare the release PR

From a clean local `main` exactly matching `origin/main`, with authenticated `git` and `gh`:

```bash
pnpm release:prepare <major|minor|patch|X.Y.Z>
```

An exact version must exceed the current version. The command validates repository state and availability, creates `release/vX.Y.Z`, updates `package.json` (and lock metadata if needed), commits, pushes, and opens a PR. It does not create a tag or release.

Review that only `package.json` and, when necessary, `pnpm-lock.yaml` changed; keep `private: true`; require Baseline Validation; then merge through protected `main`.

## Preparation recovery

The command stops at the failing stage without deleting branches or discarding work. Inspect `git status --short --branch`, relevant diffs, and the latest commit before continuing.

| State | Recovery |
| --- | --- |
| Release branch not created | Fix auth/network/worktree state; rerun from clean, current `main`. |
| Branch exists, no commit | Stay on it; inspect version files, run `pnpm install --lockfile-only`, and use normal reviewed add/commit steps. |
| Commit exists, not pushed | Inspect `git show --stat --oneline HEAD`, then push the release branch. |
| Branch pushed, no PR | Check `gh pr list --head release/vX.Y.Z`; if absent, create the PR against `main`. |
| PR exists | Continue that PR; do not rerun preparation, rewrite its commit, or tag manually. |

Stop if unexpected files changed. Preserve state rather than using destructive cleanup.

## Publication and recovery

**Publish Versioned Release** normally requires a package version higher than its parent and every existing valid tag or Release. It can recover an earlier unpublished version only when repository history proves the bump and no higher version exists. During publication or missing-Release recovery, an existing tag must point to the validated SHA. When an unchanged version already has both a tag and Release, the workflow treats it as published after confirming only that the tag resolves.

Recover a missing historical Release before publishing any higher version. The workflow's monotonic check blocks publishing the older recovery after a higher version exists.

The publication job does not install dependencies or execute package/application scripts. However, its checked-in inline shell and Python still run with `contents: write` and are privileged repository code; changes to that workflow require security-sensitive review.

If tagging succeeds but Release creation fails, rerun publication for the same validated SHA. If a later run finds the partial tag at an earlier SHA, rerun the original workflow run. Never delete or move the tag; inspect GitHub's tag target and release state before resolving any other conflict.

GitHub-generated release notes are the canonical release history.
