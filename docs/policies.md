# Enforced Policies & Guardrails

`opencode-workflow-guard` enforces workflow discipline through **deterministic TypeScript hooks** (`tool.execute.before`, `experimental.session.compacting`, `shell.env`, `permission.ask`, and `event` journaling) - not prompt rules that LLMs can ignore.

---

## Policy Reference

### 1. Task Breakdown & Lifecycle (`todowrite`)
- **Pre-edit Gate:** All file-editing tools (`edit`, `write`, `apply_patch`) are blocked until the session has an active task list in OpenCode's native todo system (`todowrite`, persisted at `GET /session/:id/todo`).
- **Flexible Task Execution:** Tasks can be completed in any order as work concludes without artificial sequential blockers, maintaining maximum pair-programming DX.
- **No Silent Deletion:** Each `todowrite` update replaces the complete list. Active tasks must remain in subsequent updates until they are explicitly marked `completed` or `cancelled`.
- **No Silent Early Exit:** When an owning session becomes `session.idle` with unfinished native todos, the guard asynchronously asks OpenCode to continue. Automatic continuations are capped at three consecutive attempts and the budget resets on genuine user input. Use OpenCode's native `question` tool when user feedback or a decision is required; question and permission interactions wait inside the active run rather than producing an idle completion.
- **Subagent Inheritance & Role Confinement:** Subagents automatically inherit active tasks from their parent session via the `parentID` hierarchy. Subagents spawned with read-only roles (`reviewer`, `planner`, `advisor`, `critic`, `explorer`, `scout`, `evaluator`) are hard-confined: file mutations, lifecycle tools, and mutating shell commands are strictly blocked.
- **Handoff Safety:** An idle subagent whose effective todos are inherited from its parent is not auto-continued. Inherited work belongs to the parent and can be handed back normally.
- **Durable Next-Work Discovery:** `guard_next_tasks` prefers a repository-root `TODO.md`; when it is absent, it reads conventional `ROADMAP.md`, `PLAN.md`, `TASKS.md`, `BACKLOG.md`, their `docs/` counterparts, and Markdown files under `docs/plans/`. These files are planning context only and never replace OpenCode's native runtime todo state.
- **Subagent Mutation Budget:** Subagent sessions are protected by a mutation safety budget (`maxSubagentMutations` in project config or `WORKFLOW_GUARD_MAX_SUBAGENT_MUTATIONS` env, default 50) to terminate runaway edit loops deterministically.
- **Concurrent File Claims:** Direct `edit`, `write`, and `apply_patch` calls claim each canonical target for the tool-call lifetime. A different active session is blocked from racing the same file (including through symlink aliases); claims are released after the call, with session idle/deletion as stale-claim cleanup when an after hook is missed. Shell writers are not covered, and isolated worktrees remain preferred for substantial parallel mutations.
- **Stale-Write Protection:** A successful `read` records a same-session fingerprint for an existing regular file using its canonical path, filesystem identity, size, nanosecond mtime, and SHA-256 content digest. Before `edit` or `write` replaces an existing file, that fingerprint must exist and still match; otherwise the call is blocked and must re-read. New-file creation is allowed without a prior read. Fingerprints are not inherited between parent/subagent sessions and are cleared on session idle/deletion. `apply_patch` and shell writers are deliberately outside this bounded mechanism; the pre-execution comparison also cannot make external changes between the check and OpenCode's write atomic.

### 2. No Pushes to Protected Branches
- `git push ... main` and `git push ... master` are blocked in all shell commands, including direct refs, refspecs (`git push origin HEAD:main`, `git push origin feature/x:main`), deletion refspecs (`git push origin :main`), and forced refspecs (`git push origin +main`).
- Branches configured via `protectedBranches` in `.opencode/workflow-guard.json` receive the same destination-side push protection (`git push origin feature/x:release/prod` is blocked).
- Git global options (`-C`, `--git-dir`, `--work-tree`, `-c`) are parsed before matching, so `git -C /repo push origin main` is gated on `/repo`'s branch.
- Normal pushes and force-pushes to feature branches are allowed.

### 3. PR Changelog, Changesets & Lockfile Synchronization Requirement
- `gh pr create` and `az repos pr create` are blocked unless:
  - The branch diff modifies a `CHANGELOG` file, OR
  - The branch diff adds/modifies a `.changeset/*.md` fragment file (Changesets workflow), OR
  - The PR description (`--body`, `--description`, or `--body-file`/`-F`) contains a `Changelog:` section. Multiline Bash ANSI-C `\n`/`\r` quoting is supported for inline descriptions.
- **Lockfile Synchronization Gate:** Whenever package manifests (`package.json`, `Cargo.toml`, `go.mod`) are modified, PR creation is blocked until their corresponding lockfiles (`package-lock.json`/`bun.lock`/`pnpm-lock.yaml`/`yarn.lock`, `Cargo.lock`, `go.sum`) are updated.
- When multiple PR prerequisites fail at once, the guard reports all detected preflight failures together so they can be resolved before retrying PR creation.

### 4. Destructive CLI Operations Guard
- Blocks destructive filesystem, infrastructure, cloud, database, and git operations unless the **user** explicitly overrides via environment variable.
- **Blocked:**
  - Filesystem & Disks: `rm -rf`, `rm -r`, forced deletion of system/home paths, disk wipes (`mkfs`, `wipefs`, `parted`, `sfdisk`), raw block writes (`dd of=/dev/...`, `shred /dev/...`), recursive permission/ownership clobbering (`chmod -R ... /`, `chown -R ... ~`), reverse shells & raw sockets (`/dev/tcp/...`, `nc -e`, `socat exec:`)
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
  - Shell writes/redirects to `opencode.json[c]`, `~/.config/opencode/*`, `.opencode/*` (including the `.opencode` directory itself), or the guard's own plugin/TUI files (`~/.config/opencode/plugins/*`, `~/.config/opencode/ui/*`)
  - Direct edits of the same paths through the `edit`/`write`/`apply_patch` tools
  - Shell commands invoking `opencode auth`, `opencode config`, `opencode permission`, or `opencode run --auto`
  - Evasion-normalized: quote-concatenation (`open''code.json`), escapes (`open\c\ode`), and glob wildcards (`opencode.jso?`) are stripped before matching.
- **Read-only access is allowed** (`cat`, `less`, `grep`, `head`, `tail` on config files) - only modification attempts trigger the guard.

### 7. Feature-Branch Workflow
- When the workspace git repository is on `main` or `master`, all file mutations and history-changing git commands (`commit`, `merge`, `rebase`, `cherry-pick`, `revert`, `apply`, `am`, `reset`, `restore`, `stash pop`, `update-ref`, `filter-branch`, `branch -D/-M`) are blocked.
- Git global flags are parsed, so `git -C /repo commit` is gated on `/repo`'s branch, not the workspace's.
- The agent is prompted to create a feature branch first (`git switch -c feat/my-feature`).

### 8. Workspace Boundary Guard
- File modification tools (`edit`, `write`, `apply_patch`) and recognized shell mutations (redirection `>`, `>>`, `&>`, `>&`, `tee`, `sed -i`, `cp`/`mv`/`ln`, `touch`, `mkdir`, `rm`, `truncate`, `dd of=`, `git apply`/`git am`) are validated to ensure detected targets cannot escape the current workspace root via `../` traversal, symlinks, absolute paths, or shell expansions (`~`, `~user`, `$HOME`). Unresolvable `$VARIABLE` references fail closed. This is command-level enforcement, not filesystem sandboxing; arbitrary programs and dynamically computed paths require the OS isolation described under Known Limits.
- `tee` flag parsing generically skips option flags (`-a`, `--append`, `-ai`, `--`) and validates all specified target files against the boundary.
- `mv` sources are validated too: moving a file from outside the workspace (or a protected settings/plugin file to an innocuous name) is blocked, since `mv` mutates the source.
- External repository git writes (`git -C /other-repo commit`, `git --git-dir=/other-repo/.git push`, `GIT_DIR=/other-repo/.git git push`, `GIT_WORK_TREE=...`) are also confined to the workspace.
- The boundary has **no override**: `WORKFLOW_GUARD_ALLOW_LIVE=1` covers live-system commands only and never weakens the workspace confinement.

### 9. Script-Laundering Guard
- Content written via `edit`, `write`, or `apply_patch` is scanned for destructive CLI commands and settings tamper payloads.
- Prevents agents from bypassing shell guards by writing destructive commands to script files (e.g. `write deploy.sh` -> `bash deploy.sh`).

### 10. Evidence-Based Verification
- When the agent attempts to mark **every** task completed (finalizing the request), the guard requires passing verification evidence.
- Verification (`WORKFLOW_GUARD_VERIFY` env, project `verifyCommand`, or auto-detected test/typecheck runner across ecosystems: `package.json` (`npm test`, `npm run typecheck`, `npm run check`, `npm run build`), `Cargo.toml` (`cargo test`), `go.mod` (`go test ./...`), `pytest.ini`/`pyproject.toml` (`pytest`), or `deno.json` (`deno test`)) executes in an isolated environment with scrubbed credentials, output caps, token-efficient stdout/stderr snipping, and strict timeout protection. Environment configuration takes precedence over project configuration.
- Project `postEditValidators` can run faster targeted checks after a direct file edit actually changes the target. Each entry accepts a workspace-relative glob `pattern` (`*`, `**`, and `?` wildcards; brace expansion and character classes are not supported), a non-empty `command`, and an optional positive `timeoutMs`; invalid entries are reported as advisory feedback rather than silently ignored. Matching commands run from the workspace root with the same scrubbed verification environment. Validator failures and timeouts are appended to the edit result as advisory feedback and do not replace the blocking whole-project finalization verification. Multi-file `apply_patch` calls validate every changed target.
- With project `recoveryCheckpoints: true`, genuine root-session user runs capture a private Git checkpoint before agent work starts. Checkpoints preserve tracked and untracked state without using the user's stash list; subagents and generated continuation prompts do not replace them. At `session.idle`, the run's resulting workspace fingerprint is recorded before automatic continuation. `guard_recovery_restore` is provenance-bound to the same root session and refuses restoration after any intervening workspace change.
- **Git State & Snapshot Binding:** Verification evidence records the current git commit hash (`git rev-parse HEAD`) and working tree status. If unverified edits or index modifications occur after verification, fresh verification is enforced.
- **Durable Disk Cache:** Passing verification results are cached to `~/.local/state/opencode/workflow-guard/last-verify.json`, allowing session restarts and multi-agent handoffs to retain valid verification evidence without redundant test runs. Durable evidence is **workspace-bound**: a cached result is only accepted for the workspace that produced it, so a passing run in one project can never satisfy finalization in another.
- If verification fails, finalization is blocked with a structured summary of error markers, stack traces, and failure output.
- OpenCode's current `lsp.client.diagnostics` event identifies the server and path but does not expose the diagnostics themselves, so the guard deliberately does not claim an LSP-clean finalization gate until the SDK provides a supported diagnostics source.
- The verify command is **disabled** when `WORKFLOW_GUARD_VERIFY` is empty (`""`).

### 11. Secret-Content Scan
- File payloads and recognized shell file-mutation commands are scanned for common credential material (AWS keys, private key headers, GitHub tokens, OpenAI/LLM keys, Google API keys, Slack tokens, explicit env-style assignments).
- Flagged content is blocked before the write with an actionable message. Secret-file reads also resolve existing symlink aliases, and copying/moving/linking a known secret path under another name is blocked.

### 12. Shell Environment Scrub
- Sensitive environment variables (`AWS_*`, `KUBE*`, `OPENAI*`, `ANTHROPIC*`, `GOOGLE_/GCP_`, `AZURE_`, `SLACK_`, `NPM_`, `DOCKER_`, `KUBECONFIG`, and fixed names like `OPENAI_API_KEY`, `KUBECONFIG`, `NPM_TOKEN`) are **emptied** in agent shells by the `shell.env` hook. GitHub tokens (`GITHUB_TOKEN`, `GH_TOKEN`) are preserved so `gh` CLI and git operations function without recurring login prompts.
- This prevents the agent from carrying live credentials by default. The user can still grant access through OpenCode's own permission system if a task genuinely needs it.

### 13. Command-Channel Audit
- User-triggered slash commands (`command.executed` events) are journaled to the audit trail so agents cannot perform hidden work through a user-facing side channel.

### 14. Audit Trail & Permission Journaling
- Every block/allow decision is appended to `~/.local/state/opencode/workflow-guard/workflow-guard.jsonl` (XDG_STATE_HOME respected) with a timestamp, session id, tool name, decision, subagent/parent session attribution, and reason - a durable record.
- Permission prompts are journaled at request time via the typed `permission.ask` plugin hook, and `permission.replied` outcomes (including rejections) are preserved instead of being labeled as allows.
- `client.app.log()` complements the on-disk trail with in-app logs.

### 15. Compaction State & Focus Preservation
- Integrates with OpenCode's `experimental.session.compacting` hook to inject the full active operational state into `output.context` before context summarization:
  - Active `todowrite` tasks with status badges and subagent hierarchy attribution.
  - Active Git branch name and protected branch status.
  - Test verification status (passed/failed, test command, and commit hash).
  - Secondary review verdicts (reviewer name and approval status).
  - Uncommitted mutation counts.
- Ensures the model retains its operational context, security posture, and task roadmap across session compactions without hallucinations.

### 16. TUI Visual Feedback & Dynamic Last-Block Status
- Emits real-time warning toasts to the user interface via `tui.showToast` whenever a guard policy blocks a tool call.
- The companion TUI plugin (`workflow-guard-ui.ts`) dynamically reflects the latest guard state in the prompt bar, displaying `Workflow Guard 🛡️` during normal operation and `[Workflow Guard: Blocked: <reason>]` when an action is intercepted. Blocked state is scoped to the session that triggered it and sourced only from guard-originated toasts.

### 17. Secret-File READ Block & Safe Schema Masking
- Blocks reading sensitive credential files (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `*kubeconfig*`, `*credentials*.json`, `service-account*.json`) through the `read` tool, shell commands (`cat`, `less`, `more`, `grep`, `awk`, `head`, `tail`, `base64`), or inline interpreter payloads (`python3 -c "open('.env')"`, `bash -c 'cat id_rsa'`).
- **Safe Schema Masking:** On `.env*` reads via the `read` tool, the guard parses the variable names and comments, and returns a safe redacted schema mask with secret values masked as `********`, enabling agents to inspect variable existence without leaking secrets into model context.
- Standard non-secret fixtures (`.env.example`, `.env.sample`, `.env.template`) remain readable.

### 18. Interpreter Inline Evasion Scanner
- Decodes and inspects inline interpreter payloads (`python -c`, `node -e`, `perl -e`, `ruby -e`, `osascript -e`, `bash -c`, `sh -c`, `zsh -c`, `powershell -enc`, `echo <base64> | base64 -d | sh`) to prevent smuggling live destructive commands, settings tampering, secret reads, or out-of-workspace writes past shell pattern checks.

### 19. Conflict-Free Pre-Flight Guard
- Evaluates `git merge-tree` against the base branch (`origin/main`, `origin/master`, `main`) before PR creation or final task handoff, ensuring changes can be merged cleanly without conflicts.

### 20. Merged Branch & Base Freshness Guard
- Blocks pushing to branches already merged or associated with closed PRs in GitHub or Azure DevOps.
- Blocks creating fresh feature branches when the local base branch is behind the remote, prompting the agent to pull latest changes first.

### 21. Documentation Review & Synchronization Guard
- Ensures that relevant documentation is updated whenever changes introduce new features, policies, or public tools before PR creation. Configurable via `.opencode/workflow-guard.json` (`requireDocumentation: true`) or `WORKFLOW_GUARD_REQUIRE_DOCS=1`.
- Only **README.md** (root or package level) and files under **`docs/`** count as documentation updates; arbitrary markdown (e.g. `.changeset/*.md` fragments or `CHANGELOG.md`) does not satisfy this gate.

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

### 24. Completion Claims vs Evidence (Observability)
- When the assistant's final response text asserts completion or passing verification ("all tests pass", "work is done", "verified"), the guard compares the claim against recorded verification evidence for that session.
- Mismatches (failing verification, stale evidence due to mutations after the verify run, or no evidence at all) are journaled to the audit trail and logged at info level. This is **observability, not gating**: the response is never blocked, but a confident wrap-up cannot silently contradict a failing or absent verification state.
- Uses the `experimental.text.complete` hook; claim detection is a conservative phrase heuristic to avoid false positives on casual wording.

### Tool Description Honesty
- Via the `tool.definition` hook, the guard enriches the `todowrite` tool's description with its replacement-list lifecycle and finalization gates (including verification evidence required after the last mutation), so the model is not surprised by preventable lifecycle blocks. Other tools are untouched, and the enrichment is idempotent.

---

## Custom Tools

Besides enforcement hooks, the guard registers companion tools in OpenCode:

### `guard_worktree_create`
- Creates an isolated git worktree for concurrent subagent execution: `guard_worktree_create(branch, baseBranch?)`.
- Branch names are validated with `git check-ref-format --branch`; protected branches (the built-in `main`/`master` plus any configured via `protectedBranches` in `.opencode/workflow-guard.json`) are refused.
- Worktrees are stored outside the repository under `~/.local/share/opencode/worktrees/<repo-name>/` (override with `WORKFLOW_GUARD_WORKTREE_DIR`), and the parent's `node_modules` is symlinked into the new worktree so tooling works without a fresh install.
- If the branch already exists (as a local branch), the worktree is checked out on it; otherwise it is created from `baseBranch` (default `HEAD`).
- Subject to the same todo gate as other mutations, and successful worktree mutations invalidate stale verification/review evidence.

### `guard_worktree_cleanup`
- Commits a final snapshot of any remaining changes (`chore(worktree): auto-snapshot before cleanup`, excluding the plugin-created `node_modules` symlink) and then removes the worktree directory with `git worktree remove --force`.
- **Ownership validation:** only registered worktrees of the current repository under the configured worktree storage directory can be cleaned up; arbitrary directories, other repositories' worktrees, and the primary working tree are refused. A failed `git worktree remove` is an error, never a fallback to raw directory deletion.
- **Lossless by construction:** if the snapshot commit cannot be established (failing hook, missing identity, lock error), cleanup aborts and the worktree is left fully intact.

### Hook-Context Safety
- All spawned git commands run with a sanitized environment: inherited git context variables (`GIT_INDEX_FILE`, `GIT_DIR`, `GIT_WORK_TREE`, ...) are stripped so the tools resolve the repository from their working directory alone. This makes them safe to invoke from inside git hooks, which export those variables.

### Inspection Tools
- `guard_status`, `guard_audit`, `guard_why`, `guard_review_rubric`, `record_review`, `guard_review_followups`, and `guard_review_followup_resolve` provide runtime introspection of guardrail state, audit entries, block explanations, reviewer rubric definitions, reviewer decisions, and durable local review debt.
- **Priority-Ranked Review Gate:** `guard_review_rubric` includes P0-P3 severity tiers. When recording reviews via `record_review`, approvals that include active P0 (blocker) or P1 (major defect) issues are rejected until blockers are resolved.
- **Durable Lower-Priority Follow-ups:** Accepted review summaries containing a P2 or P3 finding are persisted in the project's local Workflow Guard SQLite database. Open findings are included in compacted agent context and remain open across sessions until explicitly resolved with `guard_review_followup_resolve`; they are not silently discarded with the review session.
- **Privacy-Safe Local Telemetry:** Guard decisions remain in the local audit JSONL. Tool after-hook observations add `callID` and duration records for local diagnosis and performance analysis; the current hook API does not distinguish success from every failure path, so these records do not claim a success outcome. Command and patch bodies are never written to the journal; only their byte count and SHA-256 fingerprint are retained for correlation.

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

These guards match on command strings, file structures, and interpreter payloads (including base64 pipeline decoding and inline eval scans under Policy 18). While inline scripts are decoded and analyzed, compiled binaries or multi-stage external downloads require OS-level sandboxing. This plugin is a **hardened deterrent against forgetful, complacent, or prompt-injected agents**, not an OS kernel sandbox. Pair it with:
- GitHub branch protection/rulesets server-side
- OS-level workspace isolation (containers, read-only mounts)

for hard guarantees.
