# Security Policy

## Supported versions

Security fixes are considered for the latest GitHub release. Older releases and unreleased `main` are not supported. This is a personal project maintained on a best-effort basis; no response or fix timeline is guaranteed.

## Report a vulnerability

Do not use public issues, discussions, pull requests, or logs. Use [GitHub private vulnerability reporting](https://github.com/shanebishop1/mc-aws/security/advisories/new) and include the affected version, impact, minimal reproduction, suggested mitigation, and whether cloud resources or credentials may be exposed.

Remove tokens, cookies, private hostnames, account IDs, and resource IDs unless strictly necessary. Never submit active secrets.

Only test deployments you own or are authorized to test. Do not access another user's data, disrupt service, create costs for others, or retain exposed credentials. Report upstream AWS, Cloudflare, Google, Minecraft, or dependency issues to the provider when appropriate.

## Deployment boundaries

- The EC2 security group exposes TCP port `25565` to all public IPv4 addresses. SSH port 22 is closed; administration uses SSM Session Manager.
- The tracked server settings use `online-mode=true`, `white-list=true`, and `enforce-whitelist=true`. Keep a real player UUID/name list and review changes to these settings.
- **Anonymous access:** callers can see server state, the public IP or hostname while running, volume presence, and CloudFormation stack existence/status. Instance and stack IDs are hidden.
- **Signed-in but unapproved access:** a valid Google user outside the allowlist can also use authenticated player-count and status views. Signing in does not grant lifecycle or administration actions.
- Panel sessions use signed, HTTP-only cookies that expire after 30 days. Removing a user from the panel allowlist changes their role within about five minutes, but a stolen cookie remains valid until it expires or `AUTH_SECRET` is rotated.
- Google Drive setup requests full Drive scope so it can find archives created by older clients. Treat the token as access to the user's Drive, not just this app's folder.
- Backup archives are gzip-compressed tar files, not application-encrypted archives. Drive account controls and Google storage encryption protect them, but anyone who obtains an archive can read world data and server files in plaintext.
- `.env`, `.env.local`, and `.env.production` may contain Google, Cloudflare, DNS, OAuth, session-signing, and other credentials. They are gitignored but remain credential-bearing local files. Restrict local access and backups.
- Runtime identities are separate. The EC2 instance profile reads required SSM/profile data and performs server tasks. Lambda controls the managed instance and sends SSM commands. The Worker uses a deployment-scoped, highly privileged IAM identity: compromise of the Worker can invoke lifecycle Lambda, stop EC2, run shell commands through SSM, and read selected parameters including the Drive credential. Human deployment credentials remain only in the local AWS CLI chain and must not be uploaded to the Worker.
- `START_KEYWORD` selects an inbound email command. It is not a credential. Inbound authorization still depends on SES mail checks, `ADMIN_EMAIL`, and the email allowlist; do not treat a hard-to-guess keyword as access control.
- Server-profile validation scans only the selected profile and checks a limited set of filenames, file types, sizes, JSON structures, and credential-like text. It is not a general secret scanner and does not inspect unrelated local files. Review profile content before deployment.
- `NOTIFICATION_EMAIL` receives notices but is not an inbound-email admin. Saving the panel allowlist retains it alongside `ADMIN_EMAIL` and `ALLOWED_EMAILS`. Only `ADMIN_EMAIL` can issue inbound admin commands.

## If credentials or data are exposed

1. Stop using the affected panel or automation and preserve only sanitized logs needed for investigation.
2. Revoke or rotate the exposed session signing secret, Google OAuth/Drive token, Cloudflare tokens, DNS tokens, and AWS keys as applicable. If the Worker identity may be exposed, revoke its access key immediately. Sign in again after rotating the session secret.
3. Remove unknown panel allowlist entries and review inbound-email settings.
4. Review CloudTrail, Cloudflare activity, Google account access, SSM parameters, EC2 volumes/snapshots, Drive files, and billing for unauthorized actions. Review host and backup integrity because the Worker identity can run commands on EC2 and read the Drive credential.
5. Redeploy or restore from a verified backup if server or panel files may have changed.
6. Follow [Safe Teardown](docs/TEARDOWN.md) if the deployment cannot be trusted; do not broadly delete resources by name.

See [AWS Credentials Setup](docs/AWS_CREDENTIALS_SETUP.md), [Operations Guide](docs/OPERATIONS_GUIDE.md), and [Server Profiles](docs/SERVER_PROFILES.md).
