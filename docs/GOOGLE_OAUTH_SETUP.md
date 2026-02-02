# Google OAuth Setup Guide

This guide shows you how to set up Google OAuth for both local development and production deployment.

## Why Google OAuth?

The control panel uses Google OAuth to authenticate users and control who can:
- View server status (everyone)
- Start the server (allowed users)
- Backup/restore/hibernate (admin only)

## Create Google OAuth Credentials

### 1. Go to Google Cloud Console

Visit [Google Cloud Console](https://console.cloud.google.com/)

### 2. Create a Project (if you don't have one)

- Click the project dropdown at the top
- Click "New Project"
- Name it (e.g., "Minecraft Control Panel")
- Click "Create"

### 3. Enable Google+ API

- Go to **APIs & Services** → **Library**
- Search for "Google+ API"
- Click it and press "Enable"

### 4. Configure OAuth Consent Screen

- Go to **APIs & Services** → **OAuth consent screen**
- Choose **External** (unless you have Google Workspace)
- Click "Create"

**Fill in required fields:**
- App name: `Minecraft Control Panel`
- User support email: Your email
- Developer contact: Your email
- Click "Save and Continue"

**Scopes:** Skip this (click "Save and Continue")

**Test users:** Add your email and any friends who will use the panel
- Click "Add Users"
- Enter email addresses
- Click "Save and Continue"

**Summary:** Click "Back to Dashboard"

### 5. Create OAuth Client ID

- Go to **APIs & Services** → **Credentials**
- Click **Create Credentials** → **OAuth client ID**
- Application type: **Web application**
- Name: `MC Control Panel`

**Authorized redirect URIs:**

Add BOTH of these:

```
http://localhost:3000/api/auth/callback/google
https://mc.yourdomain.com/api/auth/callback/google
```

**Important:** 
- First URI is for local development
- Second URI is for production (replace `mc.yourdomain.com` with YOUR domain)
- You can add more URIs later

Click **Create**

### 6. Copy Your Credentials

You'll see a popup with:
- **Client ID**: Something like `123456789-abcdefg.apps.googleusercontent.com`
- **Client Secret**: Something like `GOCSPX-abc123xyz789`

**Copy both of these!**

## Set Up for Local Development

Add to your `.env.local`:

```bash
GOOGLE_CLIENT_ID=123456789-abcdefg.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-abc123xyz789
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

Test it:

```bash
pnpm dev
# Visit http://localhost:3000
# Click "Sign in with Google"
# Should redirect to Google, then back to your app
```

## Set Up for Production

Add to your `.env.production`:

```bash
GOOGLE_CLIENT_ID=123456789-abcdefg.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-abc123xyz789
NEXT_PUBLIC_APP_URL=https://mc.yourdomain.com
```

The deploy script will automatically upload these as secrets to Cloudflare.

## How It Works

### Local Development Flow:
1. User clicks "Sign in with Google"
2. Redirects to: `https://accounts.google.com/o/oauth2/v2/auth?client_id=...&redirect_uri=http://localhost:3000/api/auth/callback/google`
3. User approves
4. Google redirects back to: `http://localhost:3000/api/auth/callback/google?code=...`
5. Your app exchanges the code for user info
6. Sets a session cookie for 7 days

### Production Flow:
Exactly the same, but uses `https://mc.yourdomain.com` instead of `localhost`.

## Testing Different User Roles

The control panel has 3 roles:

| Role | Permissions |
|------|-------------|
| **Admin** | Can view status, start, stop, backup, restore, hibernate |
| **Allowed** | Can view status, start server |
| **Public** | Can only view status |

**How roles are assigned:**

```bash
# In .env.local or .env.production
ADMIN_EMAIL=you@gmail.com                    # Gets admin role
ALLOWED_EMAILS=friend1@gmail.com,friend2@gmail.com  # Get allowed role
# Anyone else who signs in gets public role
```

**To test different roles locally:**

```bash
# Option 1: Change ADMIN_EMAIL in .env.local to your test email

# Option 2: Use dev login (bypasses Google OAuth)
ENABLE_DEV_LOGIN=true
# Then visit http://localhost:3000/api/auth/dev-login
# Edit app/api/auth/dev-login/route.ts to change the role
```

## Troubleshooting

### Error: "redirect_uri_mismatch"

**Cause:** The redirect URI in your OAuth config doesn't match the one your app is using.

**Fix:** 
1. Check the error message for the URI your app is trying to use
2. Go to Google Cloud Console → Credentials → Edit OAuth client
3. Add that exact URI to "Authorized redirect URIs"

### Error: "Access blocked: This app's request is invalid"

**Cause:** OAuth consent screen not configured or missing required fields.

**Fix:** 
1. Go to **OAuth consent screen**
2. Make sure all required fields are filled
3. Add your email to "Test users" if the app is not published

### Can't see "Sign in with Google" button

**Cause:** Missing `GOOGLE_CLIENT_ID` or `NEXT_PUBLIC_APP_URL`.

**Fix:**
1. Check `.env.local` has both variables
2. Restart dev server: `pnpm dev`
3. Check browser console for errors

### Session expires immediately

**Cause:** Missing or weak `AUTH_SECRET`.

**Fix:**
```bash
# Add to .env.local
AUTH_SECRET=$(openssl rand -base64 48)
```

## Security Notes

- **Client Secret is SECRET**: Never commit it to git (it's in `.gitignore`)
- **Test Users Only**: If your OAuth app is not published, only emails in "Test users" can sign in
- **Publishing**: For production with many users, you may need to verify your app with Google
- **Session Cookie**: httpOnly, secure (in production), sameSite: lax
