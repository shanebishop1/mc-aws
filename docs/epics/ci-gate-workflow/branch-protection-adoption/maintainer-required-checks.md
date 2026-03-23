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

- `Mock integration lane (pnpm test:mock)`
- `Mock E2E lane (pnpm test:e2e:mock)`

## Runbook: Apply Required Check Policy

### Option A — GitHub UI

1. Open: **GitHub repo → Settings → Branches → Branch protection rules**.
2. Edit (or create) the rule for the default branch.
3. Enable **Require status checks to pass before merging**.
4. In required checks, add exactly:
   - `Baseline PR Validation`
5. Ensure these are **not** selected as required:
   - `Mock integration lane (pnpm test:mock)`
   - `Mock E2E lane (pnpm test:e2e:mock)`
6. Save changes.

### Option B — `gh` CLI

```bash
# 1) Resolve repo + default branch
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
DEFAULT_BRANCH="$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)"

# 2) Set required status-check contexts on existing branch protection
gh api \
  --method PATCH \
  -H "Accept: application/vnd.github+json" \
  "/repos/${REPO}/branches/${DEFAULT_BRANCH}/protection/required_status_checks" \
  --input - <<'JSON'
{
  "strict": true,
  "contexts": [
    "Baseline PR Validation"
  ]
}
JSON
```

> If the PATCH call returns `404 Branch not protected`, create/edit the branch protection rule once in the UI, then rerun the CLI command.

## Verification (Enforcement Active)

Run:

```bash
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
DEFAULT_BRANCH="$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)"

gh api \
  -H "Accept: application/vnd.github+json" \
  "/repos/${REPO}/branches/${DEFAULT_BRANCH}/protection" \
  --jq '{strict: .required_status_checks.strict, contexts: .required_status_checks.contexts}'
```

Expected result:

- `strict: true`
- `contexts` contains only `Baseline PR Validation`

Practical proof: open a PR to the default branch with a failing `Baseline PR Validation` run and confirm **Merge** is blocked.

Source of truth: `.github/workflows/baseline-pr-validation.yml` (`jobs.*.name`).
