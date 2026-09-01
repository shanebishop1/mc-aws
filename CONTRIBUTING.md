# Contributing

Contributions are welcome. Keep each change focused, explain its operational impact, and follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before changing code

- Search existing issues and discussions; discuss substantial features or infrastructure changes first.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), never in a public issue.
- Use the pinned Node.js and pnpm versions referenced by `package.json` and `.tool-versions`; do not copy version numbers into new docs or scripts.
- Install with `pnpm install --frozen-lockfile`.

For AWS-free development, follow the [Mock Mode Quick Start](docs/QUICK_START_MOCK_MODE.md).

## Local disk usage

Supported build, test, preview, and CDK package commands remove the previous output for their artifact class before running, so repeated runs retain at most the latest output. Successful tests also remove their temporary fixtures. Supported commands place transient files under class-specific `.local-artifacts/` directories, and the next run removes any prior interrupted-run contents.

- `pnpm clean` removes all reproducible local build, test, and CDK outputs.
- `pnpm clean:build`, `pnpm clean:test`, and `pnpm clean:cdk` remove one output class.
- Cleanup never removes environment files, deployment/recovery state, server profiles, mock state, or `node_modules`.
- `node_modules` is one reconciled dependency tree rather than a per-run artifact. When the shared pnpm content-addressed store needs maintenance, run `pnpm clean:store`; this safely prunes packages unused by registered projects but can require later downloads.

## Change requirements

- Add or update tests for behavior changes and current docs for user-visible changes.
- Preserve authentication, deployment, migration, backup, and teardown safety.
- Describe new cloud resources, IAM permissions, recurring costs, migrations, or credential requirements.
- Test cloud operations only against resources you own or are authorized to use.
- Never commit credentials, session cookies, `.env` contents, `.mock-state.json`, deployment state, account/resource IDs, private hostnames, or sensitive test output.

## Validate before opening a PR

Baseline checks are expected locally:

```bash
pnpm check
pnpm typecheck
pnpm test
pnpm docs:check
```

Also run checks relevant to the changed surface:

- Browser/mock flows: `pnpm exec playwright install chromium`, then `pnpm test:e2e:mock`.
- Production UI/runtime: `pnpm build:production:check`. This removes prior Next.js output and builds with the same credential-free fixture values as CI. It explicitly overrides mock-mode settings, so you do not need to rename or edit a mock `.env.local`. CI also performs a clean OpenNext build.
- Infrastructure: run affected contract tests. CI performs a clean CDK synth with its required test context. Never deploy merely to validate a pull request.
- Bootstrap or dependency pins: follow [Reviewed Bootstrap and OS Upgrades](docs/BOOTSTRAP_UPGRADES.md); never introduce floating artifact URLs or regenerate lockfiles implicitly.
- Shell: run `bash -n <changed-shell-file>` for every changed Bash file.
- Cloudflare preview: use `pnpm preview:cf` only for an intentional manual preview; it is long-running.

CI additionally runs clean builds, infrastructure synthesis, production dependency audits, and secret scanning.

## Pull requests

Open against `main` and complete the template. Include what changed and why, exact validation results, related issues, and any security, compatibility, cloud-resource, cost, migration, or teardown impact. Maintainers may decline changes that expand scope, weaken safety, or create disproportionate maintenance cost.

By contributing, you agree that your work is licensed under the project's [MIT License](LICENSE).
