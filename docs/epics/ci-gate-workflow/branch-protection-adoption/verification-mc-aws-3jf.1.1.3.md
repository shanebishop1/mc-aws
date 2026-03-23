# Verification Record — mc-aws-3jf.1.1.3

- Timestamp (UTC): 2026-03-23T06:05:41Z
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

Pending completion in this same record: create verification PR, force failing required check context, and confirm merge is blocked.

## Blocker Status

- Branch protection configuration blocker: **None** (resolved by creating branch protection rule via API after expected 404 precondition).
- Merge-blocking validation blocker: **Pending verification steps**.
