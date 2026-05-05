# DuckDNS Setup

DuckDNS is the free DNS option for the Minecraft connection address. It gives you a hostname like `myserver.duckdns.org` without buying a domain.

## Create A Subdomain

1. Go to https://www.duckdns.org.
2. Sign in with one of the supported providers.
3. Create a subdomain, for example `myserver`.
4. Copy your account token from the DuckDNS dashboard.

## Setup Wizard Values

When the wizard asks how players should connect, choose `Free DuckDNS subdomain`.

The wizard asks for:

- `DUCKDNS_DOMAIN`: the subdomain only, such as `myserver`.
- `DUCKDNS_TOKEN`: the token from the DuckDNS dashboard.

Do not include `.duckdns.org` in `DUCKDNS_DOMAIN`.

## How Updates Work

The EC2 startup DNS service reads `/minecraft/duckdns-domain` and `/minecraft/duckdns-token` from SSM Parameter Store. When the server starts and receives a public IP, it calls DuckDNS and points `DUCKDNS_DOMAIN.duckdns.org` at that IP.

If you skip both Cloudflare and DuckDNS, mc-aws runs in no-domain mode and the panel shows the raw public IP instead.
