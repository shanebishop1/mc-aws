# Configuration and Docs Drift Verification Runbook

This runbook provides manual verification steps for story `mc-aws-3rj.3` when CI automation is unavailable.

## Scope

- Canonical localhost default is `http://localhost:3000`.
- API docs and runtime behavior stay aligned.
- Legacy `bd` commands are not used in checked docs/config references.

## Prerequisites

1. Install dependencies:

```bash
pnpm install
```

2. Ensure your shell is at repository root (`mc-aws`).

## Step 1: Run docs consistency gate

```bash
pnpm docs:check
```

Expected output:

- Includes: `[DOCS-CHECK] All docs consistency checks passed.`
- Exit code: `0`

If it fails, common causes:

- One of the tracked docs contains `localhost:3001`.
- One of the tracked docs/config files contains a `bd <command>` reference.

## Step 2: Verify TypeScript integrity

```bash
pnpm typecheck
```

Expected output:

- No TypeScript errors.
- Exit code: `0`

If it fails:

- Fix reported type errors before continuing.
- Re-run until clean.

## Step 3: Verify local app defaults on port 3000

Run dev server in mock mode:

```bash
pnpm dev:mock
```

Expected output:

- Next.js startup log indicates local URL `http://localhost:3000`.

If startup fails:

- Ensure port 3000 is free.
- Stop any existing dev server process and retry.

## Step 4: Verify public status route cache contract

In a second shell, call twice:

```bash
curl -i "http://localhost:3000/api/status"
curl -i "http://localhost:3000/api/status"
```

Expected output:

- HTTP `200` responses.
- Header `X-Status-Cache` appears (`MISS` first, then often `HIT` on repeat).
- Header `Vary: Cookie` appears.

If behavior differs:

- Confirm server is running in mock mode.
- Retry after a few seconds (cache TTL/refresh timing can affect sequence).

## Step 5: Verify stack status route cache contract

```bash
curl -i "http://localhost:3000/api/stack-status"
curl -i "http://localhost:3000/api/stack-status"
```

Expected output:

- HTTP `200` responses.
- Header `X-Stack-Status-Cache` appears (`MISS` then often `HIT`).
- Header `Vary: Cookie` appears.

## Step 6: Verify API docs reflect current defaults

Confirm `docs/docs/API.md` includes:

- Base URL local default `http://localhost:3000`
- Auth model terms: `public`, `allowed`, `admin`
- Cache header guidance for status and stack-status endpoints

Quick check command:

```bash
pnpm docs:check && pnpm typecheck
```

Expected output:

- Both commands succeed with exit code `0`.

## Troubleshooting Quick Reference

- `docs:check` fails with legacy port:
  - Replace `localhost:3001` with `localhost:3000` in the file listed by the command.
- `docs:check` fails with legacy beads command:
  - Replace `bd ...` with the equivalent `br ...` command.
- `curl` gets `404`:
  - Confirm server is running and URL is exactly `http://localhost:3000`.
- `curl` gets `429`:
  - Wait for rate-limit window to reset, then retry.

## Evidence Capture (recommended)

When running this manually for release verification, save:

1. Terminal output for `pnpm docs:check`
2. Terminal output for `pnpm typecheck`
3. `curl -i` output for `/api/status` and `/api/stack-status` (two calls each)

Store evidence in a dated verification note under `docs/epics/`.
