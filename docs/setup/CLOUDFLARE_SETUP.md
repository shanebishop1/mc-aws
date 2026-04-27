# Cloudflare Setup

Cloudflare is used for two separate things:

- Workers deployment for the web app
- DNS updates for the Minecraft server and panel domains

Do not mix these credentials up.

## 1. Add Your Domain To Cloudflare

1. Create or sign in to a Cloudflare account.
2. Add your domain to Cloudflare.
3. Change your registrar nameservers to the Cloudflare nameservers.
4. Wait for Cloudflare to show the zone as active.

Cloudflare docs:

- https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/

## 2. Choose Domains

Use separate hostnames unless you have a specific reason not to:

- Panel URL: `https://panel.example.com`
- Minecraft domain: `mc.example.com`

The setup wizard asks for the Minecraft domain as `CLOUDFLARE_MC_DOMAIN`.

The setup wizard asks for the panel URL as `NEXT_PUBLIC_APP_URL`.

## 3. Create A DNS API Token

This token is for runtime DNS updates. It is not the token used to deploy Workers.

1. Open Cloudflare dashboard.
2. Go to **My Profile -> API Tokens**.
3. Create a token using **Edit zone DNS** or a custom token.
4. Scope it to the specific zone.
5. Give it `Zone -> DNS -> Edit` permission.
6. Copy the token.

Cloudflare docs:

- https://developers.cloudflare.com/fundamentals/api/get-started/create-token/

## 4. Get The Zone ID

1. Open your domain in Cloudflare.
2. Go to the domain overview page.
3. Copy the **Zone ID**.

## 5. DNS Record ID

The current deploy flow can create missing DNS records. If you already have a Minecraft DNS record, you can provide its record ID. Otherwise leave it empty during the wizard if prompted.

## 6. Wrangler Login

Workers deployment uses Wrangler OAuth:

```bash
pnpm exec wrangler login
```

The deploy script also attempts login if Wrangler is not authenticated.

## Values Needed Later

The setup wizard asks for:

- `CLOUDFLARE_DNS_API_TOKEN`
- `CLOUDFLARE_ZONE_ID`
- `CLOUDFLARE_RECORD_ID` if you already have one
- `CLOUDFLARE_MC_DOMAIN`
- `NEXT_PUBLIC_APP_URL`

## Important

- Use `wrangler login` for Workers deployment.
- Use `CLOUDFLARE_DNS_API_TOKEN` for runtime DNS updates.
- Do not export `CLOUDFLARE_DNS_API_TOKEN` globally in your shell. It can confuse Wrangler auth.
