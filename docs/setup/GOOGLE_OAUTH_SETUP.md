# Google OAuth Setup

Google OAuth is used for signing in to the web panel.

## 1. Create Or Select A Google Cloud Project

1. Open Google Cloud Console.
2. Create a project or select an existing one.

Google docs:

- https://developers.google.com/workspace/guides/create-project

## 2. Configure OAuth Consent

1. Open **APIs & Services -> OAuth consent screen**.
2. Complete the required app information.
3. Use **External** for normal personal use.
4. Add yourself as a test user if the app is in testing mode.

Google docs:

- https://support.google.com/cloud/answer/10311615

## 3. Create A Web OAuth Client

1. Open **APIs & Services -> Credentials**.
2. Click **Create credentials -> OAuth client ID**.
3. Choose **Web application**.

Add authorized JavaScript origins:

```text
http://localhost:3000
https://panel.example.com
```

Add authorized redirect URIs:

```text
http://localhost:3000/api/auth/callback
https://panel.example.com/api/auth/callback
```

If you plan to use Google Drive backups, also add:

```text
http://localhost:3000/api/gdrive/callback
https://panel.example.com/api/gdrive/callback
```

Replace `https://panel.example.com` with your real panel URL.

## Values Needed Later

The setup wizard asks for:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

The wizard also asks for:

- `ADMIN_EMAIL`
- `ALLOWED_EMAILS`

Use the same email address for `ADMIN_EMAIL` that you will use to sign in with Google.

## Notes

- Callback URLs must match exactly.
- Do not add `/google` to the callback path.
- Local dev can use the built-in dev login instead of Google OAuth.
