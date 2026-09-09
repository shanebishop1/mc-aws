# G2 narrow maintenance and console handoff

**Status:** implementation candidate; production OS validation remains blocked

This slice adds the `maintenance.apply` capability. Its first supported operation contains only
`server.properties`, the `motd` key and one canonical decoded value, the approved
pre-edit and post-edit byte identities, `restore-prior` service intent, and an
expected loopback Minecraft protocol MOTD. The executor must hold the existing
gateway backup fence and sends the exact invocation identity to the root broker.

The root `mc-agent-host-broker` adopts only that exact active invocation fence.
It does not wait for executor idle (the caller is the active executor), does not
accept a service or path argument, and does not expose a screen socket. It stops
only `minecraft.service`, uses the existing authenticated world-root transaction
for the staged `server.properties` edit, restores the recorded service intent,
and verifies that exact decoded MOTD with an independent `mcstatus` protocol observation.
Other `server.properties` keys are rejected until they have command-specific observers.
Verification failure after the transaction is committed is indeterminate and
retains the durable maintenance exclusion; it is never automatically retried.

The same broker provides the narrow credentialless console bridge. It accepts only
`minecraft:list` or `minecraft:kick <exact-player> [reason]`. List is answered by
an exact query observation without console dispatch. Kick is dispatched under the
fixed `minecraft` account and succeeds only after the exact player's absence is
observed; accepted dispatch with unavailable verification remains indeterminate.
Tools and the trusted executor receive no screen socket or host service authority.

Executable plugin installation remains unavailable to ordinary tools. The profile
lock schema now carries an optional exact `bytes` identity; the host installer
requires it for new or changed entries and permits omission only when the existing
installed artifact matches the legacy digest. Existing deployed locks must not be
populated with invented sizes. No plugin artifact is downloaded or enabled by this
maintenance capability, and production rollout/readiness remains unqualified until
the separately reviewed profile path passes its composition gate.

Local deterministic fixtures may substitute `systemctl`, `runuser`/`screen`, and
`mcstatus`; that proves helper protocol plumbing, Java-properties behavior, and
durable phase classification only. No cloud, download,
privileged service operation, or production host validation is implied by those
fixtures. The approved offline service-manager runner and full crash/recovery
matrix remain G3/G4 blockers.
