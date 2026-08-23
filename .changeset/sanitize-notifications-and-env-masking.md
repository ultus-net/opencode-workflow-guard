---
"opencode-workflow-guard": patch
---

Security hardening and operational optimizations:
- Sanitize desktop notifications against AppleScript command injection on macOS
- Redact multiline secret value continuations completely in `.env` schema masking
- Bounded tail buffering in `getRecentAuditEntries` to prevent memory spikes on long-lived logs
- Sanitize base reference inputs in `guard_review_rubric`
