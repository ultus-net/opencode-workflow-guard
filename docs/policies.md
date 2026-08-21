# Enforced Policies & Guardrails

`opencode-workflow-guard` enforces workflow discipline through **deterministic TypeScript hooks** (`tool.execute.before` and `experimental.session.compacting`) — not prompt rules that LLMs can ignore.

---

## Policy Reference

### 1. Task Breakdown & Lifecycle (`todowrite`)
- **Pre-edit Gate:** All file-editing tools (`edit`, `write`, `apply_patch`) are blocked until the session has an active task list in OpenCode's native todo system (`todowrite`, persisted at `GET /session/:id/todo`).
- **Focus Rule:** Only one task may be `in_progress` at any given time. The agent is prevented from scattering focus across multiple parallel tasks.
- **Top-Down Sequential Execution:** Task $N$ cannot be marked `completed` while an earlier task ($0 \dots N-1$) is still `pending` or `in_progress`.
- **No Silent Deletion:** Active tasks cannot be deleted without being explicitly marked `completed` or `cancelled`.
- **Subagent Inheritance:** Subagents (which have `todowrite` denied by default) automatically inherit active tasks from their parent session via the `parentID` hierarchy.

### 2. No Pushes to Protected Branches
- `git push … main` and `git push … master` are blocked in all shell commands, including refspecs (`git push origin HEAD:main`).
- Normal pushes and force-pushes to feature branches are allowed.

### 3. PR Changelog Requirement
- `gh pr create` is blocked unless the PR body (`--body` or `--body-file`/`-F`) contains a `Changelog:` section or the branch diff modifies a CHANGELOG file.

### 4. Destructive CLI Operations Guard
- Blocks destructive infrastructure, cloud, database, and git operations unless explicitly overridden.
- **Blocked:**
  - Kubernetes: `kubectl delete`, `kubectl drain`, `kubectl cordon`, `kubectl rollout undo/restart`
  - Helm: `helm uninstall`, `helm rollback`, `helm delete`
  - IaC: `terraform destroy`, `tofu destroy`, `pulumi destroy`
  - Cloud: `az … delete/purge`, `aws … delete/terminate`, `gcloud … delete/abandon`
  - Databases: `psql/mysql/mariadb/mongosh/redis-cli/sqlite3` drop, delete, truncate, flushall
  - Remote HTTP: `curl -X DELETE` against non-localhost endpoints
  - Git: `git push --force`
- **Allowed:** Non-destructive mutations (`kubectl apply`, `terraform apply`, `helm upgrade`, `az create/update`, DB inserts, `curl POST/PUT/PATCH`).

### 5. MCP Mutation Guard
- MCP tools that mutate live GitHub or Azure/DevOps systems (`_create`, `_update`, `_delete`, `_merge`, `_push`, `_close`, etc.) are blocked.
- Read-only tools (`_get`, `_list`, `_search`, `_query`, etc.) are permitted.

### 6. Settings Tamper Guard
- Prevents the agent from weakening its own permission gates:
  - Edits to `opencode.json` or `~/.config/opencode/*`
  - Shell commands invoking `opencode auth`, `opencode config`, `opencode permission`, or `opencode run --auto`

### 7. Feature-Branch Workflow
- When the workspace git repository is on `main` or `master`, all file edit tools and history-changing git commands (`commit`, `merge`, `rebase`, `cherry-pick`, `revert`, `apply`, `am`, `reset`, `restore`, `stash pop`) are blocked.
- The agent is prompted to create a feature branch first (`git switch -c feat/my-feature`).

### 8. Workspace Boundary Guard
- File modification tools (`edit`, `write`, `apply_patch`) are validated to ensure target file paths cannot escape the current workspace root or git worktree via `../` path traversal or absolute paths.

### 9. Compaction Focus Preservation
- Integrates with OpenCode's `experimental.session.compacting` hook to inject the active sequential task list into `output.context` before context summarization, ensuring the model retains its plan across long sessions.

### 10. TUI Visual Feedback
- Emits real-time warning toasts to the user interface via `tui.showToast` whenever a guard policy blocks a tool call.

---

## Overrides ("Unless Otherwise Specified")

Overrides are explicit and auditable:
- **Destructive CLI commands:** Append `# allow-live` to the command string (e.g. `kubectl delete pod my-pod # allow-live`), or set `WORKFLOW_GUARD_ALLOW_LIVE=1`.
- **MCP mutations:** Set `WORKFLOW_GUARD_ALLOW_LIVE=1` in the environment.
- **Workflow & Security gates (Policies 1, 2, 3, 6, 7, 8):** No override — by design.
