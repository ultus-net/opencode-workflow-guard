# Installation Guide

`opencode-workflow-guard` runs as an OpenCode plugin.

---

## Requirements

- **OpenCode >= 1.18** (V1: requires the `GET /session/:id/todo` endpoint and the V1 `PluginModule` loader) or **OpenCode 2.x** (V2: loads through the `@opencode/plugin` API; the current todo list is reconstructed from session message history, or read from the native `todowrite` on 2.1.x when `experimental.todo` is enabled).
- **Node.js >= 22.18** or **Bun** (for running test scripts directly).

### Version Qualification

The guard declares exact host dependency versions, so an unreviewed host API can
never float in. A host release is qualified only when it appears in this table
with the seats that were actually exercised against it. An unlisted version is
unqualified by definition, which does not mean it is broken; it means nobody has
verified it.

| Guard | OpenCode qualified | Hook seats exercised | Notes |
|---|---|---|---|
| 1.16.x | 2.0.15 | `permission.hook("evaluate")`, `tool.hook("execute.before"/"execute.after")`, `session.hook("context")`, `experimental.text.complete`, command registration, `mcp.list`, `worktree` client | Unit and package-loader verified. Live model-driven probes reached the provider and were classified `live unavailable` (`Model unavailable: openrouter/openrouter/auto`), so no guard verdict was produced. |
| 1.16.x | 1.18.32 (`@opencode-ai/plugin`) | V1 `PluginModule` loader, native todo endpoint | Compatibility export only; unit-tested, no live host probe. |
| 1.16.x | 2.1.x (`todowrite` behind `experimental.todo`) | Todo capability probe and gate inversion | **NOT RUN.** Only synthetic registry/session data is covered. The 2.1.x acceptance in the implementation plan remains open. |

`guard_status` reports `pluginVersion`, `qualifiedHostVersion`, and the live
`hostVersion`, so a mismatch is visible at runtime rather than surfacing as a
silently inert hook.

---

## Installation Methods

### 1. From npm (Recommended)

Install the current published version with OpenCode's plugin command:

```bash
VERSION=$(npm view opencode-workflow-guard version)
opencode plugin add "opencode-workflow-guard@$VERSION"                    # OpenCode 2.x
opencode plugin "opencode-workflow-guard@$VERSION" --global --force       # OpenCode 1.x
```

OpenCode 2 documents `opencode plugin add <package>` as the command to install a plugin and add it to the global configuration; OpenCode 1 documents `opencode plugin <module>` with `--global` and `--force`. Workflow Guard exposes both server and TUI targets, so OpenCode detects both and updates their global configuration files (OpenCode 2 uses one global `cli.json` for terminal-client settings). Restart OpenCode after installation because configuration is loaded at startup. See the [OpenCode plugin CLI documentation](https://opencode.ai/docs/cli/#plugin).

Use the same two commands to upgrade after a Workflow Guard release. Keep the explicit version in OpenCode's configuration rather than relying on a bare package name or `@latest`: OpenCode caches npm plugins, and an already-populated `@latest` cache key may continue resolving to the version that originally populated it. An explicit new version creates a new package-cache key without manually deleting OpenCode's cache.

If you only want the server guard without the TUI companion, add the package to your project's `opencode.json` (or global `~/.config/opencode/opencode.json`). OpenCode 2 reads only the plural `plugins` key; OpenCode 1.x uses the singular `plugin` key. A singular key in an OpenCode 2 config is dropped by the config schema without an error, so the guard will appear configured and never load:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "opencode-workflow-guard"
  ]
}
```

OpenCode automatically installs configured npm plugins and their dependencies at startup. The npm package contains both server and TUI entrypoints, but OpenCode activates them from separate configuration files. See [OpenCode's npm plugin documentation](https://opencode.ai/docs/plugins/#from-npm) and [plugin installation behavior](https://opencode.ai/docs/plugins/#how-plugins-are-installed).

### 2. Self-Configuring `setup` Command

The package ships a `setup` command that writes the plugin entry into the global
configuration for you:

```bash
opencode-workflow-guard setup            # OpenCode 2: writes `plugins`
opencode-workflow-guard setup --major 1  # OpenCode 1: writes `plugin`
```

The command detects the target from the existing config: a `plugins` key means
OpenCode 2, a `plugin` key means OpenCode 1, and a fresh config defaults to
OpenCode 2. `--major` overrides the detection. The two keys are not
interchangeable: OpenCode 2's config schema drops a singular `plugin` key
without an error, so writing the wrong one produces a config that looks
configured and loads nothing. The writer refuses to clobber an unparseable
config or a non-array plugin key.

`tui.json` is the exception to the key rule. Its schema reads singular `plugin`
on both majors, and OpenCode 2 migrates that key into `cli.json.plugins`. So
`--major 2` writes `plugins` to the server config and still writes `plugin` to
`tui.json`; a plural key there is silently ignored and the TUI badge never
loads.

### Configure The Guard In One Location Only

Name the guard in exactly one place per OpenCode process: either the global configuration (`~/.config/opencode/opencode.json[c]`, `plugins` on 2.x or `plugin` on 1.x) or a project configuration, never both. OpenCode 2 merges plugin arrays instead of replacing them, so listing `opencode-workflow-guard` globally and again in a project's `.opencode/opencode.json` loads the same entrypoint twice under two ids. Two instances register duplicate hooks and duplicate tool definitions, which evaluates and audits every tool call twice, lets one instance overwrite the other's tool-description enrichment, and primes the process-global workspace latch from two roots in the same tick.

The guard detects the duplicate instead of failing silently: the first instance for a given (module path, workspace root) pair owns enforcement, and a later instance registers no hooks or tools. The duplicate is recorded at warn level in the server log and as an audit record (`tool: "plugin.instance"`, `reason: "duplicate_plugin_load"`) in `workflow-guard.jsonl`, so `grep 'loading plugin.*workflow-guard'` on a fresh server log showing two lines is a configuration error, not a supported setup. As a second layer, the first instance to reach a given (session, call, tool) claims its policy decision, so a guard loaded from two distinct paths (an npm cache copy plus a source checkout) still produces one decision per call.

A repository that ships its own `.opencode/opencode.json` with a `plugin`/`plugins` entry is the usual source of the second copy. Remove the entry there and let the global configuration carry the guard. Because OpenCode settings are tamper-protected from agent edits, that file must be changed by the operator.

A configured bare package name is resolved through Node's parent-directory lookup from OpenCode's configuration location: any `node_modules` above that location that contains a copy of the package (a pnpm-managed home directory, a manual `npm install`, or a workspace dependency) is loaded instead, shadowing both OpenCode's own plugin cache and a global `npm install -g` — updating the wrong copy leaves an old version running while the update appears to succeed, and OpenCode's own plugin-update check can fail with only a server-log record (`NpmInstallFailedError`). Update the copy that actually loads (for a pnpm-managed home directory: `pnpm add opencode-workflow-guard@<version>` in that directory, or remove the dependency so OpenCode manages its own copy), then restart the background service (`opencode service restart`) — the plugin loads there, so a TUI-only restart is not enough. Verify what loaded: `guard_status` reports the loaded version as `pluginVersion`, the startup app log states `Workflow Guard v<version> plugin initialized`, and the server log records the resolved module path in its `loading plugin` entry.

---

### 3. Manual Local-File Installation (Server Plugin)

The npm package entrypoint uses OpenCode's V1 plugin module shape (`{ id, server }`). For a source checkout, keep the modular server source outside the auto-loaded `plugins/` directory and add a small adapter with the same module shape:

```bash
mkdir -p .opencode/workflow-guard-source .opencode/plugins
cp src/workflow-guard.ts .opencode/workflow-guard-source/
cp -r src/lib src/policies .opencode/workflow-guard-source/
printf '%s\n' 'import { WorkflowGuard } from "../workflow-guard-source/workflow-guard.ts";' 'export default { id: "workflow-guard-local", server: WorkflowGuard };' > .opencode/plugins/workflow-guard.ts
```

OpenCode automatically discovers the adapter from the project-level `.opencode/plugins/` directory at startup. For deterministic development and test fixtures, it can also be registered explicitly in `.opencode/opencode.json` as `"./plugins/workflow-guard.ts"`; OpenCode deduplicates the resulting file URL. npm installation is recommended for normal use; the local-file form is primarily useful when developing from a source checkout.

---

### 4. TUI Visual Indicator (Prompt Box Badge)

To enable the static `Workflow Guard 🛡️` prompt-bar badge, with block details reported separately through warning toasts:

The recommended `opencode plugin add "opencode-workflow-guard@$VERSION"` command configures this automatically: OpenCode detects both targets and registers the server plugin in the global `opencode.json(c)` and the TUI companion in the global `~/.config/opencode/cli.json` (OpenCode 2). For manual installation, use the same explicit package version in the TUI target of your OpenCode generation - global `~/.config/opencode/cli.json` with the `plugins` array on OpenCode 2:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    "opencode-workflow-guard@1.13.2"
  ]
}
```

or `~/.config/opencode/tui.json` with the `plugin` array on OpenCode 1.x:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "opencode-workflow-guard@1.13.2"
  ]
}
```

The version above is illustrative; replace it with the version you intend to install. The package exposes separate server and TUI entrypoints. In the terminal-client config, configure the package spec; OpenCode resolves its exported `./tui` entrypoint automatically. Do not place `workflow-guard-ui.ts` under `plugins/`; the server loader rejects TUI-only modules.

On OpenCode 2, `plugin check` and `plugin update` cover both server and TUI-only package plugins.

The TUI badge uses OpenCode's Solid slot API (`@opentui/solid`). It is a runtime `dependency` of this package, so npm installs it automatically alongside `opencode-workflow-guard` - no extra install is needed.

## Recovery Checkpoints

Workflow Guard supports two optional operation profiles in `.opencode/workflow-guard.json` (JSONC is also supported): `interactive` is the default and preserves the standard behavior, while `autonomous` enables durable recovery checkpoints by default for longer-running agent work. Profiles only supply defaults for optional workflow behavior; they never weaken secret protection, protected-path protection, workspace confinement, protected-branch safeguards, or other deterministic policy checks.

```json
{
  "profile": "autonomous"
}
```

Explicit feature settings take precedence over the profile. For example, an autonomous project can disable checkpoints with `{ "profile": "autonomous", "recoveryCheckpoints": false }`. Unknown profile values are treated as `interactive`. Project memory, Socratic learning, and Ralph mode remain independently configurable rather than being enabled by a profile.

Durable recovery checkpoints can also be enabled directly per project:

```json
{
  "recoveryCheckpoints": true
}
```

For each genuine user run in a root session, Workflow Guard captures the pre-run tracked and untracked workspace state in private Git objects. The objects are kept reachable under `refs/workflow-guard/checkpoints/` and do not add entries to the user's stash list. Subagent runs and Workflow Guard's synthetic continuation messages do not create or replace checkpoints.

When the root session reaches idle, the checkpoint records the resulting workspace fingerprint. The `guard_recovery_restore` tool can then restore a selected run, but only for that same root session and only while the workspace still exactly matches the recorded idle boundary. Any intervening workspace change makes recovery refuse rather than overwrite newer work. Recovery checkpoints require an existing Git commit and deliberately fail open if a snapshot cannot be created.

With the optional TUI companion installed, open the command palette and choose **Workflow Guard: Project Options** (or run `/guard-options`) to toggle recovery checkpoints, project memory, learner mode, Ralph mode, or the title-settle workaround for the current project. The command writes the existing Workflow Guard project config location, defaulting to `.opencode/workflow-guard.json`; restart OpenCode after changing a setting so the server plugin can expose the matching tools.

The title-settle workaround is on by default because Workflow Guard's automatic continuation can race OpenCode's asynchronous native title generation. Workflow Guard briefly waits for native title generation before sending an automatic continuation for unfinished root-session work; set `titleSettleWorkaround: false` to opt out. The wait is bounded, applies only when that session owns unfinished todos, and never changes the title or provider/model parameters itself.

Ralph mode is also off by default, including under the `autonomous` profile. Enable it explicitly with `ralphMode: true`; `ralphMaxIterations` sets its positive integer continuation budget from 1 through 100 (default 10; invalid values use the default). Ralph only continues a root session while that session already owns unfinished native todos. It does not create, prioritize, select, sequence, or delegate work, and every resumed run remains subject to the normal guardrails. Genuine user input stops an active Ralph run instead of resetting its budget. Reaching the budget with unfinished work reports `budget_exhausted`; completion is reported only when owned todos are actually finished. A `blocked` outcome is reserved for a demonstrable guard state and is never inferred merely from repeated idle events. `guard_status` exposes the effective Ralph configuration and current calling-session outcome.

OpenCode's model/provider request timeout is separate from Workflow Guard. In OpenCode 1.18+, configure it under the selected provider's `options.timeout` in project `opencode.json[c]`; the default is 300000 ms (5 minutes), and `false` disables the provider request timeout. Workflow Guard does not impose a whole-session wall-clock limit.

---

## Secondary Review Requirement

Workflow Guard enforces secondary review approval (`requireReview`) by default during PR creation (`gh pr create` and `az repos pr create`). Before a pull request can be opened, an agent must invoke a secondary review subagent and record passing review approval using `record_review` evaluated against `guard_review_rubric`.

The recorded verdict is bound to the reviewed repository content (commit hash + tracked-content worktree fingerprint of the directory it was recorded against), and the PR preflight accepts any approval whose binding matches the tree the PR would publish. A review recorded by a subagent rooted in a linked git worktree therefore satisfies a `pr create` run from that worktree, even from a different session than the one that spawned the reviewer. Review freshness is scoped to tracked content: deleting an untracked scratch file does not invalidate an approval, but any tracked edit or new commit does. Because reviewer agents are frequently configured with read-only toolsets that exclude `record_review`, the tool accepts recorders of any session type and binds the verdict to the recording session's directory; the audit trail records who recorded it and where it is bound.

To opt out of the PR secondary review gate for a project, set `requireReview: false` in `.opencode/workflow-guard.json`:

```json
{
  "requireReview": false
}
```

Or set `WORKFLOW_GUARD_REQUIRE_REVIEW=0` in your environment. Conversely, `WORKFLOW_GUARD_REQUIRE_REVIEW=1` enforces the review gate regardless of repository configuration.

For stricter environments, set `requireSubagentReview: true` in `.opencode/workflow-guard.json` to reject approvals recorded by the root session itself: a passing verdict must then be recorded from a subagent session (one with a parent session), never by the root session approving its own work. Changes-requested findings remain relayable from any session. `WORKFLOW_GUARD_REQUIRE_SUBAGENT_REVIEW=1` enables the same requirement for any project; `WORKFLOW_GUARD_REQUIRE_SUBAGENT_REVIEW=0` disables it even when project config enables it.

---

## Recommended Companion Configuration

For defense in depth, pair `opencode-workflow-guard` with OpenCode's native permission rules (see [OpenCode Permissions](https://opencode.ai/docs/permissions/)). OpenCode 2 uses one ordered `permissions` array (`bash` actions are named `shell` in V2):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permissions": [
    { "action": "shell", "resource": "git push *main*", "effect": "deny" },
    { "action": "shell", "resource": "git push *master*", "effect": "deny" },
    { "action": "shell", "resource": "opencode auth*", "effect": "deny" }
  ]
}
```

OpenCode 1.x groups rules by tool under the singular `permission` key:

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

## Optional Context Features

Project memory and Socratic learning are context modules, not part of Workflow Guard's policy authority or an agent orchestration loop. They can be disabled without weakening deterministic policy enforcement, and neither module selects or sequences agent work.

### Experimental Learning Mode

Socratic learning is disabled by default. Enable its agent-facing tools with the `learning: true` project option (including through `/guard-options`), or set `WORKFLOW_GUARD_LEARNING=1` in your user environment before OpenCode starts to enable it regardless of the project setting.

To customize the per-session intervention budget, add:

```json
{
  "maxLearningInterventions": 3
}
```

to `.opencode/workflow-guard.json` (JSONC is also supported). The intervention budget limits high-value checkpoints per session; learning remains advisory and does not alter policy enforcement or direct the workflow.

The global learner profile is stored at `$XDG_DATA_HOME/opencode/workflow-guard/learner-profile.json`, falling back to `~/.local/share/opencode/workflow-guard/learner-profile.json`. The parent directory and file are created with user-only permissions where supported. The profile contains distilled learning evidence and project/session references, so it can be backed up or removed separately from any repository.

---

### Project Memory

Project memory is optional supporting context, enabled by default, and requires no additional dependency or service. Set `projectMemory: false` (or toggle it through `/guard-options`) to disable its initialization and tools for a project without weakening policy enforcement. Its authoritative working index is a local SQLite database under `$XDG_DATA_HOME/opencode/workflow-guard/project-memory/`, falling back to `~/.local/share/opencode/workflow-guard/project-memory/`. Repositories use their Git common directory as the local identity where available, so linked worktrees share an index.

The plugin exposes `project_memory_search`, `project_memory_record`, `project_memory_export`, and `project_memory_import`. Recording is intended only for durable facts, decisions, constraints, and lessons; recognized secret content is rejected. Routine tool/test/verification output, transient errors and retries, successful operational telemetry, todos, and session progress belong in their existing operational stores rather than project memory.

Project-memory maintenance runs opportunistically when a project index is opened, at most once per day. Superseded memories and resolved review follow-ups are retained for 90 days and then pruned; current memories are not expired just because they are old. Maintenance checkpoints and compacts the active SQLite database, and reaps coordination markers (`*.sqlite.active.*`) left behind by processes that died without closing their store; markers owned by live or unidentifiable processes are never removed. When the project-memory directory exceeds 100 MB, least-recently-used inactive project databases are evicted toward about 80 MB when eligible databases exist. The current project's database is never selected for global eviction, and maintenance failures do not disable core guard enforcement.

Portable project knowledge lives at the fixed path `.opencode/memory/project-memory.jsonl`. Importing that file bootstraps the local index, but exporting is always explicit and accepts selected record IDs rather than dumping private working memory. The plugin adds `.opencode/memory/` to `.git/info/exclude` for the local clone. To share promoted knowledge through Git, deliberately remove that local exclusion or force-add the JSONL file after reviewing its contents. Do not commit the SQLite database.

Compaction receives a bounded set of recent current local memories. Imported portable records are never injected automatically and require an explicit memory search. Path-backed local memories with a recorded Git commit are excluded when those paths have committed, staged, or unstaged changes since that commit; repository contents remain authoritative over remembered context. Memory supplies context rather than instructions and does not select, prioritize, or sequence work.
