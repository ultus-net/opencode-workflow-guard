# Troubleshooting Guide

Common issues, root causes, and solutions when using `opencode-workflow-guard`.

---

### 1. `plugin config hook failed` / `Unexpected server error` on startup

- **Symptoms:** OpenCode crashes or reports `Unexpected server error` when starting a session, with logs showing `TypeError: undefined is not an object (evaluating '...event')`.
- **Root Cause:** OpenCode 1.18+'s legacy loader treats *every exported function* in a plugin module as a separate plugin instance. A plugin that exports helper functions (like `guardToolCall` or `setWorkspaceRoot`) alongside a default function therefore registers those helpers as plugins too. OpenCode calls them as plugins, pushes `undefined` into the hook registry, and crashes event dispatch on `session.created`.
- **Solution:** Ensure `src/workflow-guard.ts` uses the V1 `PluginModule` export format (`export default { id: "workflow-guard", server: WorkflowGuard } satisfies PluginModule`). File plugins require an explicit `id` string.

---

### 2. Edits Blocked: `Blocked: no active todo item`

- **Symptoms:** The agent attempts an edit (`edit`, `write`, `apply_patch`) and receives a block message directing it to create a task list.
- **Root Cause:** Policy 1 blocks file-editing tools while the session's **effective** todo list is known and contains no task with status `pending` or `in_progress`. On OpenCode 1.x that list is the native todo state (`GET /session/:id/todo`). Before 2.1.0, OpenCode 2.x has no todo endpoint and no builtin `todowrite`. The list is then reconstructed from the newest applied `todowrite` tool call in the session history, which some ACP agents supply. A list counts as empty only when a `todowrite` part actually exists. When the session has no `todowrite` capability at all, the gate fails open rather than blocking every edit forever.
- **Solution:** The agent must call `todowrite` first. Once all tasks are marked `completed` or `cancelled`, edits block again until a new breakdown is created for subsequent work. If an agent on OpenCode 2.x is blocked here despite having no todo tool available, that is a bug. Report it rather than working around it through shell writes.

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
- **Solution:** To intentionally run a live command, set `WORKFLOW_GUARD_ALLOW_LIVE=1` in the environment before launching OpenCode. There is no in-command override. An agent cannot grant this permission to itself.

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
- **Root Cause:** `ctx.keymap.layer` resolves a Solid context (`useContext(KeymapContext)`), so it only works inside the TUI's `Keymap.Provider` render tree. The API documents layers as "owned by the calling component". Plugin `setup()` runs as a plain async call outside that tree, so registering a layer there always throws.
- **Solution:** Fixed in 1.13.2. The layer is registered from an `app`-slot claim (`ctx.ui.slot({ append: "app", render: () => { ...; return null } })`). Slot renders execute in a reactive scope under the provider, and the same session-panel pattern applies to any plugin API that requires component ownership. If you maintain a TUI plugin that registers keymap layers, commands, or reactive state, register them from a slot render or a rendered component. Never register them from `setup()`.

---

### 11. Reading tool parts from V2 sessions (integrators)

- **Symptoms:** Code that parses recorded tool calls finds no tool name on OpenCode V2. It may also see tool names that do not exist in OpenCode's builtin tool list. The affected sources are message parts, the `part` DB table, and `session.message.content.updated` events.
- **Root Cause:** Two independent things:
  1. V2 message parts record the tool name in the `tool` field, where V1 used `name`. Code reading `part.name` silently gets `undefined` on V2.
  2. V2's builtin tool registry contains only `read`, `glob`, `grep`, `edit`, `write`, `patch`, `shell`, `webfetch`, `websearch`, `question`, `skill`, `subagent`, and `execute`. There is no builtin `todowrite`, which is the V1 name, and the V1 `task` subagent tool was renamed to `subagent`. `todowrite` and `bash` tool parts observed in V2 sessions come from ACP agents, for example pi, that supply their own tools. Those tools are not in the server-side registry and cannot be reached by `ctx.tool.transform`.
- **Solution:** Read the tool name as `part.tool ?? part.name` and treat tool-part names as agent-reported, not as the builtin registry. `ToolEditor.update` ignores missing IDs, so enriching a tool that does not exist is a harmless no-op.

---

### 12. Review recorded with `record_review`, but `pr create` is still blocked

- **Symptoms:** `record_review` returned "Review recorded as APPROVED" and `guard_status` showed a fresh `lastReview`, yet `pr create` was blocked with "Passing secondary review approval is required". A re-call of `record_review` may return success while `guard_status` still shows no fresh review.
- **Root Cause (fixed by content binding):** The PR preflight previously also required the review's target session to equal the PR-creating session's ID. `record_review` records from a secondary session, binding the verdict to its parent or its own directory. Sessions can move between directories mid-flight (`session_move`), and subagents spawn from other roots. A review recorded against a linked git worktree could therefore never satisfy a PR created from another session there. Mutation invalidation also erased the whole review record on any mutation, including unrelated untracked-file cleanup.
- **Binding rule:** A recorded approval satisfies the preflight when its binding matches the tree the PR publishes. The binding covers the repository, the commit hash, and the tracked-content worktree fingerprint. Review freshness is scoped to tracked content. Deleting an untracked scratch file does not invalidate it, and a tracked edit or new commit does. When the tracked fingerprint is unchanged but HEAD moved, the preflight names the commit drift specifically. That case arises when a review is recorded with changes already staged and then committed. The remedy is the same either way: record the review at the commit that will ship.
- **Commit before you review:** both evidence gates bind to the HEAD commit hash, so a commit after verification or after the review invalidates that evidence. Finish every tracked change first, then verify, then record the review, then open the PR. Any other order costs a re-run.
- **Diagnosis:** `guard_audit` records the binding key on every `record_review.verdict` entry. The key covers workspace, commit hash, fingerprint prefix, recorder session, and `recorderRole`. It also records a `pr-preflight.review-binding` entry when a PR preflight accepts a review. A verdict that cannot bind at all is rejected loudly with the reason instead of returning a success string. That case is a directory that is not a git repository.
- **Strict recorder mode rejects the approval:** Projects with `requireSubagentReview: true` (or `WORKFLOW_GUARD_REQUIRE_SUBAGENT_REVIEW=1`) reject `record_review` approval verdicts recorded by the root session. The message reads "this project requires approvals to be recorded from a subagent session", and the `guard_audit` entry carries reason `subagent_recorder_required`. Record the verdict from a subagent session (one with a parent session) instead, or disable the requirement in project config. Changes-requested verdicts remain relayable from any session. The knob is enforced when verdicts are recorded. An approval recorded by the root session before the requirement was enabled still satisfies the PR preflight until its content binding goes stale. That includes durable review-cache evidence recovered after a restart. Re-run the secondary review after adopting the knob to re-bind it.
- **Worktree creation failure leaving a branch behind:** `guard_worktree_create` failures previously surfaced only git's stderr. That output is often just checkout progress, and the failure could leave a half-created branch. Failures now report git's exit status, and the created branch is rolled back. Pre-existing branches are preserved. Stale worktree admin entries are pruned only for the newly-created path. A live registered worktree whose sanitized name collides with the requested branch is left fully intact, because rollback never removes pre-existing worktrees. Large checkouts that exceed the 15s timeout can raise it with `WORKFLOW_GUARD_WORKTREE_TIMEOUT_MS`.
- **Edit blocked by "claimed by another active session" though no other session is working:** A missed `session.idle` release can leave a finished session's direct-edit claim behind. Claims have no expiry. Every other session is blocked from that path until the owning session is deleted or the service restarts. On a real (non-simulated) call the takeover resolves it. A claim created before its owner's last recorded idle timestamp is provably stale and is released. `guard_audit` records a `file-claims` entry with reason `stale_claim_takeover`. Sessions still mid-turn (no idle timestamp) keep their claim. The takeover fails closed without an SDK session lookup, and when the lookup fails. `guard_why` remains read-only and still reports the conflict.
- **You updated the plugin but the old version still loads:** A configured bare package name is resolved through Node's parent-directory lookup from OpenCode's configuration location. A copy in any parent `node_modules` (a pnpm-managed home directory or a manual install) shadows OpenCode's own plugin cache and a global `npm install -g`. OpenCode's own update check can then fail with only a server-log record (`NpmInstallFailedError`). Verify what actually loaded with `guard_status` (the `pluginVersion` field), the startup app-log line (`Workflow Guard v<version> plugin initialized ...`), or the server log's `loading plugin ... entrypoint=file:///...` record. Then update the resolved copy in place (for a pnpm-managed home directory: `cd ~ && pnpm add opencode-workflow-guard@<version>`). Run `opencode service restart`, because the plugin loads in the background service and restarting only the TUI does not reload it.
- **A benign-looking command with a shell variable is blocked as "outside the workspace":** A mutation or redirect target that contains an unresolvable `$VARIABLE` reference is indeterminate without executing shell semantics. Examples are `mkdir -p $D/sub`, `cp a.txt "$D/b.txt"`, and `> $CACHE/out.txt`. The boundary fails closed on indeterminate destinations. The block message names this cause: "contains an unresolvable variable reference … use a literal workspace-relative path". Deterministically expandable forms (`~`, `$HOME`) and literal paths inside the workspace are unaffected. Reads, including cache-path reads, are not gated. Replace the variable with a literal workspace-relative path in the command. Alternatively, assign it inside a script file within the workspace that the boundary has already validated. Resolving the variable would need shell execution, which the boundary deliberately avoids.
- **A scratch write to `/tmp/opencode` is blocked:** The environment designates that directory as agent scratch space. The workspace boundary is workspace-absolute, though, and does not cover it. Writes there stay blocked, and the block message names both the directory and the remedy. Write scratch as an untracked file inside the workspace instead, for example `.tmp-notes.md`. The boundary has no override for it, and this attribution does not change the enforcement decision.
