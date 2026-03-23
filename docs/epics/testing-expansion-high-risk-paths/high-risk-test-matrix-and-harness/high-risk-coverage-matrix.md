# High-Risk Coverage Matrix (T-1.1)

This matrix is the execution contract for high-risk testing work under **Testing Expansion for High-Risk Paths**.

- Source PRD: `docs/epics/testing-expansion-high-risk-paths/high-risk-test-matrix-and-harness/prds/high-risk-test-matrix-and-harness-prd.md`
- Mandatory scope source: `docs/epics/testing-expansion-high-risk-paths/epic-overview/prds/testing-expansion-high-risk-paths-epic.md`
- Downstream suites: auth route regression + runtime/UI high-risk regression

## Mandatory Scope Checklist (Epic Contract)

The following mandatory endpoints/hooks/components are in scope and covered by at least one matrix row below:

- `/api/auth/login`
- `/api/auth/callback`
- `/api/auth/me`
- `/api/auth/logout`
- `/api/status`
- `/api/service-status`
- `/api/stack-status`
- `hooks/useServerStatus.ts`
- `components/auth/auth-provider.tsx`
- `components/ControlsSection.tsx`

## Coverage Matrix

| Row ID | Target | Scenario | Test layer | Must-have assertions | Execution owner/task seed |
| --- | --- | --- | --- | --- | --- |
| A-LOGIN-01 | `/api/auth/login` | OAuth provider/config missing | Integration (route) | Returns deterministic error/redirect contract; does not set auth state cookies; error surface is explicit and non-200. | TEST-A1 / T-1.1 |
| A-LOGIN-02 | `/api/auth/login` | Standard login redirect (non-popup) | Integration (route) | Redirect URL includes required OAuth params (`state`, `redirect_uri`, scope as configured); CSRF/state cookie is set with secure attributes (`httpOnly`, `sameSite`, `path`, expiry). | TEST-A1 / T-1.1 |
| A-LOGIN-03 | `/api/auth/login` | Popup login mode requested | Integration (route) | Popup intent marker/cookie is set; redirect target remains valid OAuth endpoint; popup and non-popup mode are distinguishable in persisted request state. | TEST-A1 / T-1.1 |
| A-LOGIN-04 | `/api/auth/login` | Rate-limit boundary exceeded | Integration (route) | Returns throttle status/redirect as implemented; `Retry-After` is present and parseable; no new auth session cookie is created on throttled response. | TEST-A1 / T-1.1 |
| A-CALLBACK-01 | `/api/auth/callback` | Missing required callback params (`code` and/or `state`) | Integration (route) | Rejects request deterministically; transient OAuth cookies are cleared; response indicates auth failure contract without creating session. | TEST-A1 / T-1.2 |
| A-CALLBACK-02 | `/api/auth/callback` | State mismatch vs stored CSRF cookie | Integration (route) | Callback is rejected; mismatch does not mint session cookie; state/popup temp cookies are cleared to avoid replay. | TEST-A1 / T-1.2 |
| A-CALLBACK-03 | `/api/auth/callback` | Token exchange failure | Integration (route) | Upstream token failure maps to deterministic error response; session cookie is not set; transient cookies are cleaned up. | TEST-A1 / T-1.2 |
| A-CALLBACK-04 | `/api/auth/callback` | User info/profile fetch failure after token success | Integration (route) | Error path is explicit; no session cookie is created; temp cookies are cleared consistently. | TEST-A1 / T-1.2 |
| A-CALLBACK-05 | `/api/auth/callback` | Successful callback (non-popup) | Integration (route) | Session cookie is set with secure attributes; transient OAuth cookies are cleared; response lands on expected non-popup destination. | TEST-A1 / T-1.2 |
| A-CALLBACK-06 | `/api/auth/callback` | Successful callback (popup) | Integration (route) | Session cookie set + temp cookies cleared; response body/redirect contract signals popup-complete behavior (close/postMessage contract as implemented). | TEST-A1 / T-1.2 |
| A-ME-01 | `/api/auth/me` | Valid session cookie | Integration (route) | Returns authenticated payload (identity + role/claims as applicable); success status and schema are stable; no session mutation side effects. | TEST-A2 / T-2.1 |
| A-ME-02 | `/api/auth/me` | Missing/invalid session cookie | Integration (route) | Returns unauth/guest contract; does not leak stale user data; status code and payload shape are deterministic. | TEST-A2 / T-2.1 |
| A-LOGOUT-01 | `/api/auth/logout` | Logout with active session | Integration (route) | Session cookie is expired/cleared with correct cookie attributes; response confirms logout contract; post-logout `me` resolves unauthenticated. | TEST-A2 / T-2.1 |
| A-INT-01 | Auth lifecycle (`login -> callback -> me`) | Happy-path non-browser lifecycle smoke | Integration (multi-route) | Login seeds state, callback mints session, `me` returns authenticated identity in sequence; cookie handoff between steps is deterministic. | TEST-A2 / T-2.2 |
| R-STATUS-01 | `/api/status` | Cache miss then hit + throttle behavior | Integration (route) | First call reports miss semantics (`X-*-Cache` miss contract), follow-up hit reports cache hit contract, throttle path returns `429` + valid `Retry-After`. | TEST-R1 / T-1.1 |
| R-SERVICE-01 | `/api/service-status` | Cache miss/hit and rate-limit boundary | Integration (route) | Cache headers or equivalent metadata switch miss->hit deterministically; boundary call throttles with `429`; `Retry-After` and body contract are asserted. | TEST-R1 / T-1.1 |
| R-STACK-01 | `/api/stack-status` | Cache miss/hit and rate-limit boundary | Integration (route) | Miss/hit signaling is explicit and deterministic; throttled response includes `429` + `Retry-After`; non-throttled response schema remains stable. | TEST-R1 / T-1.1 |
| R-STATE-01 | Runtime status routes | Durable Objects authoritative counter path | Integration (route + runtime stub) | Counter increments/checks are strongly consistent across sequential requests; assertions fail if stale read is returned on authoritative path. | TEST-R1 / T-1.2 |
| R-STATE-02 | Runtime status routes | KV snapshot staleness-tolerant path | Integration (route + runtime stub) | Bounded staleness is explicitly tolerated (defined window/assertion); stale snapshot does not violate correctness-critical response invariants. | TEST-R1 / T-1.2 |
| H-STATUS-01 | `hooks/useServerStatus.ts` | Pending action timeout transition | Unit (hook + fake timers) | Hook enters pending state on action start; deterministic timeout exits pending state; timeout cleanup prevents leaked timers on unmount. | TEST-R2 / T-2.1 |
| H-STATUS-02 | `hooks/useServerStatus.ts` | Focus-triggered refetch | Unit (hook + browser event mock) | Window focus event triggers exactly one refetch per focus cycle under guard rules; no duplicate refetch loop. | TEST-R2 / T-2.1 |
| H-STATUS-03 | `hooks/useServerStatus.ts` | Player refresh transition logic | Unit (hook) | Player list/count refresh updates derived state consistently; loading/error flags transition correctly across refresh outcomes. | TEST-R2 / T-2.1 |
| C-AUTH-01 | `components/auth/auth-provider.tsx` | Unauthenticated bootstrap and session resolve | Integration (component/provider) | Initial unauth/loading states are emitted in expected order; successful session resolution updates context once with stable shape; error path does not present authenticated state. | TEST-R2 / T-2.2 |
| C-CONTROLS-01 | `components/ControlsSection.tsx` | Role-gated control visibility/enabledness | Integration (component) | Restricted actions are hidden/disabled for insufficient role; authorized role can access controls; gating is not bypassed by transient loading state. | TEST-R2 / T-2.2 |
| C-CONTROLS-02 | `components/ControlsSection.tsx` | Unauthenticated primary start flow | Integration (component) | Primary server action prompts sign-in/login flow when unauthenticated; action side effect is not executed prior to auth completion. | TEST-R2 / T-2.2 |
| E2E-CONTROLS-01 | Critical control flow journey | Targeted high-value UI action integrity path | E2E (selective) | User-visible path validates auth gate -> allowed action -> expected status feedback; verifies no silent failure between control click and surfaced result. | TEST-R2 / T-2.2 |

## Notes for Execution Tasks

- Keep deterministic harness rules strict: fixed clock, explicit cookie jar handling, runtime-state stubs with stable seeds.
- Each test suite implementing these rows should reference its `Row ID` in the describe/title so CI failures map back to this matrix.
- If implementation discovers an untestable assertion, update this matrix in the same PR with rationale (do not silently drop coverage intent).
