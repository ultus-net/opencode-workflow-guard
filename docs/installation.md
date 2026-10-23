# Installation Guide

`opencode-workflow-guard` runs as an OpenCode plugin.

---

## Requirements

- **OpenCode >= 1.18** (V1: requires the `GET /session/:id/todo` endpoint and the V1 `PluginModule` loader) or **OpenCode 2.x**. V2 loads through the `@opencode/plugin` API. The current todo list is reconstructed from session message history, or read from the native `todowrite` on 2.1.x when `experimental.todo` is enabled.
- **Node.js >= 22.18** or **Bun** (for running test scripts directly).

### Version Qualification

The guard declares exact host dependency versions, so an unreviewed host API can
never float in. A host release is qualified only when it appears in this table
with the seats that were actually exercised against it. An unlisted version is
unqualified by definition. That does not mean it is broken. It means nobody has
verified it.

| Guard | OpenCode qualified | Hook seats exercised | Notes |
|---|---|---|---|
| 1.16.x | 2.0.15 | `permission.hook("evaluate")`, `tool.hook("execute.before"/"execute.after")`, `session.hook("context")`, `experimental.text.complete`, command registration, `mcp.list`, `worktree` client | Unit and package-loader verified. Live model-driven probes reached the provider and were classified `live unavailable` (`Model unavailable: openrouter/openrouter/auto`), so no guard verdict was produced. |
| 1.16.x | 2.1.3 | `permission.hook("evaluate")`, `tool.hook(...)`, `session.hook(...)`, `experimental.text.complete`, command registration, `mcp.list`, `worktree` client, `todowrite` behind `experimental.todo` | Package-loader and headless-runtime verified (`npm run test:install`: 30 passed). Live host probe confirmed `ctx.tool.list()` exposes `todowrite` with `experimental.todo: true` and omits it when false. Live static-policy denial canary produced `Blocked by configuration policy`. |
| 1.16.x | 1.18.32 (`@opencode-ai/plugin`) | V1 `PluginModule` loader, native todo endpoint | Compatibility export only; unit-tested, no live host probe. |

The 2.1.3 pins require the 2.1.x package set. `@opencode/plugin` and
`@opencode/ai` are pinned to `2.1.3`, which depends on `effect@4.0.1` and
requires `@opentui/solid >=0.6.6`. The guard pins `0.6.6`. A 2.0.x pin set on a
2.1.x host fails to load at all. The plugin imports an `effect` path the host no
longer provides, and the host reports `failed to load plugin` while every
policy stays inert.

`guard_status` reports `pluginVersion`, `qualifiedHostVersion`, and the live
`hostVersion`, so a mismatch is visible at runtime rather than surfacing as a
silently inert hook.

### Dependency Audit Overrides

Two transitive dependencies are pinned above the range their parent declares, to
clear advisories that would otherwise ship:

| Package | Parent constraint | Override | Why |
|---|---|---|---|
| `solid-js` | `@opentui/solid@0.6.6` peer-pins exactly `1.9.12` | `1.9.17` | `1.9.12` requires `seroval ~1.5.0`, which carries memory-exhaustion and thenable-assimilation advisories. `1.9.17` requires `seroval ~1.6.8`, which is patched. The TUI imports `solid-js` directly, so the bump is also the version the guard actually runs. |
| `toml` | `effect@4.0.0-beta.83` (via `@opencode-ai/plugin`) requires `^4.1.1` | `5.0.1` | `toml <=5.0.0` carries three quadratic-complexity denial-of-service advisories. `5.0.1` keeps the same single `parse` export the caller uses. The guard itself never parses TOML; this is host plumbing. |

Both are `overrides` entries in `package.json`, and `npm audit` reports zero
vulnerabilities for this repository. `npm overrides` apply only to the root
project, so they protect this repository's install and its CI, not a consumer's
transitive tree. A consumer that installs the published package resolves the
parent-declared ranges unless it declares the same overrides itself. Revisit both
when `@opentui/solid` or `@opencode-ai/plugin` widen their ranges, and drop the
override rather than carrying it forward.

---

## Installation Methods

### 1. From npm (Recommended)

Install the current published version with OpenCode's plugin command:

```bash
VERSION=$(npm view opencode-workflow-guard version)
opencode plugin add "opencode-workflow-guard@$VERSION"                    # OpenCode 2.x
opencode plugin "opencode-workflow-guard@$VERSION" --global --force       # OpenCode 1.x
```

OpenCode 2 documents `opencode plugin add <package>` as the command to install a plugin and add it to the global configuration. OpenCode 1 documents `opencode plugin <module>` with `--global` and `--force`. Workflow Guard exposes both server and TUI targets, so OpenCode detects both and updates their global configuration files. OpenCode 2 uses one global `cli.json` for terminal-client settings. Restart OpenCode after installation, because configuration is loaded at startup. See the [OpenCode plugin CLI documentation](https://opencode.ai/docs/cli/#plugin).

Use the same two commands to upgrade after a Workflow Guard release. Keep the explicit version in OpenCode's configuration rather than relying on a bare package name or `@latest`. OpenCode caches npm plugins, and an already-populated `@latest` cache key may keep resolving to the version that originally populated it. An explicit new version creates a new package-cache key without manually deleting OpenCode's cache.

If you only want the server guard without the TUI companion, add the package to your project's `opencode.json`, or to the global `~/.config/opencode/opencode.json`. OpenCode 2 reads only the plural `plugins` key. OpenCode 1.x uses the singular `plugin` key. The OpenCode 2 config schema drops a singular key without an error. The guard then appears configured and never loads:

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
`tui.json`. A plural key there is silently ignored, and the TUI badge never
loads.

### Configure The Guard In One Location Only

Name the guard in exactly one place per OpenCode process: either the global configuration or a project configuration, never both. The global configuration is `~/.config/opencode/opencode.json[c]`, with `plugins` on 2.x or `plugin` on 1.x. OpenCode 2 merges plugin arrays instead of replacing them. Listing `opencode-workflow-guard` globally and again in a project's `.opencode/opencode.json` therefore loads the same entrypoint twice under two ids. Two instances register duplicate hooks and duplicate tool definitions. That evaluates and audits every tool call twice. One instance can overwrite the other's tool-description enrichment, and both prime the process-global workspace latch from two roots in the same tick.

The guard detects the duplicate instead of failing silently. The first instance for a given (module path, workspace root) pair owns enforcement, and a later instance registers no hooks or tools. The duplicate is recorded at warn level in the server log and as an audit record (`tool: "plugin.instance"`, `reason: "duplicate_plugin_load"`) in `workflow-guard.jsonl`. A server log with two `loading plugin.*workflow-guard` lines on a fresh start is therefore a configuration error, not a supported setup. As a second layer, the first instance to reach a given (session, call, tool) claims its policy decision. A guard loaded from two distinct paths, such as an npm cache copy plus a source checkout, still produces one decision per call.

A repository that ships its own `.opencode/opencode.json` with a `plugin`/`plugins` entry is the usual source of the second copy. Remove the entry there and let the global configuration carry the guard. Because OpenCode settings are tamper-protected from agent edits, that file must be changed by the operator.

A configured bare package name is resolved through Node's parent-directory lookup from OpenCode's configuration location. Any `node_modules` above that location that contains a copy of the package is loaded instead. That includes a pnpm-managed home directory, a manual `npm install`, and a workspace dependency. This shadows both OpenCode's own plugin cache and a global `npm install -g`. Updating the wrong copy leaves an old version running while the update appears to succeed. OpenCode's own plugin-update check can also fail with only a server-log record (`NpmInstallFailedError`). Update the copy that actually loads. For a pnpm-managed home directory, run `pnpm add opencode-workflow-guard@<version>` in that directory, or remove the dependency so OpenCode manages its own copy. Then restart the background service with `opencode service restart`. The plugin loads there, so a TUI-only restart is not enough. Verify what loaded in three places. `guard_status` reports the loaded version as `pluginVersion`. The startup app log states `Workflow Guard v<version> plugin initialized`. The server log records the resolved module path in its `loading plugin` entry.

---

### 3. Manual Local-File Installation (Server Plugin)

The npm package entrypoint uses OpenCode's V1 plugin module shape (`{ id, server }`). For a source checkout, keep the modular server source outside the auto-loaded `plugins/` directory and add a small adapter with the same module shape:

```bash
mkdir -p .opencode/workflow-guard-source .opencode/plugins
cp src/workflow-guard.ts .opencode/workflow-guard-source/
cp -r src/lib src/policies .opencode/workflow-guard-source/
printf '%s\n' 'import { WorkflowGuard } from "../workflow-guard-source/workflow-guard.ts";' 'export default { id: "workflow-guard-local", server: WorkflowGuard };' > .opencode/plugins/workflow-guard.ts
```

OpenCode automatically discovers the adapter from the project-level `.opencode/plugins/` directory at startup. For deterministic development and test fixtures, it can also be registered explicitly in `.opencode/opencode.json` as `"./plugins/workflow-guard.ts"`. OpenCode deduplicates the resulting file URL. npm installation is recommended for normal use. The local-file form is primarily useful when developing from a source checkout.

---

### 4. TUI Visual Indicator (Prompt Box Badge)

To enable the static `Workflow Guard 🛡️` prompt-bar badge, with block details reported separately through warning toasts:

The recommended `opencode plugin add "opencode-workflow-guard@$VERSION"` command configures this automatically. OpenCode detects both targets and registers the server plugin in the global `opencode.json(c)`. On OpenCode 2 it also registers the TUI companion in the global `~/.config/opencode/cli.json`. For manual installation, use the same explicit package version in the TUI target of your OpenCode generation. On OpenCode 2 that target is the global `~/.config/opencode/cli.json` with the `plugins` array:

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

The version above is illustrative. Replace it with the version you intend to install. The package exposes separate server and TUI entrypoints. In the terminal-client config, configure the package spec. OpenCode resolves its exported `./tui` entrypoint automatically. Do not place `workflow-guard-ui.ts` under `plugins/`, because the server loader rejects TUI-only modules.

On OpenCode 2, `plugin check` and `plugin update` cover both server and TUI-only package plugins.

The TUI badge uses OpenCode's Solid slot API (`@opentui/solid`). It is a runtime `dependency` of this package, so npm installs it automatically alongside `opencode-workflow-guard` - no extra install is needed.

## Recovery Checkpoints

Workflow Guard supports two optional operation profiles in `.opencode/workflow-guard.json`. JSONC is also supported. `interactive` is the default and preserves the standard behavior. `autonomous` enables durable recovery checkpoints by default for longer-running agent work. Profiles only supply defaults for optional workflow behavior. They never weaken secret protection, protected-path protection, workspace confinement, protected-branch safeguards, or other deterministic policy checks.

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

When the root session reaches idle, the checkpoint records the resulting workspace fingerprint. The `guard_recovery_restore` tool can then restore a selected run. It works only for that same root session, and only while the workspace still exactly matches the recorded idle boundary. Any intervening workspace change makes recovery refuse rather than overwrite newer work. Recovery checkpoints require an existing Git commit, and they fail open if a snapshot cannot be created.

With the optional TUI companion installed, open the command palette and choose **Workflow Guard: Project Options**, or run `/guard-options`. The command toggles recovery checkpoints, project memory, learner mode, Ralph mode, or the title-settle workaround for the current project. It writes the existing Workflow Guard project config location, which defaults to `.opencode/workflow-guard.json`. Restart OpenCode after changing a setting, so the server plugin can expose the matching tools.

The title-settle workaround is on by default, because Workflow Guard's automatic continuation can race OpenCode's asynchronous native title generation. Workflow Guard briefly waits for native title generation before sending an automatic continuation for unfinished root-session work. Set `titleSettleWorkaround: false` to opt out. The wait is bounded. It applies only when that session owns unfinished todos, and it never changes the title or provider and model parameters itself.

Ralph mode is also off by default, including under the `autonomous` profile. Enable it explicitly with `ralphMode: true`. `ralphMaxIterations` sets its positive integer continuation budget from 1 through 100. The default is 10, and invalid values use the default. Ralph only continues a root session while that session already owns unfinished native todos. It does not create, prioritize, select, sequence, or delegate work, and every resumed run remains subject to the normal guardrails. Genuine user input stops an active Ralph run instead of resetting its budget. Reaching the budget with unfinished work reports `budget_exhausted`. Completion is reported only when owned todos are actually finished. A `blocked` outcome is reserved for a demonstrable guard state and is never inferred merely from repeated idle events. `guard_status` exposes the effective Ralph configuration and current calling-session outcome.

OpenCode's model and provider request timeout is separate from Workflow Guard. In OpenCode 1.18+, configure it under the selected provider's `options.timeout` in project `opencode.json[c]`. The default is 300000 ms (5 minutes), and `false` disables the provider request timeout. Workflow Guard does not impose a whole-session wall-clock limit.

---

## Secondary Review Requirement

Workflow Guard enforces secondary review approval (`requireReview`) by default during PR creation (`gh pr create` and `az repos pr create`). Before a pull request can be opened, an agent must invoke a secondary review subagent and record passing review approval using `record_review` evaluated against `guard_review_rubric`.

The recorded verdict binds to the reviewed repository content: the commit hash and the tracked-content worktree fingerprint of the directory it was recorded against. The PR preflight accepts any approval whose binding matches the tree the PR would publish. A review recorded by a subagent rooted in a linked git worktree therefore satisfies a `pr create` run from that worktree. That holds even from a different session than the one that spawned the reviewer. Review freshness is scoped to tracked content. Deleting an untracked scratch file does not invalidate an approval, and any tracked edit or new commit does. Reviewer agents are frequently configured with read-only toolsets that exclude `record_review`. The tool therefore accepts recorders of any session type and binds the verdict to the recording session's directory. The audit trail records who recorded it and where it is bound.

To opt out of the PR secondary review gate for a project, set `requireReview: false` in `.opencode/workflow-guard.json`:

```json
{
  "requireReview": false
}
```

Or set `WORKFLOW_GUARD_REQUIRE_REVIEW=0` in your environment. Conversely, `WORKFLOW_GUARD_REQUIRE_REVIEW=1` enforces the review gate regardless of repository configuration.

For stricter environments, set `requireSubagentReview: true` in `.opencode/workflow-guard.json`. That setting rejects approvals recorded by the root session itself. A passing verdict must then be recorded from a subagent session, which is one with a parent session. The root session can never approve its own work. Changes-requested findings remain relayable from any session. `WORKFLOW_GUARD_REQUIRE_SUBAGENT_REVIEW=1` enables the same requirement for any project. `WORKFLOW_GUARD_REQUIRE_SUBAGENT_REVIEW=0` disables it even when project config enables it.

---

## Live-Documentation Research Floor

Policy 25 is enabled by default. A session that accumulates failed tool calls with no live-documentation lookup since gets its next mutating or shell call blocked. The block holds until the agent consults a current source. Only non-research failures count, so a failed `websearch` never deepens the block. Reads, greps, and research tools are never gated.

The builtin research names cover `websearch`, `webfetch`, and common aliases. MCP documentation servers are matched on whole server names. That means a guard inspection tool or a generic file reader cannot clear the debt by name accident. If your docs server uses an unrecognised name, declare it:

```json
{
  "requireLiveDocs": true,
  "liveDocFailureThreshold": 3,
  "researchTools": ["acme-docs", "internal-wiki"]
}
```

Or set `WORKFLOW_GUARD_REQUIRE_LIVE_DOCS=0` to disable the floor, `WORKFLOW_GUARD_LIVE_DOC_THRESHOLD` to retune the trigger, and `WORKFLOW_GUARD_RESEARCH_TOOLS` (comma-separated) to add research names. An unparseable, zero, or negative threshold falls back to the default of 3.

The acting agent must be permitted to call at least one research tool. An agent whose toolset denies `websearch`/`webfetch` and exposes no MCP docs server cannot satisfy the floor, so grant one or disable the policy.

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

Socratic learning is disabled by default. Enable its agent-facing tools with the `learning: true` project option, including through `/guard-options`. Alternatively, set `WORKFLOW_GUARD_LEARNING=1` in your user environment before OpenCode starts. That enables it regardless of the project setting.

To customize the per-session intervention budget, add:

```json
{
  "maxLearningInterventions": 3
}
```

to `.opencode/workflow-guard.json` (JSONC is also supported). The intervention budget limits high-value checkpoints per session. Learning remains advisory and does not alter policy enforcement or direct the workflow.

The global learner profile is stored at `$XDG_DATA_HOME/opencode/workflow-guard/learner-profile.json`, falling back to `~/.local/share/opencode/workflow-guard/learner-profile.json`. The parent directory and file are created with user-only permissions where supported. The profile contains distilled learning evidence and project/session references, so it can be backed up or removed separately from any repository.

---

### Project Memory

Project memory is optional supporting context, enabled by default, and requires no additional dependency or service. Set `projectMemory: false` (or toggle it through `/guard-options`) to disable its initialization and tools for a project without weakening policy enforcement. Its authoritative working index is a local SQLite database under `$XDG_DATA_HOME/opencode/workflow-guard/project-memory/`, falling back to `~/.local/share/opencode/workflow-guard/project-memory/`. Repositories use their Git common directory as the local identity where available, so linked worktrees share an index.

The plugin exposes `project_memory_search`, `project_memory_record`, `project_memory_export`, and `project_memory_import`. Recording is intended only for durable facts, decisions, constraints, and lessons. Recognized secret content is rejected. Routine tool, test, and verification output, transient errors and retries, successful operational telemetry, todos, and session progress belong in their existing operational stores. They do not belong in project memory.

Project-memory maintenance runs opportunistically when a project index is opened, at most once per day. Superseded memories and resolved review follow-ups are retained for 90 days and then pruned. Current memories are not expired just because they are old. Maintenance checkpoints and compacts the active SQLite database. It also reaps coordination markers (`*.sqlite.active.*`) left behind by processes that died without closing their store. Markers owned by live or unidentifiable processes are never removed. When the project-memory directory exceeds 100 MB, least-recently-used inactive project databases are evicted toward about 80 MB when eligible databases exist. The current project's database is never selected for global eviction, and maintenance failures do not disable core guard enforcement.

Portable project knowledge lives at the fixed path `.opencode/memory/project-memory.jsonl`. Importing that file bootstraps the local index, but exporting is always explicit and accepts selected record IDs rather than dumping private working memory. The plugin adds `.opencode/memory/` to `.git/info/exclude` for the local clone. To share promoted knowledge through Git, deliberately remove that local exclusion or force-add the JSONL file after reviewing its contents. Do not commit the SQLite database.

Compaction receives a bounded set of recent current local memories. Imported portable records are never injected automatically and require an explicit memory search. Path-backed local memories with a recorded Git commit are excluded when those paths have committed, staged, or unstaged changes since that commit. Repository contents remain authoritative over remembered context. Memory supplies context rather than instructions. It does not select, prioritize, or sequence work.
