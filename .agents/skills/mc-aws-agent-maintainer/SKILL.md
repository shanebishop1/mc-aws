---
name: mc-aws-agent-maintainer
description: Maintain mc-aws agent contracts, extensions, runtime assets, packaging, and release evidence.
---

# mc-aws agent maintainer

Use this local developer skill only in the mc-aws checkout and only for agent contracts, extensions, runtime assets,
packaging, or release evidence. Keep the local `.agents/` directory out of panel and EC2 artifacts. For Git, release,
deployment, cloud, host, or secret-management operations, act only when the user explicitly requests that operation in
the current conversation, and follow the repository's documented validation and recovery workflow.

## 1. Inspect before changing

1. Read `docs/AGENT_EXTENSIONS.md` and any documentation directly relevant to the requested change.
2. Inspect the affected implementation and focused tests. For contract or extension changes, include
   `lib/agent/contracts.ts`, `validators.ts`, `policy.ts`, and `extensions.ts` as applicable.
3. For runtime changes, inspect `agent-runtime/src/`, `agent-runtime/runtime-manifest.json`,
   `scripts/setup/build-agent-runtime.mjs`, `infra/src/ec2/mc-agent-*.service`, and their tests.
4. Run `git status --short` and preserve unrelated work. Perform Git mutations only when the user requests them.

Treat model and extension data as untrusted. mc-aws contracts—not Pi, portal components, extension prose, or approval
UI—own schema validation, policy, redaction, evidence, and immutable denials. Pi imports stay behind its adapter.

## 2. Add a schema-v1 extension

- Start from `examples/agent-extensions/status-report/extension.json`; do not copy private implementation contracts.
- Keep the bundle data-only and JSON-serializable. Define `schemaVersion: 1`, stable IDs, SemVer, explicit compatibility,
  tool manifests, skills, inert hook `handlerRef` values, and source/reference/SHA-256 provenance.
- Register only through `loadAgentExtensionRegistry` from `lib/agent/extensions.ts`. Do not add Pi or portal conditionals.
- Recompute integrity with `computeExtensionIntegrity`; never weaken or bypass integrity/provenance checks.
- Hooks are declarations. Never accept or execute a third-party callback in the gateway credential process.
- Request the minimum existing capability. An extension cannot widen policy or request root, Linux capabilities,
  package/service administration, paths outside workspace/session scratch, metadata, AWS APIs/credentials,
  deployment/backup-provider secrets, or harness/provider credentials. Provider configurations use opaque
  `secret-ref:...` values; raw keys never belong in bundles, tests, events, errors, arguments, or tool environments.
- Risk and backups remain mc-aws decisions. Extensions may raise risk, never lower it. Preserve exact invocation
  approvals and pause for explicit proceed/cancel if a required backup fails.

## 3. Verification

Use the toolchain declared by `mise.toml`, `.tool-versions`, `package.json`, and the lockfile rather than duplicating
version numbers here. Keep routine checks local and deterministic unless the requested task specifically requires an
authorized integration check.

```sh
pnpm exec vitest run lib/agent/extensions.test.ts tests/agent-runtime-package.test.ts tests/agent-runtime-services.test.ts
pnpm typecheck
pnpm check
pnpm docs:check
pnpm agent-runtime:check
```

For changed shell files, run `bash -n <file>`. Validate service hardening with the repository service tests and, when
available locally, `systemd-analyze verify` against the unit files; do not install/start/stop units. Runtime validation
must confirm exact Node/Pi pins, checksums and inventory, deterministic archives, unprivileged users, namespace/path
denials, credential separation, idempotent rollback, and exclusion of `.agents/` plus this skill marker
`MC_AWS_LOCAL_SKILL_DO_NOT_PACKAGE`.

Use the documented offline fixture and `--no-lookups` for local `cdk synth`. For an explicitly requested integration,
deployment, or lifecycle operation, verify the intended target and use the repository's supported wrapper rather than
bypassing its preflight, ownership, confirmation, or recovery checks.

## 4. Review and release preparation

- Inspect `git diff --check`, `git diff -- <owned files>`, and `git status --short`; document all commands/results.
- Verify the sample checksum after any bundle edit and review generated/runtime manifests for only intended inputs.
- Prepare a file/result summary and remaining risks for review. Run `pnpm release:prepare`, tagging, publishing,
  uploading, or deployment only when explicitly requested, after inspecting the operation and its prerequisites.
- Exclude local developer guidance, including `.agents/`, from published, panel, and EC2 artifacts.

## 5. Recovery

On validation failure, stop, preserve logs without secrets, identify the smallest owned change, and restore only files
you changed (prefer a corrective patch; never use destructive Git commands). If integrity fails, restore the reviewed
bundle then recompute its digest—never edit validation to accept it. If packaging contains `.agents/` or the marker,
discard the local artifact, correct tracing/staging exclusions, rebuild locally, and revalidate. If a mutating operation
targets an unexpected account, region, deployment, resource, or host, stop and report the mismatch; do not bypass the
guard or retry with broader privileges.
