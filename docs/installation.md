# Installation Guide

`opencode-workflow-guard` runs as an OpenCode plugin.

---

## Requirements

- **OpenCode >= 1.18** (requires the `GET /session/:id/todo` endpoint and V1 `PluginModule` loader).
- **Node.js >= 22.18** or **Bun** (for running test scripts directly).

---

## Installation Methods

### 1. From npm (Recommended)

Add the package to your project's `opencode.json` (or global `~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-workflow-guard"
  ]
}
```

OpenCode automatically installs the plugin and its dependencies with Bun at startup (cached in `~/.cache/opencode/node_modules/`). No manual file copies needed.

---

### 2. Manual File Copy (Server Plugin)

The server plugin is modular - copy the entrypoint **plus** its `lib/` and `policies/` directories into your OpenCode plugins folder (global `~/.config/opencode/plugins/` or project-level `.opencode/plugins/`):

```bash
cp -r src/workflow-guard.ts src/lib src/policies /path/to/opencode-plugins/
```

Files in your plugin directory are automatically loaded by the OpenCode server process at startup.

---

### 3. TUI Visual Indicator (Prompt Box Badge)

To enable the dynamic prompt-bar badge - `[Workflow Guard: Active]` during normal operation, switching to `[Workflow Guard: Blocked: <reason>]` for the current session when a guard policy intercepts an action:

Reference the same package name in `~/.config/opencode/tui.json`:
```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "opencode-workflow-guard"
  ]
}
```

The package exports OpenCode's conventional `./server` and `./tui` entrypoints, so OpenCode selects the correct module for each runtime automatically. Do not configure `opencode-workflow-guard/ui`: npm interprets an unscoped `name/path` spec as GitHub shorthand, which can invoke Git and its configured credential helper instead of loading the package export.

The TUI badge uses OpenCode's Solid slot API (`@opentui/solid`). It is a runtime `dependency` of this package, so npm installs it automatically alongside `opencode-workflow-guard` - no extra install is needed.

## Recovery Checkpoints

Durable recovery checkpoints are opt-in per project. Enable them in `.opencode/workflow-guard.json` (JSONC is also supported):

```json
{
  "recoveryCheckpoints": true
}
```

For each genuine user run in a root session, Workflow Guard captures the pre-run tracked and untracked workspace state in private Git objects. The objects are kept reachable under `refs/workflow-guard/checkpoints/` and do not add entries to the user's stash list. Subagent runs and Workflow Guard's synthetic continuation messages do not create or replace checkpoints.

When the root session reaches idle, the checkpoint records the resulting workspace fingerprint. The `guard_recovery_restore` tool can then restore a selected run, but only for that same root session and only while the workspace still exactly matches the recorded idle boundary. Any intervening workspace change makes recovery refuse rather than overwrite newer work. Recovery checkpoints require an existing Git commit and deliberately fail open if a snapshot cannot be created.

---

## Recommended Companion Configuration

For defense in depth, pair `opencode-workflow-guard` with OpenCode's native permission rules in `opencode.json` (see [OpenCode Permissions](https://opencode.ai/docs/permissions/)):

```json
{
  "$schema": "https://opencode.ai/config.json",
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

---

## Experimental Learning Mode

Socratic learning is disabled by default. Enable its agent-facing tools by setting `WORKFLOW_GUARD_LEARNING=1` in your user environment before OpenCode starts. Repository configuration deliberately cannot opt a user into exposing their global learning profile.

To customize the per-session intervention budget, add:

```json
{
  "maxLearningInterventions": 3
}
```

to `.opencode/workflow-guard.json` (JSONC is also supported). The intervention budget limits high-value checkpoints per session; learning remains advisory and does not alter policy enforcement.

The global learner profile is stored at `$XDG_DATA_HOME/opencode/workflow-guard/learner-profile.json`, falling back to `~/.local/share/opencode/workflow-guard/learner-profile.json`. The parent directory and file are created with user-only permissions where supported. The profile contains distilled learning evidence and project/session references, so it can be backed up or removed separately from any repository.

---

## Project Memory

Project memory is enabled automatically and requires no additional dependency or service. Its authoritative working index is a local SQLite database under `$XDG_DATA_HOME/opencode/workflow-guard/project-memory/`, falling back to `~/.local/share/opencode/workflow-guard/project-memory/`. Repositories use their Git common directory as the local identity where available, so linked worktrees share an index.

The plugin exposes `project_memory_search`, `project_memory_record`, `project_memory_export`, and `project_memory_import`. Recording is intended only for durable facts, decisions, constraints, and lessons; recognized secret content is rejected. Superseded records remain historical data but are excluded from normal retrieval.

Portable project knowledge lives at the fixed path `.opencode/memory/project-memory.jsonl`. Importing that file bootstraps the local index, but exporting is always explicit and accepts selected record IDs rather than dumping private working memory. The plugin adds `.opencode/memory/` to `.git/info/exclude` for the local clone. To share promoted knowledge through Git, deliberately remove that local exclusion or force-add the JSONL file after reviewing its contents. Do not commit the SQLite database.

Compaction receives a bounded set of recent current local memories. Imported portable records are never injected automatically and require an explicit memory search. Path-backed local memories with a recorded Git commit are excluded when those paths have committed, staged, or unstaged changes since that commit; repository contents remain authoritative over remembered context.
