# DuckDNS Prerequisite

DuckDNS is an optional Minecraft hostname. It does not host the web panel; the panel still requires Cloudflare Workers.

1. Sign in at [DuckDNS](https://www.duckdns.org).
2. Create a subdomain such as `myserver`.
3. Copy the account token.

During setup, choose DuckDNS and enter:

- `DUCKDNS_DOMAIN`: only `myserver`, without `.duckdns.org`
- `DUCKDNS_TOKEN`: the account token

The token is sensitive. Setup hides it and stores it in gitignored credential-bearing env files before deployment. After deployment safety checks and confirmation succeed, setup writes it directly to `/minecraft/duckdns-token` as an SSM `SecureString`; it is not passed through CloudFormation or command arguments. Setup validates only that it has UUID format; the first runtime DNS update is the first authentication check against DuckDNS.

When EC2 starts, the runtime updates `myserver.duckdns.org` to the current public IP. You may instead choose raw IP mode and use the address shown in the panel.

Continue with [Setup and Run](SETUP_AND_RUN.md).
