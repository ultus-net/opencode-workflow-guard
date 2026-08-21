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
- `git push … main` and `git push … master` are blocked in all shell commands, including direct refs, refspecs (`git push origin HEAD:main`, `git push origin feature/x:main`), deletion refspecs (`git push origin :main`), and forced refspecs (`git push origin +main`).
- Git global options (`-C`, `--git-dir`, `--work-tree`, `-c`) are parsed before matching, so `git -C /repo push origin main` is gated on `/repo`'s branch.
- Normal pushes and force-pushes to feature branches are allowed.

### 3. PR Changelog Requirement
- `gh pr create` is blocked unless the PR body (`--body` or `--body-file`/`-F`) contains a `Changelog:` section or the branch diff modifies a CHANGELOG file.

### 4. Destructive CLI Operations Guard
- Blocks destructive filesystem, infrastructure, cloud, database, and git operations unless the **user** explicitly overrides via environment variable.
- **Blocked:**
  - Filesystem: `rm -rf`, `rm -r`, forced deletion of system/home paths
  - Kubernetes: `kubectl delete`, `kubectl drain`, `kubectl cordon`, `kubectl rollout undo/restart`
  - Helm: `helm uninstall`, `helm rollback`, `helm delete`
  - IaC: `terraform destroy`, `tofu destroy`, `pulumi destroy`
  - Containers: `docker rm`, `docker container/system/image/volume prune`, `docker volume rm`
  - Cloud: `az … delete/purge`, `aws … delete/terminate`, `gcloud … delete/abandon`
  - Hosted Git: `gh repo/issue/pr/release/secret/variable delete|close`
  - Databases: `psql/mysql/mariadb/mongosh/redis-cli/sqlite3` drop, delete, truncate, flushall; `prisma migrate reset`
  - Remote HTTP: `curl -X DELETE` against non-localhost endpoints
  - Git: `git push --force`, `git push +refspec`, `git clean -fdx`
- **Allowed:** Non-destructive mutations (`kubectl apply`, `terraform apply`, `helm upgrade`, `az create/update`, DB inserts, `curl POST/PUT/PATCH`, `docker ps`, single-file `rm`).

### 5. MCP Mutation Guard
- MCP tools that mutate live GitHub or Azure/DevOps systems (`create`, `update`, `delete`, `merge`, `push`, `close`, etc.) are blocked.
- Server names are tokenized on all non-alphanumerics, so `mcp__azure-devops__…`, `mcp__gh__…` and flat legacy names (`azure_devops_*`) are matched.
- Read-only tools (`get`, `list`, `search`, `query`, etc.) are permitted.

### 6. Settings Tamper Guard
- Prevents the agent from weakening its own permission gates **via shell or edit tools**:
  - Shell writes/redirects to `opencode.json[c]`, `~/.config/opencode/*`, `.opencode/*`, or the guard's own plugin/TUI files (`~/.config/opencode/plugins/*`, `~/.config/opencode/ui/*`)
  - Direct edits of the same paths through the `edit`/`write`/`apply_patch` tools
  - Shell commands invoking `opencode auth`, `opencode config`, `opencode permission`, or `opencode run --auto`
  - Evasion-normalized: quote-concatenation (`open''code.json`), escapes (`open\c\ode`), and glob wildcards (`opencode.jso?`) are stripped before matching.
- **Read-only access is allowed** (`cat`, `less`, `grep`, `head`, `tail` on config files) — only modification attempts trigger the guard.

### 7. Feature-Branch Workflow
- When the workspace git repository is on `main` or `master`, all file mutations and history-changing git commands (`commit`, `merge`, `rebase`, `cherry-pick`, `revert`, `apply`, `am`, `reset`, `restore`, `stash pop`, `update-ref`, `filter-branch`, `branch -D/-M`) are blocked.
- Git global flags are parsed, so `git -C /repo commit` is gated on `/repo`'s branch, not the workspace's.
- The agent is prompted to create a feature branch first (`git switch -c feat/my-feature`).

### 8. Workspace Boundary Guard
- File modification tools (`edit`, `write`, `apply_patch`) and shell mutations (redirection `>`, `tee`, `sed -i`, `cp`/`mv`, `git apply`/`git am`) are validated to ensure targets cannot escape the current workspace root via `../` traversal or absolute paths.

### 10. Post-Edit Verification
- After every successful `edit`/`write`/`apply_patch`, the guard runs a verify command (`WORKFLOW_GUARD_VERIFY` env, or auto-detected `npm test` from `package.json`) in the background.
- When the agent tries to mark **every** todo completed (finalize), the todowrite is blocked while the latest verify run is failing, with the command's tail output provided.
- The verify command is **disabled** when `WORKFLOW_GUARD_VERIFY` is empty (`""`) — set to any command to override the auto-detection.

### 11. Secret-Content Scan
- File payloads are scanned for common credential material (AWS keys, private key headers, GitHub tokens, OpenAI/LLM keys, Google API keys, Slack tokens, explicit env-style assignments).
- Flagged content is blocked at the write/edit step with an actionable message.

### 12. Shell Environment Scrub
- Sensitive environment variables (`AWS_*`, `KUBE*`, `OPENAI*`, `ANTHROPIC*`, `GH_/GITHUB_*`, `GOOGLE_/GCP_`, `AZURE_`, `SLACK_`, `NPM_`, `DOCKER_`, `KUBECONFIG`, and fixed names like `GITHUB_TOKEN`, `OPENAI_API_KEY`, `KUBECONFIG`, `NPM_TOKEN`) are **emptied** in agent shells by the `shell.env` hook.
- This prevents the agent from carrying live credentials by default. The user can still grant access through OpenCode's own permission system if a task genuinely needs it.

### 13. Command-Channel Audit
- User-triggered slash commands (`command.executed` events) are journaled to the audit trail so agents cannot perform hidden work through a user-facing side channel.

### 14. Audit Trail
- Every block/allow decision is appended to `~/.local/state/opencode/workflow-guard/workflow-guard.jsonl` (XDG_STATE_HOME respected) with a timestamp, session id, tool name, decision, and reason — a durable record.
- `client.app.log()` complements the on-disk trail with in-app logs.

### 15. Compaction Focus Preservation
- Integrates with OpenCode's `experimental.session.compacting` hook to inject the active sequential task list into `output.context` before context summarization, ensuring the model retains its plan across long sessions.

### 16. TUI Visual Feedback
- Emits real-time warning toasts to the user interface via `tui.showToast` whenever a guard policy blocks a tool call.

---

## Overrides ("Unless Otherwise Specified")

The ONLY override is the **`WORKFLOW_GUARD_ALLOW_LIVE=1` environment variable**, which the **user** must set before launching the agent. It affects:
- Destructive CLI commands (Policy 4)
- MCP mutations (Policy 5)
- File payloads containing destructive commands (Policy 9)

Verification command selection uses **`WORKFLOW_GUARD_VERIFY`** (empty = auto-detect off, string = your command).

There is **deliberately no in-command override** (no `# allow-live` marker): an override the agent can append to its own command — or is told about in an error message — is an override the agent will use.

**Workflow & security gates (Policies 1, 2, 3, 6, 7, 8) have no override** — by design.

---

## Known Limits (Defense in Depth)

These guards match on command and file strings. An agent that base64-encodes a payload, invokes an interpreter directly (`python3 -c …`), or uses exotic shell redirection can evade pattern matching. This plugin is a **deterrent against forgetful or complacent agents**, not a sandbox. Pair it with:
- GitHub branch protection/rulesets server-side
- OS-level workspace isolation (containers, read-only mounts)

for hard guarantees.
