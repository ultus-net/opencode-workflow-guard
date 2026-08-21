# opencode-workflow-guard

A plugin for [OpenCode](https://opencode.ai) that enforces workflow discipline, agent focus, and safety boundaries through **deterministic hooks** — not prompt rules that LLMs can ignore.

Ported from [cline-workflow-guard](https://github.com/ultus-net/cline-workflow-guard), this port integrates with **OpenCode's native todo system** (`todowrite` / `GET /session/:id/todo`), enforces single-task focus, and provides workspace boundary protection.

---

## Documentation Tree

```
opencode-workflow-guard/
├── workflow-guard.ts          # Core plugin source (OpenCode V1 PluginModule)
├── package.json               # Package configuration & test scripts
├── tsconfig.json              # Strict TypeScript configuration
├── test.mts                   # 87 in-memory unit tests
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
| **1** | **Task Breakdown & Lifecycle** | File edits (`edit`, `write`, `apply_patch`) are blocked without an active item in OpenCode's native todo list (`todowrite`). Enforces single `in_progress` focus, sequential completion order, and prevents silent task deletion. Subagents inherit parent tasks. |
| **2** | **No Pushes to Main** | `git push … main/master` is hard-blocked across all shell commands. |
| **3** | **PR Changelog** | `gh pr create` requires a `Changelog:` section in the PR body or a CHANGELOG file in the diff. |
| **4** | **Destructive CLI Guard** | Blocks destructive operations (`kubectl delete`, `terraform destroy`, `helm uninstall`, `az/aws/gcloud delete`, database `drop/truncate`, `curl DELETE`, `git push --force`). |
| **5** | **MCP Mutation Guard** | Mutating GitHub & Azure DevOps MCP tools (`_create`, `_delete`, `_merge`, …) are blocked; read-only tools pass. |
| **6** | **Settings Tamper Guard** | Prevents the agent from editing `opencode.json`, `~/.config/opencode/*`, or running `opencode auth|config`. |
| **7** | **Feature-Branch Workflow** | On `main`/`master`, edits and history-changing git commands are blocked until a feature branch is created. |
| **8** | **Workspace Boundary Guard** | Blocks file tools (`edit`, `write`, `apply_patch`) from escaping the workspace root via `../` path traversal. |
| **9** | **Compaction Focus Hook** | Injects the active sequential task list into `experimental.session.compacting` context to maintain focus across long sessions. |
| **10** | **TUI Visual Feedback** | Emits real-time warning toasts via `tui.showToast` when a policy triggers. |

For detailed rule descriptions and overrides, see [docs/policies.md](docs/policies.md).

---

## Quick Install

Copy `workflow-guard.ts` into your project or global OpenCode plugin directory:

```bash
# Project-level (per repo)
mkdir -p .opencode/plugins
cp workflow-guard.ts .opencode/plugins/

# Global (all projects)
mkdir -p ~/.config/opencode/plugins
cp workflow-guard.ts ~/.config/opencode/plugins/
```

*Requires OpenCode >= 1.18.* See [docs/installation.md](docs/installation.md) for full configuration options.

---

## Quick Verification

```bash
npm run typecheck    # Strict TypeScript check (0 errors)
npm test             # Run 87 unit tests (node test.mts)
npm run test:install # Run live OpenCode runtime install test (node test-e2e.mts)
npm run test:all     # Run full verification suite
```

See [docs/testing.md](docs/testing.md) for test details.

---

## Documentation Links

- **[Installation Guide](docs/installation.md)** — Project vs global setup, companion configs.
- **[Policies & Overrides](docs/policies.md)** — Comprehensive breakdown of all 10 policies and `# allow-live` overrides.
- **[Troubleshooting Guide](docs/troubleshooting.md)** — Common error messages, root causes, and fixes.
- **[Testing Guide](docs/testing.md)** — Unit and live runtime test suite reference.

---

## License

[MIT](LICENSE)
