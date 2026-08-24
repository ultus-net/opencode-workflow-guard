---
"opencode-workflow-guard": refactor
---

Consolidate process-monitor detection into one token-scoped check, make the review
fingerprint commit-independent (index blob hashes + worktree-vs-index diff + untracked contents), and
evaluate the boundary fallback lazily only when specific detectors miss.
