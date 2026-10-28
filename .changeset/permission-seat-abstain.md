---
"opencode-workflow-guard": patch
---

Let the V2 permission seat abstain when remote PR state is unverified.

Every non-protected `git push` was denied on OpenCode 2, with a message that contradicted itself. The seat always evaluates the policy core with `simulate: true`, which deliberately skips the remote GitHub/Azure PR probe. The core then reports `needs_approval` (`remote_state_unchecked`), and the seat collapsed every non-`allowed` status into `effect = "deny"`. The denial therefore demanded the result of a probe the same code path had just skipped.

`needs_approval` is a third state meaning "cannot decide here", not a finding. `PermissionSeatResult.effect` now carries `abstain` alongside `allow` and `deny`. Only a `blocked` decision denies. An abstention leaves the host's configured effect and message untouched, so a configured `ask` stays `ask`, and `execute.before` runs the real check with the probe. The seat still cannot upgrade an effect.

The abstention is journaled with `decision: "abstain"`, `reason: "deferred_to_execute_before"`, and the preserved `needs_approval` decision, so a skipped probe stays readable in the audit trail instead of appearing as a plain allow. The seat's fail-closed `catch` block is unchanged. `guard_why` still reports `needs_approval`, because that is the honest answer for a simulation; this changes the seat, not the policy core.
