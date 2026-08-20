# Cloudflare Setup

Cloudflare is used for separate concerns:

- Workers deployment for the web app
- Optional DNS updates for the Minecraft server
- Optional custom DNS for the panel (not needed with `workers.dev`)

Do not mix these credentials up.

You do not need a Cloudflare-managed custom domain to run mc-aws. The panel can run on Cloudflare Workers' `*.workers.dev` URL, and the Minecraft server can use either [DuckDNS](DUCKDNS_SETUP.md) or raw public IP mode.

## 1. Choose Panel Hosting

The setup wizard offers:

- `workers.dev`: no custom domain or panel DNS token is required. Enter your account Workers subdomain (for example `account-name.workers.dev`) or the full expected URL. With Worker name `mc-aws-panel`, setup derives `https://mc-aws-panel.account-name.workers.dev`.
- Custom Cloudflare hostname: provide an HTTPS origin such as `https://panel.example.com`, then choose managed or external DNS. `PANEL_DNS_MANAGEMENT=managed` (the default) also requires a zone-scoped token with DNS Read/Edit plus Workers Routes Read/Edit so deploy can ensure and record DNS. Choose `PANEL_DNS_MANAGEMENT=external` for an already-proxied, externally managed record; setup validates the zone ID locally and uses the shell deploy token for a read-only zone check when available. Deploy leaves DNS and the DNS manifest untouched while still requiring route API access and checking exact route ownership before and after deployment. If Wrangler recreates an exact same-pattern, same-target route, deploy records the new ID as project-created only through an explicit transition from the validated old ID; any identity, target, or ownership-proof mismatch stops the deployment flow.

Panel hosting does not determine the Minecraft connection address. Cloudflare Minecraft DNS, DuckDNS, and raw-IP modes all work with either panel choice.

## 2. Add Your Domain To Cloudflare (Custom Hostnames Only)

1. Create or sign in to a Cloudflare account.
2. Add your domain to Cloudflare.
3. Change your registrar nameservers to the Cloudflare nameservers.
4. Wait for Cloudflare to show the zone as active.

Cloudflare docs:

- https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/

## 3. Choose Domains

Use separate hostnames unless you have a specific reason not to:

- Panel URL: `https://panel.example.com`
- Minecraft domain: `mc.example.com`

The setup wizard asks for the Minecraft domain as `CLOUDFLARE_MC_DOMAIN`.

The setup wizard asks for the panel URL as `NEXT_PUBLIC_APP_URL`.

## 4. Create DNS API Tokens

The wizard stores panel and Minecraft DNS credentials separately because they can use different zones and because workers.dev needs no DNS token:

- `CLOUDFLARE_PANEL_DNS_API_TOKEN` / `CLOUDFLARE_PANEL_ZONE_ID`: deploy-time custom panel DNS and route ownership. External DNS mode does not require the panel DNS token, but still requires the zone ID.
- `CLOUDFLARE_DNS_API_TOKEN` / `CLOUDFLARE_ZONE_ID`: runtime Minecraft DNS updates only.

Neither DNS token is the credential used to deploy Workers.

For external DNS mode, one shell-only `CLOUDFLARE_API_TOKEN` may transiently serve both Wrangler deployment and Workers Routes API checks. It is never copied into an env file, build input, or Worker secret. This fallback is not used in managed DNS mode.

1. Open Cloudflare dashboard.
2. Go to **My Profile -> API Tokens**.
3. Create a custom token for the panel zone.
4. Scope it to the specific zone.
5. For a custom panel hostname, give it `Zone -> DNS -> Read/Edit` and `Zone -> Workers Routes -> Read/Edit`. The route permissions are required to distinguish a project-created route from a pre-existing route during deployment and teardown. A Minecraft-only runtime token needs only `Zone -> DNS -> Edit`.
6. Copy the token.

Cloudflare docs:

- https://developers.cloudflare.com/fundamentals/api/get-started/create-token/

## 5. Get The Zone ID

1. Open your domain in Cloudflare.
2. Go to the domain overview page.
3. Copy the **Zone ID**.

## 6. DNS Record ID

Custom panel deployment can create its missing proxied panel record. For a Cloudflare Minecraft hostname, create an A record first (a placeholder IP is fine); the runtime updater locates it by hostname, so the legacy `CLOUDFLARE_RECORD_ID` value can be left empty.

## 7. Wrangler Login

Workers deployment uses Wrangler OAuth:

```bash
pnpm exec wrangler login
```

The deploy script also attempts login if Wrangler is not authenticated.

## Values Needed Later

The setup wizard asks for:

- `PANEL_HOSTING_MODE` (`workers_dev` or `custom`)
- `PANEL_DNS_MANAGEMENT` (`managed` or `external`) for custom hosting; leave it empty for `workers_dev`
- `CLOUDFLARE_WORKERS_SUBDOMAIN` for workers.dev, or panel zone/token values for a custom hostname
- Minecraft DNS values only when Cloudflare is the Minecraft connection mode

Setup derives and persists `NEXT_PUBLIC_APP_URL` for workers.dev. For a custom hostname, it validates the URL you enter.

## Important

- Use `wrangler login` for Workers deployment.
- Use `CLOUDFLARE_DNS_API_TOKEN` for runtime DNS updates.
- Do not export `CLOUDFLARE_DNS_API_TOKEN` globally in your shell. It can confuse Wrangler auth.
