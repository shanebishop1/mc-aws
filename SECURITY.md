# Security Policy

## Supported Versions

Security fixes are considered for the latest GitHub release.

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| Older releases | No |
| Unreleased `main` branch | No |

This is a personal project maintained on a best-effort basis. A response or remediation timeline is not guaranteed.

## Reporting a Vulnerability

Do not report suspected vulnerabilities through public issues, discussions, pull requests, or logs.

Use [GitHub private vulnerability reporting](https://github.com/shanebishop1/mc-aws/security/advisories/new). Include:

- The affected version or commit
- A description of the vulnerability and its potential impact
- Minimal reproduction steps or a proof of concept
- Any suggested mitigation
- Whether the issue may expose credentials or cloud resources

Remove credentials, tokens, session cookies, private hostnames, account IDs, and resource IDs unless they are strictly necessary. Never include active secrets.

The maintainer will assess reports when available, may request additional information, and will coordinate disclosure when a fix is practical.

## Safe Research

Only test against deployments and cloud resources you own or are explicitly authorized to use. Do not access other users' data, disrupt services, incur costs for others, or retain exposed credentials.

Vulnerabilities in AWS, Cloudflare, Google, GitHub, Minecraft, or another upstream dependency should also be reported through that provider's security process when appropriate.

## Deployment Security

This project manages cloud infrastructure and credentials. Deployers are responsible for securing their accounts, reviewing IAM permissions, monitoring costs, and protecting local configuration.

See the following guides:

- [AWS Credentials Setup](docs/AWS_CREDENTIALS_SETUP.md)
- [Ownership-Aware Teardown](docs/TEARDOWN.md)
- [Operations Guide](docs/OPERATIONS_GUIDE.md)
