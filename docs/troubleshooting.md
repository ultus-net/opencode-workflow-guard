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
- **Root Cause:** Policy 1 blocks file-editing tools until the session's native todo list (`GET /session/:id/todo`) contains at least one task with status `pending` or `in_progress`.
- **Solution:** The agent must call `todowrite` first. Once all tasks are marked `completed` or `cancelled`, edits will block again until a new breakdown is created for subsequent work.

---

### 3. `Blocked todowrite: only one task may be 'in_progress'`

- **Symptoms:** `todowrite` fails with a message restricting parallel in-progress tasks.
- **Root Cause:** Policy 1 enforces a strict focus rule: only one task may be `in_progress` at any time.
- **Solution:** Keep one task `in_progress` and the rest `pending`. Mark the current task `completed` before advancing the next task to `in_progress`.

---

### 4. `Blocked todowrite: active task '...' was removed`

- **Symptoms:** `todowrite` is blocked after an active item disappears from the submitted list.
- **Root Cause:** Policy 1 requires active tasks to be explicitly completed or cancelled rather than silently removed. Independent items may otherwise be completed out of order.
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
- **Solution:** The guard automatically walks up the `parentID` session hierarchy so subagents inherit the orchestrator session's active tasks. Ensure the parent session has active tasks before delegating work to subagents.

---

### 8. Destructive Commands Blocked (`kubectl`, `terraform`, `psql`, etc.)

- **Symptoms:** A CLI command is rejected with a live-system mutation warning.
- **Root Cause:** Policy 4 blocks destructive cloud, database, and infrastructure operations.
- **Solution:** To intentionally run a live command, set `WORKFLOW_GUARD_ALLOW_LIVE=1` in the environment before launching OpenCode. There is no in-command override; an agent cannot grant this permission to itself.
