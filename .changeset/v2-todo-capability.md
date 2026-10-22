---
"opencode-workflow-guard": minor
---

Probe the host's `todowrite` capability instead of inferring it from session history. OpenCode 2.1.x reintroduces `todowrite` behind `experimental.todo: true`, and on that host a session with no todo list has never planned, which must gate mutations. On 2.0.x the tool does not exist, so the gate still fails open; that path now logs once per session, journals an audit record, and reports `todoCapability` in `guard_status` instead of staying silent.

Also add a completion-laundering audit signal. Marking a task `completed` with no mutation since the previous `todowrite` writes a `completion_claim_mismatch` record. It never blocks: the verification and review gates remain the authority, and read-only tasks complete legitimately without a mutation.

Live acceptance on OpenCode 2.1.x is NOT RUN here, because the installed host is 2.0.15 and has no `todowrite` to probe. The capability probe, the gate inversion, and the fail-open path are covered by unit tests with synthetic session and registry data.
