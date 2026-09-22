---
"opencode-workflow-guard": patch
---

Stale file-claim takeover for a missed idle release: a direct-edit claim created before its owner's last recorded idle timestamp cannot belong to an in-flight tool call, so when another session hits that conflict the stale claim is released with an audited `stale_claim_takeover` entry instead of blocking every session until the owner is deleted or the service restarts. Owners still mid-session (no idle timestamp), clients without a session lookup, and failed lookups keep the block (fail-closed), and `guard_why` remains read-only. Claims now record their creation timestamp for this comparison.
