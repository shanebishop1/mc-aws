# Google OAuth Authentication PRD

**Date:** 2026-01-09  
**Feature:** Optional Google OAuth Authentication with Authorization Tiers

## Summary

Add optional Google OAuth authentication to the mc-aws Minecraft server management system. The feature provides three authorization tiers (Public, Allow List, Admin) and enforces authentication only in production builds while allowing unrestricted access in development mode.

## Goals

- Secure the mc-aws frontend with Google OAuth authentication
- Implement three-tier authorization (Public, Allow List, Admin)
- Keep auth optional in development mode (`pnpm dev`)
- Require auth configuration in production builds (fail build if env vars missing)
- Use Arctic library for OAuth (lightweight, Cloudflare Workers compatible)
- Store sessions in signed/encrypted JWT cookies

## Non-Goals

- Database-backed sessions (cookie-only approach)
- Multiple OAuth providers (Google only)
- Role management UI (env vars only)
- Refresh token handling (rely on short session expiry + re-auth)

## Users

| User Type | Description |
|-----------|-------------|
| Public | Unauthenticated visitors - can only view server status |
| Allow List User | Authenticated user whose email is in `ALLOWED_EMAILS` - can start/stop server |
| Admin | Single authenticated user whose email matches `ADMIN_EMAIL` - full access |

## Use Cases

1. **Public visitor** opens the dashboard and sees server status (running/stopped, player count)
2. **Allow list user** logs in with Google and can start/stop the server
3. **Admin** logs in and has full control: backup, restore, hibernate, resume, cost explorer, deploy/destroy

## Authorization Matrix

| Endpoint | Public | Allow List | Admin |
|----------|--------|------------|-------|
| GET /api/status | Yes | Yes | Yes |
| GET /api/players | Yes | Yes | Yes |
| GET /api/stack-status | Yes | Yes | Yes |
| POST /api/start | No | Yes | Yes |
| POST /api/stop | No | Yes | Yes |
| POST /api/backup | No | No | Yes |
| POST /api/restore | No | No | Yes |
| POST /api/hibernate | No | No | Yes |
| POST /api/resume | No | No | Yes |
| GET /api/costs | No | No | Yes |
| GET /api/backups | No | No | Yes |
| */api/gdrive/* | No | No | Yes |
| POST /api/deploy | No | No | Yes |
| POST /api/destroy | No | No | Yes |

## Technical Design

### Environment Variables

| Variable | Required (Prod) | Description |
|----------|-----------------|-------------|
| `GOOGLE_CLIENT_ID` | Yes | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Yes | Google OAuth client secret |
| `AUTH_SECRET` | Yes | 32+ char secret for JWT signing/encryption |
| `ADMIN_EMAIL` | Yes | Email address with full admin access |
| `ALLOWED_EMAILS` | No | Comma-separated list of allowed emails (admin always allowed) |

### Development vs Production Behavior

- **Development (`pnpm dev`)**: Auth completely bypassed - all actions allowed
- **Production (`pnpm build`)**: Auth required, build fails if required env vars missing

### OAuth Flow (Arctic + PKCE)

1. User clicks "Sign in with Google"
2. `GET /api/auth/login` generates state + code verifier, stores in cookies, redirects to Google
3. User authenticates with Google
4. Google redirects to `GET /api/auth/callback` with authorization code
5. Server validates code, fetches user info (email), creates JWT session cookie
6. User redirected to dashboard with session established

### Session Management

- JWT stored in HTTP-only, secure, SameSite=Lax cookie
- JWT payload: `{ email, role, exp }`
- Role determined at login: `admin` | `allowed` | `public`
- Session expiry: 7 days
- No refresh tokens - user re-authenticates when session expires

### Middleware Authorization

- Middleware extracts and validates JWT from cookie
- Attaches `{ email, role }` to request context
- API routes check role against required permission level
- Returns 401 (unauthenticated) or 403 (unauthorized) as appropriate

### Library Choices

- **Arctic** (`arctic`): Lightweight OAuth 2.0 client, ~5KB, Cloudflare Workers compatible
- **jose**: JWT signing/verification, edge-runtime compatible

## Success Criteria

1. Build fails in production when auth env vars are missing
2. Development mode works without any auth configuration
3. Public endpoints (status, players) work without authentication
4. Allow list users can start/stop server but not admin actions
5. Admin has full access to all endpoints
6. Frontend shows appropriate UI based on auth state and role
7. OAuth flow works correctly on Cloudflare Workers (OpenNext)

## Dependencies & References

### Existing Source Files

- `lib/env.ts` - Environment variable validation (needs updates)
- `app/api/status/route.ts` - Example API route pattern
- `app/api/start/route.ts` - Example protected route pattern
- `README.md` - Documentation (needs auth section)

### External Documentation

- Arctic OAuth library: https://arcticjs.dev/
- Arctic Google provider: https://arcticjs.dev/providers/google
- Google Cloud Console (for OAuth setup): https://console.cloud.google.com/apis/credentials

### Key Arctic Usage Patterns

```typescript
// Initialization
import * as arctic from "arctic";
const google = new arctic.Google(clientId, clientSecret, redirectURI);

// Create auth URL with PKCE
const state = arctic.generateState();
const codeVerifier = arctic.generateCodeVerifier();
const scopes = ["openid", "email", "profile"];
const url = google.createAuthorizationURL(state, codeVerifier, scopes);

// Validate authorization code
const tokens = await google.validateAuthorizationCode(code, codeVerifier);
const accessToken = tokens.accessToken();
```

## File Structure (New/Modified Files)

```
app/
  api/
    auth/
      login/route.ts      # NEW: Initiates OAuth flow
      callback/route.ts   # NEW: Handles OAuth callback
      logout/route.ts     # NEW: Clears session
      me/route.ts         # NEW: Returns current user info
lib/
  auth.ts                 # NEW: Auth utilities (JWT, role checking)
  env.ts                  # MODIFY: Add auth env vars
middleware.ts             # NEW: Auth middleware
components/
  auth/
    login-button.tsx      # NEW: Login/logout button
    auth-provider.tsx     # NEW: Auth context provider
README.md                 # MODIFY: Add auth documentation section
```
