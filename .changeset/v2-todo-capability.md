---
"opencode-workflow-guard": minor
---

Probe the host's `todowrite` capability instead of inferring it from session history. OpenCode 2.1.x reintroduces `todowrite` behind `experimental.todo: true`, and on that host a session with no todo list has never planned, which must gate mutations. On 2.0.x the tool does not exist, so the gate still fails open; that path now logs once per session, journals an audit record, and reports `todoCapability` in `guard_status` instead of staying silent.

Also add a completion-laundering audit signal. Marking a task `completed` with no mutation since the previous `todowrite` writes a `completion_claim_mismatch` record. It never blocks: the verification and review gates remain the authority, and read-only tasks complete legitimately without a mutation.

Live acceptance on OpenCode 2.1.3: `ctx.tool.list()` at setup exposes
`todowrite` when `experimental.todo: true` is set and omits it when the flag is
false, so the probe reports `available` and `unavailable` against the real host
registry rather than synthetic data. The capability probe, the gate inversion,
and the fail-open path are also covered by unit tests.
