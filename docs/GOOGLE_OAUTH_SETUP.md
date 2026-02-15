# Google OAuth Setup

This guide configures Google sign-in for the control panel.

## What OAuth controls

After sign-in, server-side role mapping controls permissions:

- `ADMIN_EMAIL` -> admin
- `ALLOWED_EMAILS` -> allowed
- any other authenticated user -> public

## Create OAuth credentials

1. Go to Google Cloud Console.
2. Create or select a project.
3. Open **APIs & Services -> OAuth consent screen** and configure required fields.
4. Add test users if your app is not published.
5. Open **APIs & Services -> Credentials**.
6. Create **OAuth client ID** with application type **Web application**.

## Add authorized redirect URIs

Add both:

- `http://localhost:3000/api/auth/callback`
- `https://mc.yourdomain.com/api/auth/callback`

Replace `mc.yourdomain.com` with your production panel URL.

## Add values to env files

Set these in `.env.local` and `.env.production`:

```bash
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
NEXT_PUBLIC_APP_URL=http://localhost:3000   # local
# .env.production should use your real domain, e.g. https://mc.yourdomain.com
```

Also set role emails:

```bash
ADMIN_EMAIL=you@example.com
ALLOWED_EMAILS=friend1@example.com,friend2@example.com
```

## Test locally

```bash
pnpm dev
```

Then:

1. Open `http://localhost:3000`.
2. Click sign in.
3. Confirm callback returns to `/api/auth/callback` and then `/`.

## Production notes

Before deploying, confirm `.env.production` has:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `NEXT_PUBLIC_APP_URL` (your real HTTPS domain)
- `AUTH_SECRET`

Then deploy:

```bash
wrangler login
pnpm deploy:cf
```

## Troubleshooting

### `redirect_uri_mismatch`

- Redirect URI in Google Console does not match app callback URL.
- Add exact URLs listed above.

### OAuth button appears but flow fails immediately

- Missing `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, or `NEXT_PUBLIC_APP_URL`.
- Restart `pnpm dev` after env changes.

### Login works but permissions look wrong

- Check `ADMIN_EMAIL` and `ALLOWED_EMAILS` values.
- Emails are normalized server-side; make sure addresses are correct.

## Related docs

- [AWS Credentials Setup](AWS_CREDENTIALS_SETUP.md)
- [Cloudflare Setup](CLOUDFLARE_SETUP.md)
- [README](../README.md)
