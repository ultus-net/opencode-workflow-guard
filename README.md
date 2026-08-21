# opencode-workflow-guard

A plugin for [OpenCode](https://opencode.ai) that enforces workflow discipline, agent focus, and safety boundaries through **deterministic hooks** — not prompt rules that LLMs can ignore.

Ported and enhanced from [cline-workflow-guard](https://github.com/ultus-net/cline-workflow-guard). This plugin integrates with **OpenCode's native todo system** (`todowrite` / `GET /session/:id/todo`), enforces single-task focus, and provides workspace boundary protection.

---

## Documentation Tree

```
opencode-workflow-guard/
├── workflow-guard.ts          # Core server plugin (tool hooks, task gate, guardrails)
├── workflow-guard-ui.ts       # Visual TUI companion (registers status indicator)
├── package.json               # Package configuration & test scripts
├── tsconfig.json              # Strict TypeScript configuration
├── test.mts                   # In-memory unit tests
├── test-e2e.mts               # Live OpenCode runtime & install tests
└── docs/                      # Detailed documentation
    ├── installation.md        # Complete install options & companion permissions
    ├── policies.md            # In-depth policy reference, lifecycle rules & overrides
    ├── troubleshooting.md     # 8-point error diagnosis and resolution guide
    └── testing.md             # Test suite architecture and execution guide
```

---

## Summary of Enforced Policies

| # | Policy | Summary |
|---|---|---|
| **2** | **No Pushes to Main** | `git push … main/master` is hard-blocked, including refspecs (`HEAD:main`, `feature:main`, `:main`) and forced refspecs (`+main`). Git global flags (`-C`, `--git-dir`) are parsed before matching. |
| **3** | **PR Changelog** | `gh pr create` requires a `Changelog:` section in the PR body or a CHANGELOG file in the diff. |
| **4** | **Destructive CLI Guard** | Blocks destructive operations (`kubectl delete`, `terraform destroy`, `helm uninstall`, `az/aws/gcloud delete`, `docker rm/prune`, database `drop/truncate`, `rm -rf`, `git clean`, `gh repo delete`, `curl DELETE`, `git push --force`, `prisma migrate reset`). |
| **5** | **MCP Mutation Guard** | Mutating GitHub & Azure DevOps MCP tools (`create`, `delete`, `merge`, …) are blocked; read-only tools pass. Server-name tokens are split on all non-alphanumerics (`azure-devops`, `gh` aliases match). |
| **6** | **Settings Tamper Guard** | Prevents the agent from editing `opencode.json[c]`, `~/.config/opencode/*`, `.opencode/*`, or the guard's own plugin files — via shell **or** the edit tools. Quote-concatenation and glob evasion are normalized before matching. Read-only access (`cat`, `grep`) is allowed; only modifications trigger. |
| **7** | **Feature-Branch Workflow** | On `main`/`master`, edits and history-changing git commands (`commit`, `merge`, `rebase`, `update-ref`, `filter-branch`, `branch -D`, …) are blocked until a feature branch is created. Git `-C`/`--git-dir` are parsed so the correct repo's branch is checked. |
| **8** | **Workspace Boundary Guard** | Blocks file tools (`edit`, `write`, `apply_patch`) **and** shell mutations (redirection `>`, `tee`, `sed -i`, `cp`/`mv`, `git apply`) from escaping the workspace root via `../` path traversal. |
| **9** | **Script-Laundering Guard** | Content written via `edit`/`write`/`apply_patch` is scanned for destructive patterns, so `write deploy.sh` → `bash deploy.sh` cannot smuggle blocked commands. |
| **10** | **Post-Edit Verification** | After edits, runs `npm test` (or `WORKFLOW_GUARD_VERIFY`) in the background; blocks "all done" todowrite while verification fails. |
| **11** | **Secret-Content Scan** | Blocks write payloads containing AWS keys, private keys, GitHub tokens, LLM keys, Google/Slack tokens, or env-style assignments. |
| **12** | **Shell Env Scrub** | Sensitive vars (`AWS_*`, `OPENAI*`, `KUBE*`, `GH_/GITHUB_*`, etc.) are emptied in agent shells via `shell.env`; the agent cannot carry live credentials by default. |
| **13** | **Command-Channel Audit** | Slash commands (`command.executed`) are journaled to the audit file so agents cannot run hidden work through user-facing channels. |
| **14** | **Audit Trail** | Every block/allow decision is appended to `~/.local/state/opencode/workflow-guard/workflow-guard.jsonl` (durable). |
| **15** | **Compaction Focus Hook** | Injects the active sequential task list into `experimental.session.compacting` context. |
| **16** | **TUI Visual Feedback** | Companion TUI plugin (`workflow-guard-ui.ts`) registers status indicator feedback in the OpenCode interface. |

For detailed rule descriptions and overrides, see [docs/policies.md](docs/policies.md).

---

## Quick Install

```bash
# Server plugin (required) — global example
mkdir -p ~/.config/opencode/plugins
cp workflow-guard.ts ~/.config/opencode/plugins/

# Optional TUI badge (do NOT put this in plugins/)
mkdir -p ~/.config/opencode/ui
cp workflow-guard-ui.ts ~/.config/opencode/ui/workflow-guard-ui.tsx
```

Then add `~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "file:///absolute/path/to/.config/opencode/ui/workflow-guard-ui.tsx"
  ]
}
```

*Requires OpenCode >= 1.18.* See [docs/installation.md](docs/installation.md) for full configuration options.

---

## Quick Verification

```bash
npm run typecheck    # Strict TypeScript check (0 errors)
npm test             # Run unit tests (node test.mts)
npm run test:install # Run live OpenCode runtime install test (node test-e2e.mts)
npm run test:all     # Run full verification suite
```

See [docs/testing.md](docs/testing.md) for test details.

---

## CI / CD

GitHub Actions enforces the same gates the plugin enforces on contributors:

| Workflow | Trigger | What runs |
|---|---|---|
| **CI** | PR + push to `main` | Typecheck → unit tests (Node 20/22/24) → e2e plugin-load → `npm audit` → CHANGELOG-updated gate |
| **Release** | push `v*` tag | Re-verify → tag↔version match → `npm publish --provenance` → GitHub release |

Branch protection on `main` should require the `Typecheck`, `Unit tests`, `E2E`, `npm audit`, and (for PRs) `Changelog updated` checks. The `e2e` job gracefully skips when no `opencode` binary is present, so it never blocks merge.

---

## License

MIT
