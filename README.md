# opencode-workflow-guard

A plugin for [OpenCode](https://opencode.ai) that enforces workflow discipline through **deterministic hooks** — not prompt rules that models can ignore.

Ported from [cline-workflow-guard](https://github.com/ultus-net/cline-workflow-guard). All policies run in the `tool.execute.before` plugin hook ([docs](https://opencode.ai/docs/plugins/)) and **block a tool call by throwing**, which denies execution outright.

## What it enforces

| # | Policy | Enforcement |
|---|--------|-------------|
| 1 | **Task breakdown** | Edit tools (`edit`, `write`, `patch`) are blocked until the workspace root has `TASKS.md` / `TODO.md` / `PLAN.md` / `.opencode/plan.md` containing at least one unchecked `- [ ]` item. Once all items are checked, edits block again — forcing a fresh task list per request. The task-list file itself is exempt. |
| 2 | **No pushes to main** | `git push … main/master` is blocked in any shell command. Feature branches are unaffected. |
| 3 | **PR changelog** | `gh pr create` is blocked unless the PR body contains a `Changelog:` section or the branch diff modifies a CHANGELOG file. |
| 4 | **Destructive-command guard** | Blocks only *destructive* CLI operations — non-destructive mutations (`kubectl apply`, `terraform apply`, `helm upgrade`, `az … create/update`, DB inserts, `curl` POST/PUT/PATCH, `ssh`) are allowed. Blocked: `kubectl delete/drain`, `helm uninstall/rollback`, `terraform/tofu destroy`, `pulumi destroy`, `az`/`aws`/`gcloud` delete/terminate/purge, DB `drop/delete/truncate/flushall`, remote `curl` DELETE (localhost exempt), and `git push --force`. |
| 5 | **MCP mutation guard** | MCP tools bypass the shell, so they're matched by name: GitHub and Azure/azmcp MCP tools with mutation verbs (`_create`, `_update`, `_delete`, `_merge`, …) are blocked; read-only tools (`_get`, `_list`, `_search`, …) pass. |
| 6 | **Settings tamper guard** | Blocks the agent from weakening its own gates: edits to `opencode.json` / `~/.config/opencode/*`, and `opencode auth|config|permission` or `--auto` invocations. Permissions can only be changed manually by the user. |
| 7 | **Feature-branch workflow** | When the repo is on `main`/`master`, edit tools and history-changing git commands (`commit`, `merge`, `rebase`, `cherry-pick`, `revert`, `apply`, `am`, `reset`, `restore`, `stash pop`) are blocked with a prompt to create a feature branch first. Read-only commands, branch creation, non-git workspaces, and task-list edits are unaffected. |

## Overrides

Hooks can't read chat intent, so overrides are explicit and auditable:

- **Destructive commands:** append `# allow-live` to the command, or set `WORKFLOW_GUARD_ALLOW_LIVE=1`.
- **MCP mutations:** only `WORKFLOW_GUARD_ALLOW_LIVE=1` (MCP calls carry no command string).
- **Everything else:** no override — by design.

## Install

OpenCode auto-loads plugins from these directories at startup — just copy the file:

```bash
# Project-level (per repo)
mkdir -p .opencode/plugins
cp workflow-guard.ts .opencode/plugins/

# Global (all projects)
mkdir -p ~/.config/opencode/plugins
cp workflow-guard.ts ~/.config/opencode/plugins/
```

Alternatively, if published to npm, reference it in `opencode.json`:

```json
{ "plugin": ["opencode-workflow-guard"] }
```

## Recommended companion config

Pair with opencode's native permission config in `opencode.json` for defense in depth (e.g. `"permission": { "edit": "ask", "bash": { "git push *": "deny" } }`). See https://opencode.ai/docs/permissions/.

## Test

```bash
node test.mjs   # Node >= 22.18 (runs .ts directly); or `bun test.mjs`
```

## Limitations

- Command matching is regex-based — obfuscated commands (`echo "kubectl delete …" | bash`) can evade it. For hard guarantees, pair with environment isolation (no production credentials in agent environments).
- The task gate enforces that a list exists, not that tasks are well-formed.

## License

MIT
