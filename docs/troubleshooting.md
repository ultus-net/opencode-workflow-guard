# Troubleshooting Guide

Common issues, root causes, and solutions when using `opencode-workflow-guard`.

---

### 1. `plugin config hook failed` / `Unexpected server error` on startup

- **Symptoms:** OpenCode crashes or reports `Unexpected server error` when starting a session, with logs showing `TypeError: undefined is not an object (evaluating '...event')`.
- **Root Cause:** OpenCode 1.18+'s legacy loader treats *every exported function* in a plugin module as a separate plugin instance. If a plugin exports helper functions (like `guardToolCall` or `setWorkspaceRoot`) alongside a default function, OpenCode calls them as plugins, pushes `undefined` into the hook registry, and crashes event dispatch on `session.created`.
- **Solution:** Ensure `src/workflow-guard.ts` uses the V1 `PluginModule` export format (`export default { id: "workflow-guard", server: WorkflowGuard } satisfies PluginModule`). File plugins require an explicit `id` string.

---

### 2. Edits Blocked: `Blocked: no active todo item`

- **Symptoms:** The agent attempts an edit (`edit`, `write`, `apply_patch`) and receives a block message directing it to create a task list.
- **Root Cause:** Policy 1 blocks file-editing tools while the session's **effective** todo list is known and contains no task with status `pending` or `in_progress`. On OpenCode 1.x that list is the native todo state (`GET /session/:id/todo`). On OpenCode 2.x there is no todo endpoint and no builtin `todowrite`, so the list is reconstructed from the newest applied `todowrite` tool call in the session history (some ACP agents supply that tool). A list is only treated as empty when a `todowrite` part actually exists; when the session has no `todowrite` capability at all, the gate fails open rather than blocking every edit forever.
- **Solution:** The agent must call `todowrite` first. Once all tasks are marked `completed` or `cancelled`, edits will block again until a new breakdown is created for subsequent work. If an agent on OpenCode 2.x is blocked here despite having no todo tool available, that is a bug - report it rather than working around it through shell writes.

---

### 3. Multiple tasks are `in_progress`

- **Symptoms:** A task list contains multiple `in_progress` items during parallel work.
- **Root Cause:** This is supported. Policy 1 permits multiple tasks to be `in_progress` so independent work and subagents can proceed concurrently.
- **Solution:** No correction is required. Keep each active item in every replacement list until it is explicitly marked `completed` or `cancelled`.

---

### 4. `Blocked todowrite: active task '...' was removed`

- **Symptoms:** `todowrite` is blocked after an active item disappears from the submitted list.
- **Root Cause:** Each `todowrite` call replaces the complete list. Policy 1 therefore requires active tasks to be explicitly completed or cancelled rather than silently omitted. Independent items may otherwise be completed out of order.
- **Solution:** Keep the task in the list and mark it `completed` or `cancelled` before removing it in a later request.

---

### 5. Edits Blocked: `Blocked: the workspace is on a protected branch (main/master)`

- **Symptoms:** Direct edits or git commit/merge commands are rejected.
- **Root Cause:** Policy 7 requires all code modifications to happen on a feature branch.
- **Solution:** Switch to a feature branch (`git switch -c feat/my-feature`) before making changes.

---

### 6. Edits Blocked: `Blocked: file path '...' escapes workspace root`

- **Symptoms:** Edits targeting files with `../` or external absolute paths are rejected.
- **Root Cause:** Policy 8 prevents directory traversal outside the workspace root.
- **Solution:** Ensure all target file paths resolve within the project directory.

---

### 7. Subagents Cannot Edit Files

- **Symptoms:** A subagent spawned via `task` fails to edit files.
- **Root Cause:** OpenCode disables `todowrite` for subagents by default.
- **Solution:** The guard automatically walks up the `parentID` session hierarchy so subagents inherit the parent session's active tasks. Ensure the parent session has active tasks before a subagent attempts guarded mutations.

---

### 8. Destructive Commands Blocked (`kubectl`, `terraform`, `psql`, etc.)

- **Symptoms:** A CLI command is rejected with a live-system mutation warning.
- **Root Cause:** Policy 4 blocks destructive cloud, database, and infrastructure operations.
- **Solution:** To intentionally run a live command, set `WORKFLOW_GUARD_ALLOW_LIVE=1` in the environment before launching OpenCode. There is no in-command override; an agent cannot grant this permission to itself.

---

### 9. TUI plugin is missing or remains on an older release

- **Symptoms:** Workflow Guard does not appear in the TUI, or npm reports a newer Workflow Guard release while OpenCode still runs an older one.
- **Root Cause:** OpenCode caches npm plugins. A bare package name is resolved as `@latest`, but an already-populated package cache can continue using the version that originally populated that cache key. Running `npm update` in `~/.config/opencode` does not update this OpenCode-managed plugin installation.
- **Solution:** Use OpenCode's documented plugin installer with the explicit version you want. `--force` replaces the configured plugin version, and the explicit version gives OpenCode a new package-cache key:

```bash
VERSION=$(npm view opencode-workflow-guard version)
opencode plugin "opencode-workflow-guard@$VERSION" --global --force
```

OpenCode documents `opencode plugin <module>` as installing a plugin and updating its config, with `--global` for global config and `--force` to replace an existing plugin version: https://opencode.ai/docs/cli/#plugin. Its plugin documentation also describes npm plugins as OpenCode-managed, cached installations: https://opencode.ai/docs/plugins/#how-plugins-are-installed.

After the command reports `Detected server + tui targets`, confirm it reports replacements/additions for both the OpenCode and TUI config files, then restart OpenCode. Manual cache deletion should not be necessary.

---

### 10. TUI companion crashes with `Keymap.Provider is missing` (OpenCode V2)

- **Symptoms:** On opencode v2, the TUI companion plugin fails during setup with `Keymap.Provider is missing` and does not load.
- **Root Cause:** `ctx.keymap.layer` resolves a Solid context (`useContext(KeymapContext)`) and only works inside the TUI's `Keymap.Provider` render tree; the API documents layers as "owned by the calling component". Plugin `setup()` runs as a plain async call outside that tree, so registering a layer there always throws.
- **Solution:** Fixed in 1.13.2: the layer is registered from an `app`-slot claim (`ctx.ui.slot({ append: "app", render: () => { ...; return null } })`). Slot renders execute in a reactive scope under the provider, and the same session-panel pattern applies to any plugin API that requires component ownership. If you maintain a TUI plugin that registers keymap layers, commands, or reactive state, register them from a slot render (or a rendered component), never from `setup()`.

---

### 11. Reading tool parts from V2 sessions (integrators)

- **Symptoms:** Code that parses recorded tool calls (message parts, the `part` DB table, or `session.message.content.updated` events) finds no tool name on OpenCode V2, or sees tool names that do not exist in OpenCode's builtin tool list.
- **Root Cause:** Two independent things:
  1. V2 message parts record the tool name in the `tool` field; V1 used `name`. Code reading `part.name` silently gets `undefined` on V2.
  2. V2's builtin tool registry contains only `read`, `glob`, `grep`, `edit`, `write`, `patch`, `shell`, `webfetch`, `websearch`, `question`, `skill`, `subagent`, and `execute`. There is no builtin `todowrite` (the V1 name), and the V1 `task` subagent tool was renamed to `subagent`. `todowrite`/`bash` tool parts observed in V2 sessions come from ACP agents (for example pi) that supply their own tools; those tools are not in the server-side registry and cannot be reached by `ctx.tool.transform`.
- **Solution:** Read the tool name as `part.tool ?? part.name` and treat tool-part names as agent-reported, not as the builtin registry. `ToolEditor.update` ignores missing IDs, so enriching a tool that does not exist is a harmless no-op.

---

### 12. Review recorded with `record_review`, but `pr create` is still blocked

- **Symptoms:** `record_review` returned "Review recorded as APPROVED" and `guard_status` showed a fresh `lastReview`, yet `gh pr create` / `az repos pr create` was blocked with "Passing secondary review approval is required"; or re-calling `record_review` returned success but `guard_status` still showed no fresh review.
- **Root Cause (fixed by content binding):** The PR preflight previously also required the review's target session to equal the PR-creating session's ID. `record_review` records from a secondary session (binding the verdict to its parent or its own directory), sessions can move between directories mid-flight (`session_move`), and subagents spawn from other roots — so a review recorded against a linked git worktree could never satisfy a PR created from another session there. Mutation invalidation additionally erased the whole review record on any mutation, including unrelated untracked-file cleanup.
- **Binding rule:** a recorded approval satisfies the preflight when its binding matches the tree the PR publishes — same repository, same commit hash, same tracked-content worktree fingerprint. Review freshness is scoped to tracked content, so deleting an untracked scratch file does not invalidate it; a tracked edit or new commit does. When the tracked fingerprint is unchanged but HEAD moved (for example a review recorded with changes already staged, then committed), the preflight names the commit drift specifically.
- **Diagnosis:** `guard_audit` now records the binding key (workspace, commit hash, fingerprint prefix, recorder session and `recorderRole`) on every `record_review.verdict` entry, and a `pr-preflight.review-binding` entry when a PR preflight accepts a review. If a verdict cannot bind at all (directory is not a git repository), `record_review` rejects loudly with the reason instead of returning a success string.
- **Strict recorder mode rejects the approval:** projects with `requireSubagentReview: true` (or `WORKFLOW_GUARD_REQUIRE_SUBAGENT_REVIEW=1`) reject `record_review` approval verdicts recorded by the root session with "this project requires approvals to be recorded from a subagent session". Record the verdict from a subagent session instead (one with a parent session), or disable the requirement in project config; the `guard_audit` entry carries reason `subagent_recorder_required`. Changes-requested verdicts remain relayable from any session. The knob is enforced when verdicts are recorded: an approval recorded by the root session before the requirement was enabled — including durable review-cache evidence recovered after a restart — still satisfies the PR preflight until its content binding goes stale, so re-run the secondary review after adopting the knob to re-bind it.
- **Worktree creation failure leaving a branch behind:** `guard_worktree_create` failures previously surfaced only git's stderr (often checkout progress) and could leave a half-created branch. Failures are now reported with git's exit status, the created branch is rolled back (pre-existing branches are preserved), and stale worktree admin entries are pruned only for the newly-created path. A live registered worktree whose sanitized name collides with the requested branch is left fully intact — rollback never removes pre-existing worktrees. Large checkouts that exceed the 15s timeout can set `WORKFLOW_GUARD_WORKTREE_TIMEOUT_MS`.
- **Edit blocked by "claimed by another active session" though no other session is working:** a missed `session.idle` release can leave a finished session's direct-edit claim behind, and claims have no expiry, so every other session is blocked from that path until the owning session is deleted or the service restarts. On a real (non-simulated) call the takeover now resolves it: a claim created before its owner's last recorded idle timestamp is provably stale and is released, with `guard_audit` recording a `file-claims` entry with reason `stale_claim_takeover`. Sessions still mid-turn (no idle timestamp) keep their claim, and the takeover fails closed without an SDK session lookup or when the lookup fails. `guard_why` remains read-only and still reports the conflict.
- **You updated the plugin but the old version still loads:** a configured bare package name is resolved through Node's parent-directory lookup from OpenCode's configuration location, so a copy in any parent `node_modules` (a pnpm-managed home directory or a manual install) shadows OpenCode's own plugin cache and a global `npm install -g`; OpenCode's own update check can fail with only a server-log record (`NpmInstallFailedError`). Verify what actually loaded with `guard_status` (the `pluginVersion` field), the startup app-log line (`Workflow Guard v<version> plugin initialized ...`), or the server log's `loading plugin ... entrypoint=file:///...` record. Then update the resolved copy in place (for a pnpm-managed home directory: `cd ~ && pnpm add opencode-workflow-guard@<version>`) and run `opencode service restart` — the plugin loads in the background service, so restarting only the TUI does not reload it.
- **A benign-looking command with a shell variable is blocked as "outside the workspace":** a mutation or redirect target containing an unresolvable `$VARIABLE` reference (for example `mkdir -p $D/sub`, `cp a.txt "$D/b.txt"`, `> $CACHE/out.txt`) is indeterminate without executing shell semantics, and the boundary fails closed on indeterminate destinations — the block message names this cause ("contains an unresolvable variable reference … use a literal workspace-relative path"). Deterministically expandable forms (`~`, `$HOME`) and literal paths inside the workspace are unaffected, and reads (including cache-path reads) are not gated. Replace the variable with a literal workspace-relative path in the command, or assign it inside a script file within the workspace that the boundary has already validated. Resolving the variable would require executing shell semantics, which the boundary deliberately does not do (see the shell-expansion hardening notes in the roadmap).
