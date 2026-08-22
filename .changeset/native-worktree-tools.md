---
"opencode-workflow-guard": minor
---

Add native in-process Git worktree lifecycle tools:
- `guard_worktree_create(branch, baseBranch?)`: creates an isolated git worktree under `~/.local/share/opencode/worktrees/<repo-name>/` (override with `WORKFLOW_GUARD_WORKTREE_DIR`), validates branch names against git ref rules, rejects protected branches, and symlinks the parent `node_modules` for zero-reinstall tooling
- `guard_worktree_cleanup(worktreePath)`: commits a final auto-snapshot of remaining changes before removing the worktree, then prunes stale worktree metadata
- Spawned git commands run with a sanitized environment (git context variables such as `GIT_INDEX_FILE` are stripped), so the tools work reliably even when invoked from inside git hook contexts
- Enables fully isolated concurrent subagent execution with no external dependencies or terminal spawning
