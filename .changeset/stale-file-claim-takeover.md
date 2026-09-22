---
"opencode-workflow-guard": patch
---

Stale file-claim takeover for a missed idle release: a direct-edit claim created before its owner's last recorded idle timestamp cannot belong to an in-flight tool call, so when another session hits that conflict every provably stale claim of that owner is released (each re-checked after the owner lookup) with an audited `stale_claim_takeover` entry instead of blocking every session until the owner is deleted or the service restarts. Owners still mid-session (no idle timestamp), clients without a session lookup, and failed lookups keep the block (fail-closed), and `guard_why` remains read-only. Claims now record their creation timestamp, and a same-session re-claim refreshes the stored claim so its release matches the in-flight call.
