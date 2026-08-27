# AWS Provider Extension Contract

The provider boundary lets application routes use either AWS or deterministic local state without changing their imports. This is a current extension contract, not implementation history.

## Authoritative contract

`lib/aws/types.ts` defines the authoritative `AwsProvider` interface and its shared data types. Every backend operation used through the abstraction must appear there with one mode-independent signature and return contract.

Implementations are:

- `lib/aws/aws-provider.ts`: delegates to real AWS client modules.
- `lib/aws/mock-provider.ts`: implements equivalent observable behavior against `lib/aws/mock-state-store.ts`.
- `lib/aws/index.ts`: exposes application-facing wrappers that call `getProvider()`.

Routes and shared application code should import operations from `@/lib/aws`, not select a provider themselves.

## Selection and safety

`lib/aws/provider-selector.ts` chooses from `MC_BACKEND_MODE` on the first `getProvider()` call and caches that provider for the process. `resetProvider()` exists for tests; changing an environment variable after selection does not switch a running application.

Both providers are statically imported by the selector. Selection is lazy and cached, but module imports are not dynamically loaded. AWS clients use their own deferred/proxy behavior; do not claim the AWS provider module is absent in mock mode.

Backend mode rules:

- Unset or `aws`: use AWS (the default).
- `mock`: use local state only in non-production environments.
- `mock` with `NODE_ENV=production`: provider selection throws an error. Mock mode must never be enabled in production.

The `@/lib/aws` entry module still exports raw `ec2`, `ssm`, and `cloudformation` SDK clients for compatibility. Calls through those objects bypass `AwsProvider` and mock behavior. Do not use them for new provider-backed application operations.

## Adding or changing an operation

1. Define the signature and any shared type in `lib/aws/types.ts`.
2. Implement the AWS behavior in its focused client module and delegate from `aws-provider.ts`.
3. Implement behaviorally useful mock semantics in `mock-provider.ts`; update mock state/scenarios only when the operation needs observable state.
4. Add a delegating export to `lib/aws/index.ts` for route/application use.
5. Update callers to import from `@/lib/aws`.
6. Preserve errors, optional-argument behavior, and return shapes across modes.

Do not add an operation merely to expose a complete AWS service. The interface contains only application capabilities. Keep service-specific SDK types from leaking into callers where a small shared type provides a stable contract.

## Mock implementation rules

- Do not contact AWS or require AWS credentials.
- Model state transitions that callers observe; avoid no-op success when it hides broken workflows.
- Use the state store APIs so locking, cloning, persistence, and timer cleanup remain consistent.
- Use fault injection at the provider operation boundary.
- Route-backed backup, restore, hibernate, and resume simulate operation acceptance and completion only, not server data, archives, or volume effects.
- Keep scenario discovery dynamic through `getAvailableScenarios()` rather than duplicating names.

## Extension and test checklist

- [ ] `AwsProvider`, the AWS implementation, the mock implementation, and the application-facing wrapper agree.
- [ ] No new caller imports a focused AWS client or raw SDK export to bypass selection.
- [ ] AWS remains the default and production still rejects mock mode.
- [ ] Selector tests reset the cached provider between mode cases.
- [ ] Provider tests cover success, relevant errors/faults, and state transitions in both contracts.
- [ ] Route parity tests cover user-visible response/status differences where applicable.
- [ ] Mock state reset removes operation state, faults, and registered timers.
- [ ] `pnpm check`, `pnpm typecheck`, and `pnpm test` pass; run `pnpm test:e2e:mock` for browser-visible changes.

See the [Mock Mode Developer Guide](MOCK_MODE_DEVELOPER_GUIDE.md) for local controls, persistence, and scenario workflow.
