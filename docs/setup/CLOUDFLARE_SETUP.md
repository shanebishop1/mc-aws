# Cloudflare Prerequisite

A Cloudflare account with Workers enabled is required because the control panel runs on Cloudflare Workers. A custom domain is optional.

## Panel hosting

Choose this during setup, independently of the Minecraft address:

### `workers.dev`

No custom domain or DNS token is required. Find the account Workers subdomain in **Workers & Pages -> Account details**. Setup derives the exact URL for Worker `mc-aws-panel` and prints the Google OAuth origin and callbacks.

### Custom panel hostname

The domain must be in an active Cloudflare zone. Use a hostname such as `panel.example.com`.

- **Managed DNS:** create a zone-scoped panel token with **DNS Read/Edit** and **Workers Routes Read/Edit**. Setup may create or proxy the panel record and records ownership for teardown.
- **External DNS:** create a proxied record yourself. A proxied `A` record to placeholder `192.0.2.1` is valid because the Worker route handles requests. Before setup, export `MC_AWS_CLOUDFLARE_DEPLOY_TOKEN` with account access for Worker scripts, secrets, and KV, plus zone read and **Workers Routes Read/Edit** for the panel zone. The wizard verifies token, zone, and route-list access before returning to chargeable AWS deployment. Setup does not read or modify panel DNS and never persists this shell token.

Do not save the external shell deployment token in `.env.local` or `.env.production`.

## Wrangler authentication

The deploy script runs Wrangler with isolated `HOME=~/.config/mc-aws/wrangler-home`. It does not reuse a login created by a normal `pnpm exec wrangler login` command. Without `CLOUDFLARE_API_TOKEN`, setup opens a browser for OAuth in the isolated home and verifies that session.

Do not export a Minecraft DNS token globally. The deploy script reads it from the gitignored env file for runtime upload and removes it from Wrangler's authentication environment.

For AWS host DNS updates, setup and `pnpm cdk:deploy` materialize the token directly into `/minecraft/cloudflare-api-token` as an SSM `SecureString` only after the deployment safety guard succeeds. The token is not a CloudFormation parameter and is never passed in command arguments.

## Optional Minecraft DNS

This is separate from panel hosting. If players will use a Cloudflare hostname:

1. Add the domain to Cloudflare and wait for the zone to become active.
2. Create a DNS-only `A` record such as `mc.example.com`; a placeholder IP is fine.
3. Create a zone-scoped token with **DNS Edit** for that zone.
4. Copy the zone ID, hostname, and token for setup.

The runtime updater finds the record by hostname. `CLOUDFLARE_RECORD_ID` is optional legacy compatibility; leave it blank for a new setup. Do not create KV namespaces manually; deployment manages runtime-state KV.

If you do not want Cloudflare Minecraft DNS, choose [DuckDNS](DUCKDNS_SETUP.md) or raw public IP mode. Either works with `workers.dev` or a custom panel hostname.

## Troubleshooting

- Browser login repeats: setup's isolated Wrangler session is separate from the normal Wrangler session; let setup open the browser.
- External panel mode fails before deploy: confirm `MC_AWS_CLOUDFLARE_DEPLOY_TOKEN` is exported in the setup shell and has Workers/route access to the correct zone.
- Minecraft DNS does not update: confirm the DNS-only record exists, the zone ID and hostname match it, and the runtime token has DNS Edit for that zone.
- Panel DNS and Minecraft DNS may use different zones and tokens. Do not interchange them.

Continue with [Setup and Run](SETUP_AND_RUN.md).
