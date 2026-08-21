# opencode-workflow-guard

A plugin for [OpenCode](https://opencode.ai) that enforces workflow discipline through **deterministic hooks** — not prompt rules that models can ignore.

Ported from [cline-workflow-guard](https://github.com/ultus-net/cline-workflow-guard), with one deliberate divergence: where the Cline version gates on markdown task files (`TASKS.md` & co.), this port gates on **opencode's native todo system** — the `todowrite` tool, whose list is persisted per session (`GET /session/:id/todo`) and read through the SDK client the plugin receives. All policies run in the `tool.execute.before` plugin hook ([docs](https://opencode.ai/docs/plugins/)) and **block a tool call by throwing**, which denies execution outright.

**Requires opencode >= 1.18.** Tool args are read from the hook's second parameter (`output.args`), the task gate uses the session todo endpoint (`GET /session/:id/todo`, available since 1.18), and the default export uses the V1 `PluginModule` shape (`{ id, server }`) — a bare-function default export alongside the named test exports would make the plugin loader treat every export as a plugin and crash the session.

## What it enforces

| # | Policy | Enforcement |
|---|--------|-------------|
| 1 | **Task breakdown & lifecycle** | Edit tools (`edit`, `write`, `apply_patch`) are blocked until the session's **native todo list** (the built-in [`todowrite` tool](https://opencode.ai/docs/tools/#todowrite)) has at least one active item (`pending`/`in_progress`). When updating todos: <br>• **Focus Rule:** Max one task may be `in_progress` at a time.<br>• **Sequential Order:** Cannot mark task $N$ `completed` while an earlier task is still `pending`/`in_progress`.<br>• **No Silent Deletion:** Active tasks cannot be deleted without being marked `completed` or `cancelled`.<br>• Subagents inherit their parent session's todo list. |
| 2 | **No pushes to main** | `git push … main/master` is blocked in any shell command. Feature branches are unaffected. |
| 3 | **PR changelog** | `gh pr create` is blocked unless the PR body contains a `Changelog:` section or the branch diff modifies a CHANGELOG file. |
| 4 | **Destructive-command guard** | Blocks only *destructive* CLI operations — non-destructive mutations (`kubectl apply`, `terraform apply`, `helm upgrade`, `az … create/update`, DB inserts, `curl` POST/PUT/PATCH, `ssh`) are allowed. Blocked: `kubectl delete/drain`, `helm uninstall/rollback`, `terraform/tofu destroy`, `pulumi destroy`, `az`/`aws`/`gcloud` delete/terminate/purge, DB `drop/delete/truncate/flushall`, remote `curl` DELETE (localhost exempt), and `git push --force`. |
| 5 | **MCP mutation guard** | MCP tools bypass the shell, so they're matched by name: GitHub and Azure/azmcp MCP tools with mutation verbs (`_create`, `_update`, `_delete`, `_merge`, …) are blocked; read-only tools (`_get`, `_list`, `_search`, …) pass. |
| 6 | **Settings tamper guard** | Blocks the agent from weakening its own gates: edits to `opencode.json` / `~/.config/opencode/*`, and `opencode auth|config|permission` or `--auto` invocations. Permissions can only be changed manually by the user. |
| 7 | **Feature-branch workflow** | When the repo is on `main`/`master`, edit tools and history-changing git commands (`commit`, `merge`, `rebase`, `cherry-pick`, `revert`, `apply`, `am`, `reset`, `restore`, `stash pop`) are blocked with a prompt to create a feature branch first. Read-only commands, branch creation, non-git workspaces, and `todowrite` are unaffected. |
| 8 | **Workspace boundary guard** | Blocks file edit tools (`edit`, `write`, `apply_patch`) from escaping the workspace root or git worktree via `../` path traversal. |
| 9 | **Compaction focus preservation** | Hooks into `experimental.session.compacting` ([docs](https://opencode.ai/docs/plugins/#compaction-hooks)) to inject the active sequential todo list into compaction context so the model retains strict focus across long sessions. |
| 10 | **TUI visual feedback** | Emits a warning toast via `tui.showToast` ([docs](https://opencode.ai/docs/server/#tui)) whenever a tool call is blocked by a guard policy. |

## Overrides

Hooks can't read chat intent, so overrides are explicit and auditable:

- **Destructive commands:** append `# allow-live` to the command, or set `WORKFLOW_GUARD_ALLOW_LIVE=1`.
- **MCP mutations:** only `WORKFLOW_GUARD_ALLOW_LIVE=1` (MCP calls carry no command string).
- **Everything else:** no override — by design.

## Install

OpenCode auto-loads plugins from these directories at startup:

### Option A: Project-level (per repo)
```bash
mkdir -p .opencode/plugins
cp workflow-guard.ts .opencode/plugins/
```

### Option B: Global (all projects)
```bash
mkdir -p ~/.config/opencode/plugins
cp workflow-guard.ts ~/.config/opencode/plugins/
```

### Option C: Via config (if published / path reference)
In `opencode.json` (or `~/.config/opencode/opencode.json`):
```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-workflow-guard"]
}
```

## Recommended companion config

Pair with OpenCode's native permission config in `opencode.json` for defense in depth (see https://opencode.ai/docs/permissions/):

```json
{
  "permission": {
    "edit": "allow",
    "bash": {
      "git push *main*": "deny",
      "git push *master*": "deny",
      "opencode auth*": "deny"
    }
  }
}
```

## Test

Run the full test suite and TypeScript typecheck locally:

```bash
npm test        # Runs node test.mts (Node >= 22.18); or `bun test.mts`
npm run typecheck # Strict TypeScript check via tsc
```

## Troubleshooting

### 1. `plugin config hook failed` / `Unexpected server error` on startup
- **Cause:** OpenCode >= 1.18's legacy loader treats *every exported function* in a plugin module as a distinct plugin instance. If a plugin exports helper functions (like `guardToolCall` or `setWorkspaceRoot`) alongside a default function, OpenCode calls them as plugins, pushes `undefined` into the hook registry, and crashes event dispatch on `session.created` with `undefined is not an object (evaluating '...event')`.
- **Fix:** Ensure `workflow-guard.ts` uses the V1 `PluginModule` export format (`export default { id: "workflow-guard", server: WorkflowGuard } satisfies PluginModule`). File plugins require an explicit `id` string.

### 2. Edits blocked: `Blocked: no active todo item`
- **Cause:** Policy 1 blocks file-editing tools (`edit`, `write`, `apply_patch`) until the session's native todo list contains at least one task with status `pending` or `in_progress`.
- **Fix:** The agent must call the `todowrite` tool first to break down the task. Once all tasks are marked `completed`, edits will block again until a new list is created for the next request.

### 3. Edits blocked: `Blocked todowrite: only one task may be 'in_progress'`
- **Cause:** Policy 1's focus rule enforces that only one task can be actively `in_progress` at any given time.
- **Fix:** Keep one task `in_progress` and the rest `pending`. Mark the current task `completed` before switching the next task to `in_progress`.

### 4. Edits blocked: `Blocked: the workspace is on a protected branch (main/master)`
- **Cause:** Policy 7 blocks direct edits and git mutation commands on `main` or `master`.
- **Fix:** Switch to a feature branch (`git switch -c feat/my-feature`) before editing code.

### 5. Edits blocked: `Blocked: file path '...' escapes workspace root`
- **Cause:** Policy 8 prevents directory traversal outside the current project root.
- **Fix:** Ensure all target file paths resolve inside the workspace directory.

### 6. Subagents cannot edit files
- **Cause:** OpenCode denies `todowrite` to subagents by default.
- **Fix:** The guard automatically walks up the `parentID` session chain, allowing subagents to inherit the parent session's active todo list. Ensure the parent/orchestrator session has active tasks before delegating to subagents.

### 7. Commands blocked with live-system warning
- **Cause:** Policy 4 blocks destructive CLI operations (e.g. `kubectl delete`, `helm uninstall`, `terraform destroy`, `psql drop`, `curl DELETE`).
- **Fix:** To intentionally run a live command, append `# allow-live` to the command string (e.g. `kubectl delete pod my-pod # allow-live`), or set the environment variable `WORKFLOW_GUARD_ALLOW_LIVE=1`.

## Limitations

- Command matching is regex-based — obfuscated commands (`echo "kubectl delete …" | bash`) can evade it. For hard guarantees, pair with environment isolation (no production credentials in agent environments).
- The task gate checks that active todos exist, not that they are well-formed or complete. If the todo endpoint can't be reached, the gate fails open (edits allowed) rather than bricking the agent.

## License

MIT
