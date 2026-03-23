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

### CI lane reference (current workflow check names)

- `Baseline PR Validation` (`pnpm test`) — required merge gate.
- `Mock integration lane (pnpm test:mock)` — extended integration lane (path-conditional + scheduled/manual).
- `Mock E2E lane (pnpm test:e2e:mock)` — extended high-cost E2E lane (path-conditional + scheduled/manual).

| Row ID | Target | Scenario | Test layer | Must-have assertions | Execution owner/task seed | CI lane (status check) | Lane rationale |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A-LOGIN-01 | `/api/auth/login` | OAuth provider/config missing | Integration (route) | Returns deterministic error/redirect contract; does not set auth state cookies; error surface is explicit and non-200. | TEST-A1 / T-1.1 | `Mock integration lane (pnpm test:mock)` | Route-level OAuth failure coverage depends on mock-backed integration fixtures and is better suited to the extended integration lane than the required fast gate. |
| A-LOGIN-02 | `/api/auth/login` | Standard login redirect (non-popup) | Integration (route) | Redirect URL includes required OAuth params (`state`, `redirect_uri`, scope as configured); CSRF/state cookie is set with secure attributes (`httpOnly`, `sameSite`, `path`, expiry). | TEST-A1 / T-1.1 | `Mock integration lane (pnpm test:mock)` | Cookie + redirect contract validation is auth integration behavior that belongs with other mock-backed route checks. |
| A-LOGIN-03 | `/api/auth/login` | Popup login mode requested | Integration (route) | Popup intent marker/cookie is set; redirect target remains valid OAuth endpoint; popup and non-popup mode are distinguishable in persisted request state. | TEST-A1 / T-1.1 | `Mock integration lane (pnpm test:mock)` | Popup state persistence requires auth route integration context and shared cookie harnessing used in the extended integration lane. |
| A-LOGIN-04 | `/api/auth/login` | Rate-limit boundary exceeded | Integration (route) | Returns throttle status/redirect as implemented; `Retry-After` is present and parseable; no new auth session cookie is created on throttled response. | TEST-A1 / T-1.1 | `Mock integration lane (pnpm test:mock)` | Rate-limit boundary assertions require deterministic window fixtures already planned for integration lane ownership. |
| A-CALLBACK-01 | `/api/auth/callback` | Missing required callback params (`code` and/or `state`) | Integration (route) | Rejects request deterministically; transient OAuth cookies are cleared; response indicates auth failure contract without creating session. | TEST-A1 / T-1.2 | `Mock integration lane (pnpm test:mock)` | Callback rejection/cleanup behavior is multi-cookie route integration logic handled in the extended mock integration lane. |
| A-CALLBACK-02 | `/api/auth/callback` | State mismatch vs stored CSRF cookie | Integration (route) | Callback is rejected; mismatch does not mint session cookie; state/popup temp cookies are cleared to avoid replay. | TEST-A1 / T-1.2 | `Mock integration lane (pnpm test:mock)` | CSRF mismatch validation depends on deterministic cookie-jar fixtures and belongs in the auth integration lane. |
| A-CALLBACK-03 | `/api/auth/callback` | Token exchange failure | Integration (route) | Upstream token failure maps to deterministic error response; session cookie is not set; transient cookies are cleaned up. | TEST-A1 / T-1.2 | `Mock integration lane (pnpm test:mock)` | Upstream OAuth failure simulation is mock-provider integration behavior, not baseline unit-gate behavior. |
| A-CALLBACK-04 | `/api/auth/callback` | User info/profile fetch failure after token success | Integration (route) | Error path is explicit; no session cookie is created; temp cookies are cleared consistently. | TEST-A1 / T-1.2 | `Mock integration lane (pnpm test:mock)` | Post-token profile failure requires staged integration mocks across callback steps, matching extended lane purpose. |
| A-CALLBACK-05 | `/api/auth/callback` | Successful callback (non-popup) | Integration (route) | Session cookie is set with secure attributes; transient OAuth cookies are cleared; response lands on expected non-popup destination. | TEST-A1 / T-1.2 | `Mock integration lane (pnpm test:mock)` | End-to-end callback success contract is auth route integration coverage grouped with other mock-backed callback flows. |
| A-CALLBACK-06 | `/api/auth/callback` | Successful callback (popup) | Integration (route) | Session cookie set + temp cookies cleared; response body/redirect contract signals popup-complete behavior (close/postMessage contract as implemented). | TEST-A1 / T-1.2 | `Mock integration lane (pnpm test:mock)` | Popup callback completion semantics require integration-level contract verification beyond baseline unit scope. |
| A-ME-01 | `/api/auth/me` | Valid session cookie | Integration (route) | Returns authenticated payload (identity + role/claims as applicable); success status and schema are stable; no session mutation side effects. | TEST-A2 / T-2.1 | `Mock integration lane (pnpm test:mock)` | Session-backed identity checks are route integration scenarios that align with the mock integration lane’s contract focus. |
| A-ME-02 | `/api/auth/me` | Missing/invalid session cookie | Integration (route) | Returns unauth/guest contract; does not leak stale user data; status code and payload shape are deterministic. | TEST-A2 / T-2.1 | `Mock integration lane (pnpm test:mock)` | Negative auth session contract checks rely on integration cookie handling in the extended lane. |
| A-LOGOUT-01 | `/api/auth/logout` | Logout with active session | Integration (route) | Session cookie is expired/cleared with correct cookie attributes; response confirms logout contract; post-logout `me` resolves unauthenticated. | TEST-A2 / T-2.1 | `Mock integration lane (pnpm test:mock)` | Logout + follow-up `me` verification is a multi-route auth integration sequence that fits the extended integration lane. |
| A-INT-01 | Auth lifecycle (`login -> callback -> me`) | Happy-path non-browser lifecycle smoke | Integration (multi-route) | Login seeds state, callback mints session, `me` returns authenticated identity in sequence; cookie handoff between steps is deterministic. | TEST-A2 / T-2.2 | `Mock integration lane (pnpm test:mock)` | Explicit multi-route lifecycle smoke is the canonical extended integration-lane workload. |
| R-STATUS-01 | `/api/status` | Cache miss then hit + throttle behavior | Integration (route) | First call reports miss semantics (`X-*-Cache` miss contract), follow-up hit reports cache hit contract, throttle path returns `429` + valid `Retry-After`. | TEST-R1 / T-1.1 | `Mock integration lane (pnpm test:mock)` | Runtime/cache + throttle route behavior depends on deterministic integration fixtures and belongs to extended integration checks. |
| R-SERVICE-01 | `/api/service-status` | Cache miss/hit and rate-limit boundary | Integration (route) | Cache headers or equivalent metadata switch miss->hit deterministically; boundary call throttles with `429`; `Retry-After` and body contract are asserted. | TEST-R1 / T-1.1 | `Mock integration lane (pnpm test:mock)` | Service-status cache and throttling validation needs runtime-aware integration stubs beyond baseline quick checks. |
| R-STACK-01 | `/api/stack-status` | Cache miss/hit and rate-limit boundary | Integration (route) | Miss/hit signaling is explicit and deterministic; throttled response includes `429` + `Retry-After`; non-throttled response schema remains stable. | TEST-R1 / T-1.1 | `Mock integration lane (pnpm test:mock)` | Stack-status high-risk throttling/caching behavior aligns with mock integration lane runtime contract testing. |
| R-STATE-01 | Runtime status routes | Durable Objects authoritative counter path | Integration (route + runtime stub) | Counter increments/checks are strongly consistent across sequential requests; assertions fail if stale read is returned on authoritative path. | TEST-R1 / T-1.2 | `Mock integration lane (pnpm test:mock)` | Authoritative Durable Objects counter assertions require runtime stubs and deterministic sequencing handled in extended integration runs. |
| R-STATE-02 | Runtime status routes | KV snapshot staleness-tolerant path | Integration (route + runtime stub) | Bounded staleness is explicitly tolerated (defined window/assertion); stale snapshot does not violate correctness-critical response invariants. | TEST-R1 / T-1.2 | `Mock integration lane (pnpm test:mock)` | KV staleness-window assertions are runtime integration scenarios tied to mock-backed state fixtures. |
| H-STATUS-01 | `hooks/useServerStatus.ts` | Pending action timeout transition | Unit (hook + fake timers) | Hook enters pending state on action start; deterministic timeout exits pending state; timeout cleanup prevents leaked timers on unmount. | TEST-R2 / T-2.1 | `Baseline PR Validation` | Deterministic hook unit behavior is fast and should fail the required `pnpm test` merge gate immediately. |
| H-STATUS-02 | `hooks/useServerStatus.ts` | Focus-triggered refetch | Unit (hook + browser event mock) | Window focus event triggers exactly one refetch per focus cycle under guard rules; no duplicate refetch loop. | TEST-R2 / T-2.1 | `Baseline PR Validation` | Fast hook event/refetch guard checks are core regression signals appropriate for baseline required coverage. |
| H-STATUS-03 | `hooks/useServerStatus.ts` | Player refresh transition logic | Unit (hook) | Player list/count refresh updates derived state consistently; loading/error flags transition correctly across refresh outcomes. | TEST-R2 / T-2.1 | `Baseline PR Validation` | State transition logic is a stable unit-level contract that belongs in the always-on baseline lane. |
| C-AUTH-01 | `components/auth/auth-provider.tsx` | Unauthenticated bootstrap and session resolve | Integration (component/provider) | Initial unauth/loading states are emitted in expected order; successful session resolution updates context once with stable shape; error path does not present authenticated state. | TEST-R2 / T-2.2 | `Baseline PR Validation` | Provider bootstrap/session state sequencing is component-level integration that remains fast enough for required baseline gating. |
| C-CONTROLS-01 | `components/ControlsSection.tsx` | Role-gated control visibility/enabledness | Integration (component) | Restricted actions are hidden/disabled for insufficient role; authorized role can access controls; gating is not bypassed by transient loading state. | TEST-R2 / T-2.2 | `Baseline PR Validation` | Role-gating regressions are high-impact UI logic and should block merge via the required baseline lane. |
| C-CONTROLS-02 | `components/ControlsSection.tsx` | Unauthenticated primary start flow | Integration (component) | Primary server action prompts sign-in/login flow when unauthenticated; action side effect is not executed prior to auth completion. | TEST-R2 / T-2.2 | `Baseline PR Validation` | Unauthenticated action-gate behavior is critical UI contract coverage that should run on every PR in baseline. |
| E2E-CONTROLS-01 | Critical control flow journey | Targeted high-value UI action integrity path | E2E (selective) | User-visible path validates auth gate -> allowed action -> expected status feedback; verifies no silent failure between control click and surfaced result. | TEST-R2 / T-2.2 | `Mock E2E lane (pnpm test:e2e:mock)` | Browser journey validation is intentionally high-cost and mapped to the dedicated extended E2E lane. |

## Notes for Execution Tasks

- Keep deterministic harness rules strict: fixed clock, explicit cookie jar handling, runtime-state stubs with stable seeds.
- Each test suite implementing these rows should reference its `Row ID` in the describe/title so CI failures map back to this matrix.
- If implementation discovers an untestable assertion, update this matrix in the same PR with rationale (do not silently drop coverage intent).
