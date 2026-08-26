# Contributing

Contributions are welcome. Keep changes focused, explain their operational impact, and avoid exposing credentials or account-specific information.

## Before You Start

- Search existing issues and discussions before proposing a change.
- Use an issue or discussion for substantial features or infrastructure changes.
- Report security vulnerabilities according to [SECURITY.md](SECURITY.md), not through a public issue.
- Review the [Code of Conduct](CODE_OF_CONDUCT.md).

## Local Development

This project uses Node.js 22.15.1 and pnpm 10.30.3.

Install dependencies and start the application with its mock backend:

```bash
pnpm install --frozen-lockfile
pnpm dev:mock
```

Open `http://localhost:3000/api/auth/dev-login` to sign in as a local administrator.

See the [Mock Mode Developer Guide](docs/MOCK_MODE_DEVELOPER_GUIDE.md) for additional scenarios and development details.

## Making Changes

- Keep pull requests limited to one coherent change.
- Add or update tests for behavior changes.
- Update current documentation when user-visible behavior changes.
- Preserve deployment, migration, backup, and teardown safety.
- Describe new cloud resources, permissions, recurring costs, or credential requirements.
- Do not include credentials, `.env` contents, deployment state, account IDs, resource IDs, or private hostnames.
- Test cloud operations only against infrastructure you own or are authorized to use.

## Validation

Run the checks relevant to your change:

```bash
pnpm check
pnpm typecheck
pnpm test
pnpm docs:check
```

For changes affecting browser behavior, also run:

```bash
pnpm exec playwright install chromium
pnpm test:e2e:mock
```

The pull request workflow performs additional production builds, infrastructure synthesis, dependency audits, and secret scanning.

## Pull Requests

Open pull requests against `main` and complete the pull request template. Include:

- A concise explanation of what changed and why
- Any security, compatibility, cloud-resource, cost, migration, or teardown impact
- The exact validation commands you ran and their results
- Related issues using `Closes #...` when appropriate

Maintainers may request changes or decline contributions that expand project scope, weaken safety controls, or introduce ongoing maintenance costs.

## License

By contributing, you agree that your contributions will be licensed under the project's [MIT License](LICENSE).
