---
"opencode-workflow-guard": patch
---

Security fix: a session could widen its write boundary into another repository through a single allowed read. `registerSessionWorkspaceFromToolCall` adopted the git root of any `workdir`/`filePath` argument, even when the session already had a bound workspace, so reading a file in a foreign repository moved the boundary there and later writes into that repository were allowed. A path-derived candidate now binds only an unbound session. Widening a bound session requires an explicit host-declared per-call worktree (worktree isolation and relay flows), and every granted or refused widening is journaled as `workspace.binding`. Regression checks cover the foreign-read, foreign-write, and legitimate host-worktree cases.
