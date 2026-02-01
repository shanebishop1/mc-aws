# Async Start Refactor & Mock Mode Review

## Goal Description

Refactor the `POST /api/start` endpoint to be asynchronous ("Fire and Forget") to prevent HTTP timeouts. Instead of the Next.js API route waiting for the full server startup (EC2 boot + DNS propagation), it will trigger the existing `StartMinecraftServer` Lambda function and return immediately. The Frontend will rely on the `server-action` SSM lock and polling to track progress.

Also, verify that the "Mock Mode" implementation is clean and secure.

## User Review Required

> [!IMPORTANT]
> **Architecture Change**: The `POST /api/start` route will no longer execute logic directly. It will become a trigger for the `StartMinecraftServer` Lambda.
> **Locking Mechanism**: The API will _set_ the lock (`/minecraft/server-action`), and the Lambda must be responsible for _releasing_ it upon completion (or failure). This requires updating the Lambda to handle lock release.

## Proposed Changes

### Mock Mode Security

- **Findings**: The [lib/aws/provider-selector.ts](file:///Users/shane/projects/mc-aws/lib/aws/provider-selector.ts) relies on `MC_BACKEND_MODE="mock"`. This is secure as long as this environment variable is not set in production.
- **Action**: No code changes needed, just verification.

### Web App (`app/api` & `lib`)

#### [MODIFY] [lib/aws/index.ts](file:///Users/shane/projects/mc-aws/lib/aws/index.ts)

- Add `invokeLambda` utility or access to `LambdaClient`.
- Actually, we'll keep `lib/aws/index.ts` focused on Shared Logic. We might adding `invokeStartLambda` to a new or existing file.

#### [MODIFY] [app/api/start/route.ts](file:///Users/shane/projects/mc-aws/app/api/start/route.ts)

- Remove `startInstance`, `waitForInstanceRunning`, `updateCloudflareDns` calls.
- Add `InvokeCommand` to trigger `StartMinecraftServer` Lambda.
- Payload: `{ "invocationType": "api", "command": "start", "userEmail": user.email, "instanceId": resolvedId }`.
- **Locking**: Set the `server-action` lock _before_ invoking. Do _not_ release it in `finally`.

### Infrastructure (`infra/src/lambda`)

#### [MODIFY] [infra/src/lambda/StartMinecraftServer/index.js](file:///Users/shane/projects/mc-aws/infra/src/lambda/StartMinecraftServer/index.js)

- Update handler to accept `event.invocationType === 'api'`.
- Bypass email verification for API events.
- Add try/finally block to **Clear the Server Action Lock** at the end of execution.

#### [MODIFY] [infra/src/lambda/StartMinecraftServer/ssm.js](file:///Users/shane/projects/mc-aws/infra/src/lambda/StartMinecraftServer/ssm.js)

- Add `deleteParameter` function (if missing) to allow clearing the lock.

## Verification Plan

### Automated Tests

- Run `pnpm test` to ensure existing tests pass.
- Update `app/api/start/route.test.ts` to mock the Lambda invocation instead of EC2 calls.
- Run `pnpm test app/api/start/route.test.ts`.

### Manual Verification

1.  **Mock Mode Check**: Run `pnpm dev:mock` and verify `POST /api/start` still works (it uses the Mock Provider, which mocks the 'logical' start, so we might need to adjust the Mock Provider to simulate the behavior if we are swapping the implementation? Wait, Mock Provider mocks the `lib/aws` calls. If we change `route.ts` to call Lambda, Mock Provider might be bypassed?
    - _Correction_: If `route.ts` calls `lambda.send(InvokeCommand)`, this is an AWS SDK call.
    - We need to make sure `route.ts` usage of `lambda` is also mocked or handled.
    - **Refinement**: We should abstract the "Starter" logic.
    - If `MC_BACKEND_MODE=mock`, `route.ts` should probably call the Mock Provider's start method directly (synchronously is fine for mock).
    - If `MC_BACKEND_MODE=aws`, `route.ts` should call the Lambda.
2.  **Live Deploy Test**:
    - Deploy changes.
    - Click "Start Server".
    - Verify UI shows "Starting..." immediately (due to Lock).
    - Verify Server actually starts (check EC2 console).
    - Verify Lock is cleared after ~2 minutes (when DNS is done).
