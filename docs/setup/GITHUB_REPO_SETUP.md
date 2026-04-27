# GitHub Repo Setup

The EC2 instance clones this repo during server setup. For normal use, fork the repo first and deploy from your fork.

## Steps

1. Open the `mc-aws` repository on GitHub.
2. Click **Fork**.
3. Choose your GitHub account or organization.
4. Keep the repo name as `mc-aws` unless you want a different name.
5. Clone your fork locally:

```bash
git clone https://github.com/<you>/mc-aws.git
cd mc-aws
```

## Values Needed Later

The setup wizard asks for:

- `GITHUB_USER`: your GitHub username or organization
- `GITHUB_REPO`: the forked repository name, usually `mc-aws`

The deployed EC2 instance uses these values to clone:

```text
https://github.com/<GITHUB_USER>/<GITHUB_REPO>.git
```

## Notes

- Use the fork as the source of truth for scripts and server setup files.
- If the repo is private, the GitHub token must be able to read it.
- If you rename the repo, use the renamed value for `GITHUB_REPO`.
