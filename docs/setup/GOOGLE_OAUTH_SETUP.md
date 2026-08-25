# Google OAuth Setup

Google OAuth is used for signing in to the web panel.

## 1. Create Or Select A Google Cloud Project

1. Open Google Cloud Console.
2. Create a project or select an existing one.

Google docs:

- https://developers.google.com/workspace/guides/create-project

## 2. Configure OAuth Consent And Audience

1. Open **Google Auth Platform -> Branding** and complete the required app information.
2. Open **Google Auth Platform -> Audience**.
3. Use **External** for a personal app used outside one Google Workspace organization.
4. If **Publishing status** is **Testing**, add every Google account that will sign in or connect Drive under **Test users**, including `ADMIN_EMAIL` and any `ALLOWED_EMAILS` users.
5. An **Internal** app is limited to users in its Google Workspace organization.

External apps in Testing can receive refresh tokens that expire after seven days when Drive scopes are used. For durable unattended backups, move the app to **In production** when you are ready and complete any Google requirements shown for the app.

Google docs:

- https://support.google.com/cloud/answer/10311615

## 3. Enable The Google Drive API

If you will use Google Drive backups:

1. Open **APIs & Services -> Library** in the same project as the OAuth client.
2. Find **Google Drive API**.
3. Click **Enable**.

OAuth consent can succeed while the Drive API is disabled, but backup listing and restore will then fail with `SERVICE_DISABLED`.

Drive setup requests full Drive access so it can restore archives created by previous rclone OAuth clients. Google may classify this as a sensitive or restricted scope and show additional publishing or verification guidance. Keep the app limited to your intended users and use a dedicated backup folder/account where practical.

## 4. Create A Web OAuth Client

1. Open **APIs & Services -> Credentials**.
2. Click **Create credentials -> OAuth client ID**.
3. Choose **Web application**.

Add authorized JavaScript origins:

```text
http://localhost:3000
https://panel.example.com
https://mc-aws-panel.account-name.workers.dev
```

Add authorized redirect URIs:

```text
http://localhost:3000/api/auth/callback
https://panel.example.com/api/auth/callback
https://mc-aws-panel.account-name.workers.dev/api/auth/callback
```

If you plan to use Google Drive backups, also add:

```text
http://localhost:3000/api/gdrive/callback
https://panel.example.com/api/gdrive/callback
```

Use only the origin and callbacks for the panel hosting mode selected during setup. Setup prints the exact origin, sign-in callback, and Drive callback. A workers.dev callback must match the derived Worker URL exactly; do not add `/google`.

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
