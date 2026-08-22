---
"opencode-workflow-guard": minor
---

Add native in-process Git worktree lifecycle tools:
- `guard_worktree_create(branch, baseBranch?)`: creates an isolated git worktree under `~/.local/share/opencode/worktrees/<repo-name>/` (override with `WORKFLOW_GUARD_WORKTREE_DIR`), validates branch names via `git check-ref-format`, rejects built-in and config-defined protected branches, and symlinks the parent `node_modules` for zero-reinstall tooling
- `guard_worktree_cleanup(worktreePath)`: commits a final auto-snapshot (excluding the plugin-created `node_modules` symlink) before removing the worktree; aborts with the worktree intact when the snapshot cannot be established
- Cleanup is ownership-validated: only registered worktrees of the current repository under the configured storage directory are removed — arbitrary directories, other repos' worktrees, and the primary working tree are refused, and there is no raw-deletion fallback
- Both tools enforce the todo gate and invalidate stale verification/review evidence on mutation
- Spawned git commands run with a sanitized environment (git context variables such as `GIT_INDEX_FILE` are stripped), so the tools work reliably even when invoked from inside git hook contexts
- Branches configured via `protectedBranches` in `.opencode/workflow-guard.json` now receive destination-side push protection, matching the built-in main/master rules (`git push origin feature/x:release/prod` is blocked)
- Enables fully isolated concurrent subagent execution with no external dependencies or terminal spawning
