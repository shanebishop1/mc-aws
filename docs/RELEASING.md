# Releasing

`package.json` is the sole application version source and must remain private. Published tags and GitHub Releases use the matching `vX.Y.Z` name. Releases contain deployment source, not an npm package.

## Prepare a release PR

Start from a clean, up-to-date `main` checkout with authenticated `git` and `gh` access:

```bash
pnpm release:prepare patch
```

Use `major`, `minor`, or `patch`; an exact stable version such as `1.4.0` is also accepted when it is greater than the current version. The command verifies the branch, worktree, `origin/main`, version, and tag/branch availability; creates `release/vX.Y.Z`; updates `package.json`; reconciles `pnpm-lock.yaml`; then commits, pushes, and opens a PR. It never tags or releases directly.

### Recover a partially completed preparation

The command stops at the failing stage and never deletes branches or discards work. Inspect before continuing:

```bash
git status --short --branch
git diff -- package.json pnpm-lock.yaml
git diff --cached -- package.json pnpm-lock.yaml
```

- **Before `release/vX.Y.Z` is created:** correct authentication, network, branch, or worktree state and rerun the command from clean, up-to-date `main`.
- **Branch created, before the commit:** remain on the release branch, inspect the two version files, run `pnpm install --lockfile-only`, then use the normal reviewed `git add` and `git commit` flow. Do not reset or delete the branch merely to rerun the script.
- **Commit created, before push:** inspect it with `git show --stat --oneline HEAD`, then push that release branch when ready.
- **Branch pushed, before PR creation:** first check `gh pr list --head release/vX.Y.Z`; if none exists, open the PR with `gh pr create --base main --head release/vX.Y.Z`. This avoids duplicate PR attempts.
- **PR already exists:** continue review on that PR. Do not rerun preparation, rewrite its commit, or create a tag manually.

At every stage, preserve the branch and inspect its state rather than using destructive cleanup. If unexpected files changed, stop and investigate instead of staging them.

## Review and publish checklist

- [ ] Choose the SemVer bump based on user-visible compatibility.
- [ ] Confirm the PR changes only `package.json` and, when pnpm metadata requires it, `pnpm-lock.yaml`.
- [ ] Confirm `private: true` remains set and Baseline Validation passes.
- [ ] Merge through protected `main`; do not manually tag the release commit.
- [ ] Confirm **Publish Versioned Release** creates `vX.Y.Z` and its GitHub Release at the exact validated merge SHA.
- [ ] Review the generated release notes and edit only presentation text if necessary; never move or reuse a release tag.

The privileged publication workflow runs only after a successful `main` push validation. It does not install dependencies or execute repository code. It compares the validated package version with both its parent and the highest strict `vX.Y.Z` tag or release in the repository:

- A normal publication requires a version increase from the parent and above all existing version state.
- If an earlier version-bump validation was cancelled or skipped, a later successful commit with the same package version may publish it when Git history proves it increased from an earlier strict version and it is above all repository tag/release state. This also recovers a first release without treating an unchanged initial version as a release request.
- A rerun succeeds when the exact tag and release already resolve to the validated SHA.
- If the exact tag exists at the validated SHA but its release is missing, the workflow creates only the release with `--verify-tag`.
- A publication attempt never moves a tag. A tag at another SHA, a release without its tag, or a version at/below newer repository state fails closed. Ordinary commits retaining an already-published version exit without republishing it.

If publication fails after creating a tag but before creating its release, rerun the workflow for that same validated SHA; do not delete or move the tag. If a later validation encounters that partial tag at an earlier SHA, recover by rerunning the original workflow run. For any other conflict, compare the tag target and release in GitHub before taking action; preserve immutable tags and resolve the inconsistency rather than overwriting it.

## Release history

GitHub-generated release notes are the canonical release history. A committed `CHANGELOG.md` would duplicate that history and is intentionally omitted; add one only if a future distribution channel cannot consume GitHub Releases.
