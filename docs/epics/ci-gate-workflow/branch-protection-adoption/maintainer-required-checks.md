# Branch Protection: CI Gate Status Check Policy

Use this matrix when configuring branch protection required checks for the default branch.

## Approved CI Gate Matrix

| Status check name (exact) | Source lane name | Trigger mode | Required for branch protection | Rationale |
| --- | --- | --- | --- | --- |
| `Baseline PR Validation` | `jobs.baseline-pr-validation.name` | PR to default branch, manual, scheduled | **Yes** | Primary merge gate that enforces `pnpm check`, `pnpm typecheck`, and `pnpm test` in a single required signal. |
| `Mock integration lane (pnpm test:mock)` | `jobs.mock-integration-lane.name` | PR to default branch when high-risk paths change, manual opt-in, scheduled | **No** | Extended confidence lane; path-conditional and periodic coverage make it unsuitable as a universal merge blocker. |
| `Mock E2E lane (pnpm test:e2e:mock)` | `jobs.mock-e2e-lane.name` | PR to default branch when high-risk paths change, manual opt-in, scheduled | **No** | High-cost regression lane intended for targeted and scheduled validation rather than every PR merge decision. |

## Branch Protection Setup (Actionable)

Configure **only** this required status check in GitHub branch protection:

- `Baseline PR Validation`

Do **not** mark the two extended lanes as required checks.

Source of truth: `.github/workflows/baseline-pr-validation.yml` (`jobs.*.name`).
