# PRD: Auth Route Regression Suite

**Epic:** Testing Expansion for High-Risk Paths  
**Feature:** Auth Route Regression Suite  
**Status:** Draft (execution-ready)  
**Owner:** Planning

## 1) Objective

Add deterministic regression coverage for OAuth entry/callback/session routes to prevent auth breakage from state, cookie, and rate-limit edge cases.

## 2) Scope and Non-Goals

### In Scope

- Unit/integration tests for `/api/auth/login`, `/api/auth/callback`, `/api/auth/me`, `/api/auth/logout`.
- Success and failure path assertions for missing params/cookies, state mismatch, token/userinfo errors, and rate-limit handling.
- One integration smoke path covering login-to-session state transition with mocked providers.

### Non-Goals

- Full browser OAuth provider E2E against external Google systems.
- Rewriting auth route behavior outside bug fixes uncovered by tests.

## 3) Impacted Files/Areas

- `app/api/auth/login/route.ts` tests (new)
- `app/api/auth/callback/route.ts` tests (new)
- `app/api/auth/me/route.ts` tests (new)
- `app/api/auth/logout/route.ts` tests (new)
- shared auth test helpers under `tests/`

## 4) Dependencies

- Requires high-risk matrix/harness feature completion.
- Should run under CI baseline gate once implemented.

## 5) Implementation Task Checklist

- ST-1 (Execution Gate: OAuth Route Core Coverage)
  - T-1.1 | Lane: TEST-A1 | Task: Add login route regression tests
    - Action: Cover OAuth config missing, cookie setup flags, popup flag behavior, and rate-limit redirect/retry header.
    - Definition of Done: `/api/auth/login` tests assert redirect targets, cookie attributes, and throttle behavior.
  - T-1.2 | Lane: TEST-A1 | Task: Add callback route regression tests
    - Action: Cover missing params, state mismatch, token exchange failure, userinfo failure, and successful session creation paths.
    - Definition of Done: `/api/auth/callback` tests assert cookie clearing, session cookie set, and popup/non-popup response behavior.
- ST-2 (Execution Gate: Session Endpoint and Flow Integrity)
  - T-2.1 | Lane: TEST-A2 | Task: Add auth me/logout endpoint tests
    - Action: Cover valid session, invalid session, missing session, and logout cookie-clearing contract.
    - Definition of Done: `/api/auth/me` and `/api/auth/logout` response contracts are fully asserted across session states.
  - T-2.2 | Lane: TEST-A2 | Task: Add auth integration smoke sequence
    - Action: Build a non-browser integration suite validating login-to-callback-to-me state transition with mocked dependencies.
    - Definition of Done: A single integration suite proves end-to-end auth session lifecycle for the primary happy path.

## 6) Acceptance Criteria

- High-risk auth routes have deterministic success/failure coverage.
- Cookie/session semantics are explicitly asserted.
- Rate-limit and state mismatch behavior is tested, not assumed.
- A smoke integration sequence guards core auth lifecycle regressions.
