# Google OAuth Prerequisite

Create the OAuth client before running production setup. Add the production URLs only after setup chooses the panel hostname and prints the exact values.

## Before setup: create the client

1. Create or select a project in Google Cloud Console.
2. Configure **Google Auth Platform -> Branding** and **Audience**.
3. For an External app in Testing, add every account that will sign in under **Test users**.
4. If using backups, enable **Google Drive API** in the same project.
5. Create **OAuth client ID -> Web application**.
6. Copy the client ID and client secret for the setup wizard.

Drive backups request the full Google Drive scope and persist a refresh-token/client-secret bundle in encrypted SSM. Where practical, authorize a dedicated Google account that has no unrelated Drive files.

For optional local Google sign-in, add:

- Authorized JavaScript origin: `http://localhost:3000`
- Redirect URI: `http://localhost:3000/api/auth/callback`
- Drive redirect URI: `http://localhost:3000/api/gdrive/callback` if using Drive locally

Local development can use dev login instead, so localhost entries are optional.

## During setup: copy exact production URLs

After panel hosting is selected, setup prints:

- the authorized JavaScript origin
- the sign-in redirect ending in `/api/auth/callback`
- the Drive redirect ending in `/api/gdrive/callback`

Add those exact values to the same Web application client before deployment continues. This includes a `workers.dev` deployment: copy the printed origin and callbacks rather than constructing the account subdomain yourself. Do not append `/google`.

Use the Google account that matches `ADMIN_EMAIL`. `ALLOWED_EMAILS` contains additional users. If the app remains in Testing, all of them must be test users.

Testing-mode refresh tokens that use Drive scopes can expire after seven days. For unattended backups, move the app to **In production** when appropriate and complete any Google requirements shown for the requested Drive scope.

## Troubleshooting

- `redirect_uri_mismatch`: compare the Google entry character-for-character with setup's printed callback.
- Login works but Drive fails with `SERVICE_DISABLED`: enable Google Drive API in the OAuth client's project.
- A user is blocked in Testing: add that account under **Audience -> Test users**.

Continue with [Setup and Run](SETUP_AND_RUN.md).
