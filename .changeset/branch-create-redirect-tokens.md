---
"opencode-workflow-guard": patch
---

Fix branch-creation staleness classification when the command carries shell redirections: `git switch -c feat/x 2>&1` (or `2>/dev/null`, `> /dev/null`) no longer misclassifies the redirection token as an explicit start point and fails closed; redirections are ignored and the HEAD-based or explicit start-point check applies as intended.