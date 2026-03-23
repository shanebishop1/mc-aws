# Verification Record — mc-aws-3jf.1.1.3

- Timestamp (UTC): 2026-03-23T06:07:05Z
- Operator: `gh` CLI (`shanebishop1`)
- Repository: `shanebishop1/mc-aws`
- Default branch: `main`

## Objective

Apply branch protection required status checks per runbook and verify merge blocking behavior.

## Runbook Reference

- `docs/epics/ci-gate-workflow/branch-protection-adoption/maintainer-required-checks.md`

## Command Evidence Summary

### 1) Detect repo + default branch

- Command: `gh repo view --json nameWithOwner,defaultBranchRef`
- Result: `{ "nameWithOwner": "shanebishop1/mc-aws", "defaultBranchRef": { "name": "main" } }`

### 2) Apply required checks policy

Runbook PATCH attempt on existing status-check protection returned expected precondition blocker:

- Command: `gh api --method PATCH /repos/${REPO}/branches/${DEFAULT_BRANCH}/protection/required_status_checks ...`
- Result: `404 Branch not protected`

Applied protection using full protection endpoint, with required status check context set to only `Baseline PR Validation`:

- Command: `gh api --method PUT /repos/${REPO}/branches/${DEFAULT_BRANCH}/protection ...`
- Result: success; payload confirms:
  - `required_status_checks.strict: true`
  - `required_status_checks.contexts: ["Baseline PR Validation"]`

### 3) Verify protection settings active

- Command: `gh api /repos/${REPO}/branches/${DEFAULT_BRANCH}/protection --jq '{strict: .required_status_checks.strict, contexts: .required_status_checks.contexts}'`
- Result: `{ "strict": true, "contexts": ["Baseline PR Validation"] }`

## Merge Blocking Verification

Verification PR created:

- URL: `https://github.com/shanebishop1/mc-aws/pull/1`
- Head SHA: `ba7aa10fe0779b0a830e5dcfef17124c1c0a4ba7`

Injected a failing status for the required context on the PR head commit:

- Command: `gh api --method POST /repos/${REPO}/statuses/${SHA} -f state=failure -f context="Baseline PR Validation" ...`
- Result: status created with `state: failure`, `context: "Baseline PR Validation"`

Confirmed PR merge is blocked with failing required check:

- Command: `gh pr view 1 --json mergeStateStatus,statusCheckRollup`
- Result:
  - `mergeStateStatus: "BLOCKED"`
  - `statusCheckRollup` contains `StatusContext` with:
    - `context: "Baseline PR Validation"`
    - `state: "FAILURE"`

Direct merge attempt (non-admin) confirms policy enforcement:

- Command: `gh pr merge 1 --merge`
- Result: `Pull request ... is not mergeable: the base branch policy prohibits the merge.`

Cleanup:

- Command: `gh pr close 1 --comment "Closing verification-only PR used for branch protection gate validation (mc-aws-3jf.1.1.3)."`
- Result: PR closed after evidence capture.

## Blocker Status

- Branch protection configuration blocker: **None** (resolved by creating branch protection rule via API after expected 404 precondition).
- Merge-blocking validation blocker: **None**.
