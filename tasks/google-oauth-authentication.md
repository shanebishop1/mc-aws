# Tasks - Google Oauth Authentication

## In Progress


## To Do


## Backlog


## Done

- [x] [engineer] Install Arctic and jose dependencies - Add `arctic` (OAuth 2.0 client) and `jose` (JWT handling) packages to the project. Both are edge-runtime compatible. Reference: PRD at docs/goals/google-oauth-authentication-prd-2026-01-09.md
- [x] [engineer] Update lib/env.ts with auth environment variables - Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, AUTH_SECRET, ADMIN_EMAIL, ALLOWED_EMAILS to env validation. AUTH_SECRET, ADMIN_EMAIL required in production only. ALLOWED_EMAILS is optional (comma-separated). Add isDev flag based on NODE_ENV. Reference: lib/env.ts, PRD docs/goals/google-oauth-authentication-prd-2026-01-09.md
- [x] [engineer] Create lib/auth.ts - Auth utility module with: (1) createSession(email) - creates JWT with role determination, (2) verifySession(token) - validates JWT and returns payload, (3) getUserRole(email) - returns 'admin'|'allowed'|'public' based on env vars, (4) Cookie helpers for session management. Use jose for JWT. Reference: PRD docs/goals/google-oauth-authentication-prd-2026-01-09.md
- [x] [engineer] Create app/api/auth/login/route.ts - GET handler that: (1) In dev mode, optionally bypass or simulate auth, (2) In prod, generate state + code verifier using Arctic helpers, (3) Store state and code_verifier in HTTP-only cookies, (4) Redirect to Google OAuth URL with PKCE. Scopes: openid, email, profile. Reference: PRD for Arctic patterns
- [x] [engineer] Create app/api/auth/callback/route.ts - GET handler that: (1) Validate state from query matches cookie, (2) Exchange code for tokens using Arctic's validateAuthorizationCode with codeVerifier, (3) Fetch user email from Google userinfo endpoint, (4) Create JWT session cookie using lib/auth.ts, (5) Redirect to home page. Handle errors gracefully. Reference: PRD for Arctic patterns
- [x] [engineer] Create app/api/auth/logout/route.ts - POST handler that clears the session cookie and returns success. Simple endpoint, no external calls needed.
- [x] [engineer] Create app/api/auth/me/route.ts - GET handler that: (1) Reads session from cookie, (2) Returns { authenticated: boolean, email?: string, role?: string }. Used by frontend to determine UI state. Reference: lib/auth.ts
- [x] [engineer] Create middleware.ts - Next.js middleware that: (1) Skips auth check entirely in dev mode (isDev from env), (2) In prod, extracts JWT from cookie and validates, (3) Attaches user info to request headers for downstream routes, (4) Does NOT block requests - just enriches context. API routes handle their own authorization. Reference: PRD authorization matrix, lib/auth.ts
- [x] [engineer] Create lib/api-auth.ts - Helper functions for API route authorization: (1) requireAuth(request) - returns user or throws 401, (2) requireRole(request, minRole) - checks role hierarchy, throws 403 if insufficient, (3) isDevMode() - returns true if auth should be bypassed. Used by protected API routes. Reference: PRD authorization matrix
- [x] [engineer] Update public API routes (status, players, stack-status) - Add auth context extraction but allow unauthenticated access. Log user if authenticated. Routes: app/api/status/route.ts, app/api/players/route.ts, app/api/stack-status/route.ts. Reference: lib/api-auth.ts, PRD matrix
- [x] [engineer] Update allow-list protected routes (start, stop) - Add authorization check requiring 'allowed' or 'admin' role. Return 401 if not authenticated, 403 if authenticated but not authorized. In dev mode, bypass checks. Routes: app/api/start/route.ts, app/api/stop/route.ts. Reference: lib/api-auth.ts, PRD matrix
- [x] [engineer] Update admin-only routes - Add authorization check requiring 'admin' role. Routes: app/api/backup/route.ts, app/api/restore/route.ts, app/api/hibernate/route.ts, app/api/resume/route.ts, app/api/costs/route.ts, app/api/backups/route.ts (if exists), app/api/deploy/route.ts, app/api/destroy/route.ts, app/api/gdrive/*/route.ts. Reference: lib/api-auth.ts, PRD matrix
- [x] [engineer] Create components/auth/login-button.tsx - Client component that: (1) Shows 'Sign in with Google' when not authenticated, (2) Shows user email + 'Sign out' when authenticated, (3) Uses /api/auth/me to check auth state, (4) Redirects to /api/auth/login on sign in click, (5) Calls /api/auth/logout on sign out. Reference: app/api/auth/me/route.ts
- [x] [engineer] Create components/auth/auth-provider.tsx - React context provider that: (1) Fetches auth state from /api/auth/me on mount, (2) Provides { user, isLoading, isAuthenticated, role } to children, (3) Exports useAuth() hook. Used to conditionally render UI based on auth state.
- [x] [engineer] Update frontend to use auth context - (1) Wrap app in AuthProvider, (2) Add LoginButton to header/nav, (3) Disable/hide action buttons based on user role, (4) Show appropriate messaging for unauthorized actions. Reference: components/auth/auth-provider.tsx, PRD authorization matrix
- [x] [engineer] Add production build validation - Update build configuration or add a prebuild script that validates required auth env vars (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, AUTH_SECRET, ADMIN_EMAIL) are present when NODE_ENV=production. Fail build with clear error message if missing. Reference: lib/env.ts
- [x] [engineer] Update README.md with authentication documentation - Add new section covering: (1) Google Cloud Console OAuth setup steps, (2) Required environment variables for production, (3) Explanation of three authorization tiers, (4) How to configure ALLOWED_EMAILS, (5) Development mode behavior (auth bypassed). Reference: README.md, PRD
