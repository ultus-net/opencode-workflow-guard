---
"opencode-workflow-guard": patch
---

`guard_worktree_cleanup` / `cleanupGitWorktree` is now idempotent for a registered worktree whose directory is missing — the prunable admin entry that `git worktree list` shows after a manual removal, a crashed add, or external cleanup. It deregisters the stale entry instead of failing with "does not exist". Paths outside the configured storage directory, and paths that are not registered worktrees of the repository, are still refused; a failed prune is reported with its git exit status.

The deregistration runs a repo-wide `git worktree prune` for the current repository: every worktree whose directory is missing at that moment is deregistered, so a temporarily unavailable path's admin entry can be dropped. Worktree contents are never touched, and `git worktree repair` restores admin entries if a path returns.
