---
"opencode-workflow-guard": minor
---

Ecosystem-inspired DX and safety enhancements across verification, secret inspection, and multi-agent coordination:
- **Safe .env Schema Masking (Policy 17):** Reading `.env*` files returns a sanitized variable schema mask (`KEY=********`) allowing agents to discover required environment variable names without exposing live secret values.
- **Verification Output Snipping (Policy 10):** Truncates verbose passing/failing verification stdout/stderr (`snipVerifyOutput`) prioritizing error keywords and stack traces to minimize context bloat.
- **Git State & Snapshot Binding (Policy 10):** Verification results now capture git commit hash (`git rev-parse HEAD`) and working tree status (`git status --porcelain`) to invalidate stale verification on external changes.
- **Durable Verification Disk Cache (Policy 10/14):** Passing verification results are cached to disk (`~/.local/state/opencode/workflow-guard/last-verify.json`) across session restarts and multi-agent handoffs.
- **Subagent Attribution & Breadcrumb Tagging (Policy 1/14/15):** Compaction hooks and audit trail entries now preserve subagent role identity and parent hierarchy links.
- **Mutation Accounting (Policy 10):** Added `getMutationCount()` tracking for audit and lifecycle verification.
