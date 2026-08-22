# opencode-workflow-guard

The purpose of this plugin is to hold AI agents accountable and maximize developer experience (DX) as OpenCode acts as your pair programmer. It enforces workflow discipline, agent focus, and safety boundaries through **deterministic hooks** - not prompt rules that LLMs can ignore.

This plugin integrates with **OpenCode's native todo system** (`todowrite` / `GET /session/:id/todo`), enforces structured task lifecycle, requires verification evidence before completion, and provides workspace boundary protection.

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
| **1** | **Task Gate & Lifecycle** | File mutations (`edit`, `write`, `apply_patch`, shell redirects/copy/in-place edits) are blocked until an active todo item exists via `todowrite`. Enforces structured task lifecycle (no silent deletion) and requires all tasks to be completed before finalization, with flexible task ordering.
| **2** | **No Pushes to Main** | `git push ... main/master` is hard-blocked, including refspecs (`HEAD:main`, `feature:main`, `:main`) and forced refspecs (`+main`). Git global flags (`-C`, `--git-dir`) are parsed before matching. |
| **3** | **PR Changelog & Changesets** | `gh pr create` and `az repos pr create` require a `Changelog:` section in the PR description, a CHANGELOG file in the diff, or a `.changeset/*.md` fragment file (Changesets workflow). |
| **4** | **Destructive CLI Guard** | Blocks destructive operations (`kubectl delete`, `terraform destroy`, `helm uninstall`, `az/aws/gcloud delete`, `docker rm/prune`, database `drop/truncate`, `rm -rf`, `git clean`, `gh repo delete`, `curl DELETE`, `git push --force`, `prisma migrate reset`). Override requires explicit user environment flag (`WORKFLOW_GUARD_ALLOW_LIVE=1`). |
| **5** | **MCP Mutation Guard** | Mutating GitHub & Azure DevOps MCP tools (`create`, `delete`, `merge`, ...) are blocked; read-only tools pass. Server-name tokens are split on all non-alphanumerics (`azure-devops`, `gh` aliases match). |
| **6** | **Settings Tamper Guard** | Prevents the agent from editing `opencode.json[c]`, `~/.config/opencode/*`, `.opencode/*`, or the guard's own plugin files via shell **or** the edit tools. Quote-concatenation and glob evasion are normalized before matching. Read-only access (`cat`, `grep`) is allowed; only modifications trigger. |
| **7** | **Feature-Branch Workflow** | On `main`/`master`, edits and history-changing git commands (`commit`, `merge`, `rebase`, `update-ref`, `filter-branch`, `branch -D`, ...) are blocked until a feature branch is created. Git `-C`/`--git-dir` are parsed so the correct repo's branch is checked. |
| **8** | **Workspace Boundary Guard** | Blocks file tools (`edit`, `write`, `apply_patch`) **and** common shell mutations (redirection `>`, `tee`, `sed -i`, `cp`/`mv`, `touch`, `mkdir`, `rm`, `ln`, `git apply`) from escaping the workspace root via `../` path traversal or symlinks. External repository git writes are also confined. |
| **9** | **Script-Laundering Guard** | Content written via `edit`/`write`/`apply_patch` is scanned for destructive patterns, so `write deploy.sh` -> `bash deploy.sh` cannot smuggle blocked commands. |
| **10** | **Evidence-Based Verification** | Runs `WORKFLOW_GUARD_VERIFY`, project `verifyCommand`, or auto-detected `npm test` in an isolated, scrubbed environment with timeout controls and token-efficient output snipping. Binds evidence to git commit and working tree state, and restores durable pass cache across session restarts. |
| **11** | **Secret-Content Scan** | Blocks edit payloads and recognized shell file mutations containing AWS keys, private keys, GitHub tokens, LLM keys, Google/Slack tokens, or env-style assignments. |
| **12** | **Shell Env Scrub** | Sensitive vars (`AWS_*`, `OPENAI*`, `KUBE*`, `GH_/GITHUB_*`, etc.) are emptied in agent shells via `shell.env`; the agent cannot carry live credentials by default. |
| **13** | **Command-Channel Audit** | Slash commands (`command.executed`) are journaled to the audit file so agents cannot run hidden work through user-facing channels. |
| **14** | **Audit Trail** | Every block/allow decision is appended to `~/.local/state/opencode/workflow-guard/workflow-guard.jsonl` (durable) with parent/subagent attribution metadata. |
| **15** | **Compaction Focus Hook** | Injects active tasks with session/subagent attribution into `experimental.session.compacting` context. |
| **16** | **TUI Visual Feedback** | Companion TUI plugin (`workflow-guard-ui.ts`) registers status indicator feedback in the OpenCode interface and emits toasts on blocked actions. |
| **17** | **Secret-File Read Block & Schema Masking** | Blocks reading `.env*`, `*.pem`, `*.key`, `id_rsa`, `id_ed25519`, `kubeconfig`, `credentials.json`, or service account keys via the `read` tool or shell commands (`cat`, `less`, `grep`). On `.env*` reads, provides a safe variable schema mask with values redacted to `********`. |
| **18** | **Interpreter Inline Evasion** | Decodes and scans inline interpreter scripts (`python -c`, `node -e`, `perl -e`, `ruby -e`, `powershell -enc`, `base64 | sh`) for destructive commands or settings tampering. |
| **19** | **Conflict-Free Pre-Flight** | Verifies via `git merge-tree` that the branch has zero merge conflicts with the base branch (`origin/main`) before allowing PR creation or final task handoff. |
| **20** | **Merged Branch & Freshness** | Blocks pushing to branches already merged or associated with closed PRs (GitHub & Azure DevOps), and blocks creating fresh branches when the local base is behind remote. |
| **21** | **Documentation Synchronization** | Verifies that relevant documentation (`README.md` or `docs/`) is reviewed and updated when introducing new features, tools, or policy changes before opening a PR. |
| **22** | **Non-Interactive Shell & TTY Hang Guard** | Blocks interactive terminal tools (`nano`, `vim`, `less`, `top`, `sudo`, `git rebase -i`, `npm init` / `apt-get` without `-y`) to prevent AI agents from hanging waiting on TTY stdin. Emits native OS desktop notifications on blocks and verification completions. |
| **23** | **Package Supply-Chain & Dependency Hygiene** | Blocks destructive package commands (`npm audit fix --force`, global unversioned package installs `npm i -g`, direct subshell `npm publish`, and `pip --force-reinstall`) to prevent breaking downgrades and machine state pollution. |

For detailed rule descriptions and overrides, see [docs/policies.md](docs/policies.md).

---

## Quick Install

### Option A: npm Package Configuration (Recommended)

Add to your project's `opencode.json` or global `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-workflow-guard"
  ]
}
```

### Option B: Local Plugin Copy

```bash
# Server plugin - global example
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

## Custom Tools

The plugin registers custom tools available in OpenCode sessions:
- `guard_status`: Inspect active guardrails, current branch protection, verification status, and review approval.
- `guard_audit`: View recent audit log entries recorded in `~/.local/state/opencode/workflow-guard/workflow-guard.jsonl`.
- `guard_why`: Simulate and explain whether a specific tool call or command would be blocked.
- `record_review`: Record a secondary reviewer subagent's approval or critique across the 5 core review axes.

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
| **CI** | PR + push to `main` | Typecheck -> unit tests (Node 20/22/24) -> e2e plugin-load -> `npm audit` -> CHANGELOG-updated gate |
| **Release** | push `v*` tag | Re-verify -> tag/version match -> `npm publish --provenance` -> GitHub release |

Branch protection on `main` should require the `Typecheck`, `Unit tests`, `E2E`, `npm audit`, and (for PRs) `Changelog updated` checks. The `e2e` job gracefully skips when no `opencode` binary is present, so it never blocks merge.

---

## Acknowledgements

`opencode-workflow-guard` draws design inspiration and best practices from projects in the broader OpenCode community. See [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md) for full community project credits.

---

## License

MIT
