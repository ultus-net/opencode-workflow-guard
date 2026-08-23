---
"opencode-workflow-guard": minor
---

**Completion claims vs evidence (Policy 24, observability).** A new `experimental.text.complete` hook compares the assistant's final wrap-up text against recorded verification evidence. When the response asserts completion or passing tests but the session's verification is failing, stale (mutations after the verify run), or missing entirely, the mismatch is journaled to the audit trail and logged at warn level. This is observability, not gating — responses are never blocked — but confident wrap-ups can no longer silently contradict the evidence trail.

**Honest tool descriptions.** A new `tool.definition` hook enriches the `todowrite` tool description with the finalization-gate note (fresh verification evidence required after the last mutation), so the model is not surprised by blocks at completion time. Other tools are untouched and the enrichment is idempotent.
