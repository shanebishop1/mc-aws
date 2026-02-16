# Cloudflare Setup

This guide covers Cloudflare configuration for both:

- **Workers deployment auth** (Wrangler OAuth)
- **Runtime DNS updates** (DNS API token used by app/Lambda)

These are intentionally separate.

## 1) Prepare DNS record for Minecraft domain

In Cloudflare DNS:

1. Create an `A` record for your Minecraft domain (example: `mc.yourdomain.com`).
2. Use a placeholder IP initially (it will be updated automatically later).
3. Use DNS-only for standard Minecraft traffic (unless you explicitly use Cloudflare Spectrum).

You will need:

- `CLOUDFLARE_ZONE_ID`
- `CLOUDFLARE_RECORD_ID`
- `CLOUDFLARE_MC_DOMAIN`

## 2) Get Zone ID

Cloudflare Dashboard -> domain -> Overview -> API section -> Zone ID.

## 3) Create DNS API token (runtime token)

Create a token with DNS edit permissions scoped to your zone.

Minimum intent:

- Zone -> DNS -> Edit
- Zone Resources -> specific zone

Save as:

- `CLOUDFLARE_DNS_API_TOKEN`

This token is for runtime DNS updates, not Wrangler deployment login.

## 4) Get DNS Record ID

Use Cloudflare API with your DNS token:

```bash
curl -X GET "https://api.cloudflare.com/client/v4/zones/<ZONE_ID>/dns_records" \
  -H "Authorization: Bearer <CLOUDFLARE_DNS_API_TOKEN>" \
  -H "Content-Type: application/json"
```

Find your `mc` record and copy its `id` as `CLOUDFLARE_RECORD_ID`.

## 5) Set env values

Set these in `.env`:

```bash
CLOUDFLARE_DNS_API_TOKEN=...
CLOUDFLARE_ZONE_ID=...
CLOUDFLARE_RECORD_ID=...
CLOUDFLARE_MC_DOMAIN=mc.yourdomain.com
NEXT_PUBLIC_APP_URL=https://mc.yourdomain.com
```

## 6) Authenticate Wrangler for deployment

Use Wrangler OAuth login:

```bash
wrangler login
```

Important:

- Do not rely on DNS token auth for deployment.
- `scripts/deploy-cloudflare.sh` already unsets `CLOUDFLARE_DNS_API_TOKEN` before invoking Wrangler to avoid auth collisions.

## 7) Deploy

```bash
pnpm deploy:cf
```

The deploy script validates env, uploads secrets, builds, and deploys the Worker.

## Troubleshooting

### `wrangler login` fails or behaves like API-token mode

- Remove exported `CLOUDFLARE_DNS_API_TOKEN` from your shell session.
- Re-run `wrangler login`.
- Use `.env` for DNS token storage instead of global shell exports.

### DNS is not updating after server start

- Verify `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_RECORD_ID`, and `CLOUDFLARE_DNS_API_TOKEN` values.
- Confirm token has DNS edit scope for the correct zone.
- Check app/lambda logs for Cloudflare API errors.

## Related docs

- [AWS Credentials Setup](AWS_CREDENTIALS_SETUP.md)
- [Google OAuth Setup](GOOGLE_OAUTH_SETUP.md)
- [README](../README.md)
