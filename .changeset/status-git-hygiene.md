---
"opencode-workflow-guard": minor
---

`guard_status` now includes a read-only `gitHygiene` snapshot: local branches already merged into the mainline (capped list plus true count, excluding the current and unmerged branches), prunable worktree admin entries (clearable with `guard_worktree_cleanup` / `cleanupGitWorktree` or `git worktree prune`), and the current branch's base-behind distance when a remote base exists. Hygiene itself stays manual — the guard reports accumulated git state, it never prunes, fetches, or deletes branches on its own.
