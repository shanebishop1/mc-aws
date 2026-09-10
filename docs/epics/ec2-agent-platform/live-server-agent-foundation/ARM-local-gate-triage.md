# ARM local gate triage appendix

This appendix records the bounded follow-up to the historical serial test gate. It is separate from the shared G0
runner-preparation evidence.

## Source and evidence identity

- Repository: `mc-aws`
- Source `HEAD`: `654905906f3d134cc91055a4b6eafa08a00ce750`
- Source tree: `c814d052bcf853cf5e2de24ad856408242e443ec`
- Historical serial log: `.local-artifacts/current-gate-6549059/06-pnpm-test-serial.log`
- Related historical logs: `.local-artifacts/current-gate-6549059/04-pnpm-test.log` and
  `.local-artifacts/current-gate-6549059/05-pnpm-test-node-env-test.log`

The historical command was `NODE_ENV=test pnpm test -- --no-file-parallelism --maxWorkers=1`. It failed 46 of 2,547
tests across seven files, with 2,501 passing. That historical full-suite failure remains the gate result; these focused
runs do not replace or clear it. The full suite was not rerun for this appendix.

## Exact focused environment

Each file was run as a separate process, in the listed order, with no file selection beyond the file path and no test
timeout override:

```text
NODE_ENV=test
TMPDIR=/projects/shane/mc-aws/.local-artifacts/test-tmp
PATH=/projects/shane/mc-aws/node_modules/.bin:/home/shane/.local/share/mise/installs/node/22.19.0/bin:/home/shane/.local/share/mise/installs/pnpm/10.30.3:/usr/local/bin:/usr/bin:/bin
node=/home/shane/.local/share/mise/installs/node/22.19.0/bin/node
vitest=/projects/shane/mc-aws/node_modules/vitest/vitest.mjs
```

Command template:

```sh
PATH="/projects/shane/mc-aws/node_modules/.bin:/home/shane/.local/share/mise/installs/node/22.19.0/bin:/home/shane/.local/share/mise/installs/pnpm/10.30.3:/usr/local/bin:/usr/bin:/bin" \
NODE_ENV=test TMPDIR="$PWD/.local-artifacts/test-tmp" \
/usr/bin/time -p /home/shane/.local/share/mise/installs/node/22.19.0/bin/node \
/projects/shane/mc-aws/node_modules/vitest/vitest.mjs run <file> \
--no-file-parallelism --maxWorkers=1
```

The PATH contains no mise shims. Node, Vitest, Python, and shell tools resolve from the explicit installed/system paths;
no acquisition, AWS, service, namespace, or host operation was performed.

## Complete prior-failure-file runs

Timings are `/usr/bin/time -p` real time; Vitest's internal duration is included for comparison.

| File | Result | Vitest duration | Real time |
| --- | ---: | ---: | ---: |
| `tests/agent-offline-provider-composition.test.ts` | 1 passed | 3.20 s | 3.60 s |
| `tests/mc-backup-auth.test.ts` | 19 passed | 5.32 s | 5.77 s |
| `tests/release-journal.test.ts` | 20 passed | 8.60 s | 8.95 s |
| `agent-runtime/src/protocol.test.ts` | 35 passed, 5 failed | 33.60 s | 34.33 s |
| `tests/mc-restore-script.test.ts` | 51 passed | 120.84 s | 121.18 s |
| `agent-runtime/src/executor-journal.test.ts` | 46 passed, 1 failed | 126.84 s | 127.29 s |
| `scripts/operations/destroy.test.ts` | 64 passed | 199.59 s | 200.79 s |

Focused total: 236 passed and 6 failed across 242 tests. The two non-passing files are detailed below.

### Protocol file

The complete file run failed these five tests:

- `backs off across RestartSec and queries the durable exact result after reconnect`: expected delays `[1100, 2200]`,
  received `[1100, 2200, 1100]` at `agent-runtime/src/protocol.test.ts:1008`.
- `replaces cached indeterminate evidence after a root-authorized clean executor epoch`: terminal receipt was
  `undefined` instead of `{ outcome: "indeterminate" }` at line 1601.
- The `deleted`, `replayed`, and `forged` journal variants failed their seed setup at line 1794: expected the seed
  result to be `succeeded`, received `indeterminate`.

These failures were not stable as isolated reproductions. Running each affected pattern separately with the exact same
environment passed: the RestartSec test was 1/1 in 1.79 s real time, the clean-epoch test was 1/1 in 1.52 s, and all
five journal variants were 5/5 in 3.02 s. The journal-variant failure therefore did not reach its corruption assertion.
No protocol source change is justified by this evidence.

### Executor journal file

The complete file run failed only:

- `applies a production append transaction only when its complete authenticated frame is durable`, timed out at its
  declared 60,000 ms test timeout at `agent-runtime/src/executor-journal.test.ts:918`.

Running that test alone with the exact same environment passed 1/1 in 29.68 s real time. No timeout was increased and no
executor-journal source change is justified by this evidence.

## Outcome

The other five complete files passed when run individually. The two complete-file failures also passed when isolated to
the affected tests, while the historical full suite remains failed. This establishes suite sequencing/resource or
timing sensitivity, not a demonstrated reachable product defect. No code was edited, no authority behavior was changed,
and no escalation was made.
