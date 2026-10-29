---
"opencode-workflow-guard": patch
---

Judge git commands against the tree they actually run in, and stop denying cwd-dependent commands from the wrong checkout.

- `parseGitInvocation` accepts the shell's `workdir` as its base directory, so branch, mergeability, and protected-branch checks judge the checkout the command runs in rather than the session-bound one.
- A linked worktree of the same repository is no longer treated as foreign state for git mutations and pushes.
- PR preflight resolves `gh --head` / `-H` and `az --source-branch` to the worktree holding that branch, and the merge check takes the resolved ref instead of `HEAD`.
- The V2 permission seat defers cwd-dependent commands (`git push`, history writes, branch creation, PR creation) with code `repository_unidentified` instead of judging the session-bound checkout. An explicit `-C`/`--git-dir`/`--work-tree`/`GIT_DIR` and a push to an explicitly protected branch stay decisive.
- Host session moves rebind the session workspace, journaled as `workspace.binding` / `workspace_rebind_session_move`.
