---
"opencode-workflow-guard": patch
---

Judge git commands against the tree they actually run in, and stop denying cwd-dependent commands from the wrong checkout.

- `parseGitInvocation` accepts the shell's `workdir` as its base directory, so branch, mergeability, and protected-branch checks judge the checkout the command runs in rather than the session-bound one.
- A linked worktree of the same repository is no longer treated as foreign state for git mutations and pushes.
- PR preflight resolves `gh --head` / `-H` and `az --source-branch` to the worktree holding that branch, and the merge check takes the resolved ref instead of `HEAD`.
- The V2 permission seat defers cwd-dependent commands (`git push`, history writes, branch creation, PR creation) with code `repository_unidentified` instead of judging the session-bound checkout. An explicit `-C`/`--git-dir`/`--work-tree`/`GIT_DIR` stays decisive, and so does a push to `main` or `master`; a configured `protectedBranches` destination defers like any other cwd-dependent verdict. A block from another policy in the same compound command keeps its denial.
- A repository claim is only an assignment: `GIT_DIR=` inside a commit message is message text, not a repository selector, including through `env`/`sudo`/`timeout` wrappers. A repository selection that cannot be resolved (`git -C $OTHER_REPO`) stays a boundary block even when the session's own workspace is a repository, because the linked-worktree exemption would otherwise resolve it to the workspace's own root.
- Host session moves rebind the session workspace, journaled as `workspace.binding` / `workspace_rebind_session_move`. Only a genuine move rebinds: an announced `session.next.moved`, or an update naming a new directory. A routine title or cost update no longer drags a session out of the linked worktree its own tool calls bound it to.
- A verification timeout now tells the agent the truth about the remedy. The limit is set by the user, in the project `.opencode/workflow-guard.json` or `.jsonc`, or by `WORKFLOW_GUARD_VERIFY_TIMEOUT_MS` before the guard starts. The public type surface exports `VerifyRun`.
