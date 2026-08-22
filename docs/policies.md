# Enforced Policies & Guardrails

`opencode-workflow-guard` enforces workflow discipline through **deterministic TypeScript hooks** (`tool.execute.before` and `experimental.session.compacting`) - not prompt rules that LLMs can ignore.

---

## Policy Reference

### 1. Task Breakdown & Lifecycle (`todowrite`)
- **Pre-edit Gate:** All file-editing tools (`edit`, `write`, `apply_patch`) are blocked until the session has an active task list in OpenCode's native todo system (`todowrite`, persisted at `GET /session/:id/todo`).
- **Flexible Task Execution:** Tasks can be completed in any order as work concludes without artificial sequential blockers, maintaining maximum pair-programming DX.
- **No Silent Deletion:** Active tasks cannot be deleted without being explicitly marked `completed` or `cancelled`.
- **Subagent Inheritance:** Subagents (which have `todowrite` denied by default) automatically inherit active tasks from their parent session via the `parentID` hierarchy.

### 2. No Pushes to Protected Branches
- `git push ... main` and `git push ... master` are blocked in all shell commands, including direct refs, refspecs (`git push origin HEAD:main`, `git push origin feature/x:main`), deletion refspecs (`git push origin :main`), and forced refspecs (`git push origin +main`).
- Git global options (`-C`, `--git-dir`, `--work-tree`, `-c`) are parsed before matching, so `git -C /repo push origin main` is gated on `/repo`'s branch.
- Normal pushes and force-pushes to feature branches are allowed.

### 3. PR Changelog & Changesets Requirement
- `gh pr create` and `az repos pr create` are blocked unless:
  - The branch diff modifies a `CHANGELOG` file, OR
  - The branch diff adds/modifies a `.changeset/*.md` fragment file (Changesets workflow), OR
  - The PR description (`--body`, `--description`, or `--body-file`/`-F`) contains a `Changelog:` section.

### 4. Destructive CLI Operations Guard
- Blocks destructive filesystem, infrastructure, cloud, database, and git operations unless the **user** explicitly overrides via environment variable.
- **Blocked:**
  - Filesystem: `rm -rf`, `rm -r`, forced deletion of system/home paths
  - Kubernetes: `kubectl delete`, `kubectl drain`, `kubectl cordon`, `kubectl rollout undo/restart`
  - Helm: `helm uninstall`, `helm rollback`, `helm delete`
  - IaC: `terraform destroy`, `tofu destroy`, `pulumi destroy`
  - Containers: `docker rm`, `docker container/system/image/volume prune`, `docker volume rm`
  - Cloud: `az ... delete/purge`, `aws ... delete/terminate`, `gcloud ... delete/abandon`
  - Hosted Git: `gh repo/issue/pr/release/secret/variable delete|close`
  - Databases: `psql/mysql/mariadb/mongosh/redis-cli/sqlite3` drop, delete, truncate, flushall; `prisma migrate reset`
  - Remote HTTP: `curl -X DELETE` against non-localhost endpoints
  - Git: `git push --force`, `git push +refspec`, `git clean -fdx`
- **Allowed:** Non-destructive mutations (`kubectl apply`, `terraform apply`, `helm upgrade`, `az create/update`, DB inserts, `curl POST/PUT/PATCH`, `docker ps`, single-file `rm`).

### 5. MCP Mutation Guard
- MCP tools that mutate live GitHub or Azure/DevOps systems (`create`, `update`, `delete`, `merge`, `push`, `close`, etc.) are blocked.
- Server names are tokenized on all non-alphanumerics, so `mcp__azure-devops__...`, `mcp__gh__...` and flat legacy names (`azure_devops_*`) are matched.
- Read-only tools (`get`, `list`, `search`, `query`, etc.) are permitted.

### 6. Settings Tamper Guard
- Prevents the agent from weakening its own permission gates **via shell or edit tools**:
  - Shell writes/redirects to `opencode.json[c]`, `~/.config/opencode/*`, `.opencode/*`, or the guard's own plugin/TUI files (`~/.config/opencode/plugins/*`, `~/.config/opencode/ui/*`)
  - Direct edits of the same paths through the `edit`/`write`/`apply_patch` tools
  - Shell commands invoking `opencode auth`, `opencode config`, `opencode permission`, or `opencode run --auto`
  - Evasion-normalized: quote-concatenation (`open''code.json`), escapes (`open\c\ode`), and glob wildcards (`opencode.jso?`) are stripped before matching.
- **Read-only access is allowed** (`cat`, `less`, `grep`, `head`, `tail` on config files) - only modification attempts trigger the guard.

### 7. Feature-Branch Workflow
- When the workspace git repository is on `main` or `master`, all file mutations and history-changing git commands (`commit`, `merge`, `rebase`, `cherry-pick`, `revert`, `apply`, `am`, `reset`, `restore`, `stash pop`, `update-ref`, `filter-branch`, `branch -D/-M`) are blocked.
- Git global flags are parsed, so `git -C /repo commit` is gated on `/repo`'s branch, not the workspace's.
- The agent is prompted to create a feature branch first (`git switch -c feat/my-feature`).

### 8. Workspace Boundary Guard
- File modification tools (`edit`, `write`, `apply_patch`) and common shell mutations (redirection `>`, `tee`, `sed -i`, `cp`/`mv`/`ln`, `touch`, `mkdir`, `rm`, `git apply`/`git am`) are validated to ensure targets cannot escape the current workspace root via `../` traversal, symlinks, or absolute paths.
- External repository git writes (`git -C /other-repo commit`) are also confined to the workspace.

### 9. Script-Laundering Guard
- Content written via `edit`, `write`, or `apply_patch` is scanned for destructive CLI commands and settings tamper payloads.
- Prevents agents from bypassing shell guards by writing destructive commands to script files (e.g. `write deploy.sh` -> `bash deploy.sh`).

### 10. Evidence-Based Verification
- When the agent attempts to mark **every** task completed (finalizing the request), the guard requires passing verification evidence.
- Verification (`WORKFLOW_GUARD_VERIFY` env, project `verifyCommand`, or auto-detected `npm test` from `package.json`) executes in an isolated environment with scrubbed credentials, output caps, token-efficient stdout/stderr snipping, and strict timeout protection. Environment configuration takes precedence over project configuration.
- **Git State & Snapshot Binding:** Verification evidence records the current git commit hash (`git rev-parse HEAD`) and working tree status. If unverified edits or index modifications occur after verification, fresh verification is enforced.
- **Durable Disk Cache:** Passing verification results are cached to `~/.local/state/opencode/workflow-guard/last-verify.json`, allowing session restarts and multi-agent handoffs to retain valid verification evidence without redundant test runs.
- If verification fails, finalization is blocked with a structured summary of error markers, stack traces, and failure output.
- The verify command is **disabled** when `WORKFLOW_GUARD_VERIFY` is empty (`""`).

### 11. Secret-Content Scan
- File payloads and recognized shell file-mutation commands are scanned for common credential material (AWS keys, private key headers, GitHub tokens, OpenAI/LLM keys, Google API keys, Slack tokens, explicit env-style assignments).
- Flagged content is blocked before the write with an actionable message. Secret-file reads also resolve existing symlink aliases, and copying/moving/linking a known secret path under another name is blocked.

### 12. Shell Environment Scrub
- Sensitive environment variables (`AWS_*`, `KUBE*`, `OPENAI*`, `ANTHROPIC*`, `GH_/GITHUB_*`, `GOOGLE_/GCP_`, `AZURE_`, `SLACK_`, `NPM_`, `DOCKER_`, `KUBECONFIG`, and fixed names like `GITHUB_TOKEN`, `OPENAI_API_KEY`, `KUBECONFIG`, `NPM_TOKEN`) are **emptied** in agent shells by the `shell.env` hook.
- This prevents the agent from carrying live credentials by default. The user can still grant access through OpenCode's own permission system if a task genuinely needs it.

### 13. Command-Channel Audit
- User-triggered slash commands (`command.executed` events) are journaled to the audit trail so agents cannot perform hidden work through a user-facing side channel.

### 14. Audit Trail
- Every block/allow decision is appended to `~/.local/state/opencode/workflow-guard/workflow-guard.jsonl` (XDG_STATE_HOME respected) with a timestamp, session id, tool name, decision, subagent/parent session attribution, and reason - a durable record.
- `client.app.log()` complements the on-disk trail with in-app logs.

### 15. Compaction State & Focus Preservation
- Integrates with OpenCode's `experimental.session.compacting` hook to inject the full active operational state into `output.context` before context summarization:
  - Active `todowrite` tasks with status badges and subagent hierarchy attribution.
  - Active Git branch name and protected branch status.
  - Test verification status (passed/failed, test command, and commit hash).
  - Secondary review verdicts (reviewer name and approval status).
  - Uncommitted mutation counts.
- Ensures the model retains its operational context, security posture, and task roadmap across session compactions without hallucinations.

### 16. TUI Visual Feedback
- Emits real-time warning toasts to the user interface via `tui.showToast` whenever a guard policy blocks a tool call.

### 17. Secret-File READ Block & Safe Schema Masking
- Blocks reading sensitive credential files (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `*kubeconfig*`, `*credentials*.json`, `service-account*.json`) through the `read` tool or shell commands (`cat`, `less`, `more`, `grep`, `awk`, `head`, `tail`, `base64`).
- **Safe Schema Masking:** On `.env*` reads via the `read` tool, the guard parses the variable names and comments, and returns a safe redacted schema mask with secret values masked as `********`, enabling agents to inspect variable existence without leaking secrets into model context.
- Standard non-secret fixtures (`.env.example`, `.env.sample`, `.env.template`) remain readable.

### 18. Interpreter Inline Evasion Scanner
- Decodes and inspects inline interpreter payloads (`python -c`, `node -e`, `perl -e`, `ruby -e`, `osascript -e`, `powershell -enc`, `echo <base64> | base64 -d | sh`) to prevent smuggling live destructive commands or settings tampering past shell pattern checks.

### 19. Conflict-Free Pre-Flight Guard
- Evaluates `git merge-tree` against the base branch (`origin/main`, `origin/master`, `main`) before PR creation or final task handoff, ensuring changes can be merged cleanly without conflicts.

### 20. Merged Branch & Base Freshness Guard
- Blocks pushing to branches already merged or associated with closed PRs in GitHub or Azure DevOps.
- Blocks creating fresh feature branches when the local base branch is behind the remote, prompting the agent to pull latest changes first.

### 21. Documentation Review & Synchronization Guard
- Ensures that relevant documentation (`README.md` or `docs/`) is updated whenever changes introduce new features, policies, or public tools before PR creation. Configurable via `.opencode/workflow-guard.json` (`requireDocumentation: true`) or `WORKFLOW_GUARD_REQUIRE_DOCS=1`.

### 22. Non-Interactive Shell & TTY Hang Guard
- Blocks commands that spawn interactive text editors (`nano`, `vim`, `emacs`), interactive pagers (`less`, `more`), interactive monitors (`top`, `htop`), interactive rebase/patch prompts (`git rebase -i`, `git add -p`), `sudo`, or package managers missing non-interactive confirmation flags (`npm init` without `-y`, `apt-get` without `-y`).
- Prevents subshell agents from hanging indefinitely waiting for user stdin in background execution.
- **Desktop Notifications:** Emits native OS notifications (Linux `notify-send`, macOS `osascript`) when a policy blocks a command or when verification runs finish, keeping developers informed when their terminal is backgrounded. Configurable via `WORKFLOW_GUARD_NOTIFY=0`.

### 23. Package Supply-Chain & Dependency Hygiene Guard
- Blocks destructive package manager actions that break dependency trees or pollute machines:
  - `npm audit fix --force`: Prevents major version downgrades that break application runtime.
  - Global package installations (`npm i -g`, `pnpm add -g`, `yarn global add`): Directs agents to use project `devDependencies` or `npx`/`bunx`.
  - Direct agent publishing (`npm publish`, `pnpm publish`): Enforces automated CI/CD release pipelines.
  - `pip install --force-reinstall`: Enforces pinned requirements.

---

## Custom Tools

Besides enforcement hooks, the guard registers companion tools in OpenCode:

### `guard_worktree_create`
- Creates an isolated git worktree for concurrent subagent execution: `guard_worktree_create(branch, baseBranch?)`.
- Branch names are validated against git ref rules (control characters, shell metacharacters, `..`, leading `-`/`.` are rejected) and protected branches (`main`/`master`) are refused.
- Worktrees are stored outside the repository under `~/.local/share/opencode/worktrees/<repo-name>/` (override with `WORKFLOW_GUARD_WORKTREE_DIR`), and the parent's `node_modules` is symlinked into the new worktree so tooling works without a fresh install.
- If the branch already exists, the worktree is checked out on it; otherwise it is created from `baseBranch` (default `HEAD`).

### `guard_worktree_cleanup`
- Commits a final snapshot of any remaining changes (`chore(worktree): auto-snapshot before cleanup`) and then removes the worktree directory with `git worktree remove --force`, pruning stale worktree metadata if needed.

### Hook-Context Safety
- All spawned git commands run with a sanitized environment: inherited git context variables (`GIT_INDEX_FILE`, `GIT_DIR`, `GIT_WORK_TREE`, ...) are stripped so the tools resolve the repository from their working directory alone. This makes them safe to invoke from inside git hooks, which export those variables.

### Inspection Tools
- `guard_status`, `guard_audit`, `guard_why`, and `record_review` provide runtime introspection of guardrail state, audit entries, block explanations, and reviewer decisions.

---

## Overrides ("Unless Otherwise Specified")

The ONLY override is the **`WORKFLOW_GUARD_ALLOW_LIVE=1` environment variable**, which the **user** must set before launching the agent. It affects:
- Destructive CLI commands (Policy 4)
- MCP mutations (Policy 5)
- File payloads containing destructive commands (Policy 9)

Verification command selection uses **`WORKFLOW_GUARD_VERIFY`** (empty = auto-detect off, string = your command).

There is **deliberately no in-command override** (no `# allow-live` marker): an override the agent can append to its own command - or is told about in an error message - is an override the agent will use.

**Workflow & security gates (Policies 1, 2, 3, 6, 7, 8) have no override** - by design.

---

## Known Limits (Defense in Depth)

These guards match on command and file strings. An agent that base64-encodes a payload, invokes an interpreter directly (`python3 -c ...`), or uses exotic shell redirection can evade pattern matching. This plugin is a **deterrent against forgetful or complacent agents**, not a sandbox. Pair it with:
- GitHub branch protection/rulesets server-side
- OS-level workspace isolation (containers, read-only mounts)

for hard guarantees.
