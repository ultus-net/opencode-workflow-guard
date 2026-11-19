---
"opencode-workflow-guard": patch
---

Expose the provenance of verification and review evidence in `guard_status`.

- `guard_status.lastVerify` now reports its observation timestamp and duration beside the command, pass state, freshness, evidence id, and commit hash. A configured `verifyCommand` that runs green therefore leaves a record naming when it ran and the commit it covered, instead of only an anonymous evidence id.
- `guard_status.lastReview` now reports its observation timestamp together with `recorderSessionID`, `recorderRole` (`root` or `subagent`), and `targetSessionID`. Under `requireSubagentReview`, this shows that an approval came from a subagent session rather than the root session it was recorded for.
- `record_review` keeps the recorder lineage on the stored verdict, and the durable review cache carries the same optional fields. `record_review` itself stays registered for every session; a deny-all reviewer toolset still needs the host permission grant in its own agent definition.
