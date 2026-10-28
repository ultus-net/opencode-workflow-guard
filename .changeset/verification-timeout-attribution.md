---
"opencode-workflow-guard": patch
---

Report a verification timeout as a timeout, not as a failing test.

Finalization runs the verify command with a bounded timeout. When the command
exceeded it, the guard killed the process tree and then reported the outcome
with the same message it uses for a failing assertion: "all tasks marked done
but verification is failing". That wording sent the agent looking for a test
that failed. Nothing had failed; the suite never finished, so the result was
unknown.

The two conditions now carry separate codes and reasons. `runVerify` returns
`timedOut` and the limit that was hit, and the dispatcher emits
`verification_timed_out` with a message naming the elapsed limit and the remedy
(`verifyTimeoutMs` in `.opencode/workflow-guard.json`, or
`WORKFLOW_GUARD_VERIFY_TIMEOUT_MS`). A genuine failure keeps
`verification_failed` and its output tail unchanged.

Both still block finalization. A timeout is not evidence of passing work, so
allowing it through would be a silent weakening of the verification gate. Only
the attribution changed.

Regression coverage asserts five things: a timeout blocks finalization, the
block reason does not claim a failure, the snipped tail carries no "Verification
Failed" header, the limit is named at the precision it was set, and the reason
names a remedy. Four of those fail against the previous message; the block
itself already held, and must keep holding.

The remedy is the one lever the agent cannot pull. `.opencode/workflow-guard.json`
is tamper-protected, so the reason names both the project setting and the
environment variable, and the operator applies it. That is deliberate: the guard
reports what it knows, and does not pretend the agent can widen its own gate.
