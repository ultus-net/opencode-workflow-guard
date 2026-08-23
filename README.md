# opencode-workflow-guard

OpenCode plugin enforcing workflow discipline, agent focus, and deterministic safety boundaries through **hard plugin hooks** — not prompt instructions that LLMs can ignore.

Integrates with OpenCode's native todo system (`todowrite`), prevents accidental destructive actions, gates protected branches, enforces testing evidence before task finalization, and stops secret leakage.

---

## Quick Start

### 1. Installation

Add to your project's `opencode.json` or global `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-workflow-guard"
  ]
}
```

*Requires OpenCode >= 1.18.* See [docs/installation.md](docs/installation.md) for local manual installation and TUI companion badge setup.

### 2. Verification

```bash
npm run typecheck    # Strict TypeScript check (0 errors)
npm test             # Run 320+ unit and adversarial tests
npm run test:all     # Run full verification suite (typecheck + unit + live e2e)
```

---

## Repository Structure

```
opencode-workflow-guard/
├── src/                       # Production plugin sources
│   ├── workflow-guard.ts      # Server plugin entrypoint (hook orchestrator & public exports)
│   ├── workflow-guard-ui.ts   # TUI companion prompt badge
│   ├── policies/              # Per-policy implementations (task gate, git, secrets, shell-safety, ...)
│   └── lib/                   # Engine services (state, verify, audit, review, worktree, utils, types)
├── test/                      # Test suites
│   ├── test.mts               # 320+ in-memory unit & adversarial tests
│   └── test-e2e.mts           # npm tarball resolution + live runtime OpenCode loader tests
├── docs/                      # In-depth documentation & guides
│   ├── installation.md        # Full setup options, worktrees & permissions
│   ├── policies.md            # Detailed 23-policy reference & overrides
│   ├── troubleshooting.md     # Error diagnosis & bypass explanations
│   └── testing.md             # Test architecture & coverage matrix
├── .changeset/                # Fragment-based versioning & release changelogs
├── ACKNOWLEDGEMENTS.md        # Open-source community credits & inspirations
├── CONTRIBUTING.md            # Development guide, test patterns & PR rules
├── CHANGELOG.md               # Version history
└── SECURITY.md                # Vulnerability disclosure policy
```

---

## Summary of Enforced Policies

| # | Policy Group | Summary |
|---|---|---|
| **1** | **Task Gate & Lifecycle** | Gates file mutations on active `todowrite` tasks. Prevents silent task deletion; allows flexible completion order. |
| **2 & 7** | **Branch Protection** | Blocks direct edits & commits on `main`/`master`. Hard-blocks `git push ... main` and forced refspecs. |
| **3** | **PR Changelog & Changesets** | Requires PRs to include changesets (`.changeset/*.md`), `CHANGELOG.md` updates, or a `Changelog:` body section. |
| **4 & 9** | **Destructive CLI & Laundering** | Blocks destructive infrastructure, database, and system mutations unless overridden by user environment (`WORKFLOW_GUARD_ALLOW_LIVE=1`). Scans script payloads for smuggled commands. |
| **5** | **MCP Mutation Guard** | Blocks mutating GitHub & Azure DevOps MCP tools while allowing read-only inspection tools. |
| **6** | **Settings Tamper Guard** | Blocks agent modification of `opencode.json`, `.opencode/*`, or the guard's own plugin files. |
| **8** | **Workspace Boundary Guard** | Confines file mutations and shell redirects strictly within the project workspace root (symlink & `../` escape safe). |
| **10** | **Evidence-Based Verification** | Runs test verification before final task completion. Binds freshness to git state with token-efficient output snipping. |
| **11, 12, 17** | **Secret Protection & Masking** | Scans file payloads for API keys, scrubs sensitive env vars in agent subshells, and provides safe redacted `.env` variable schema masks (`KEY=********`). |
| **13 & 14** | **Audit Trail & Attribution** | Durable JSONL audit logging (`~/.local/state/opencode/workflow-guard/workflow-guard.jsonl`) with subagent hierarchy breadcrumbs. |
| **15 & 16** | **Compaction & TUI Feedback** | Preserves active task plans across context compactions; emits real-time TUI warning toasts and native desktop alerts. |
| **18** | **Interpreter Inline Evasion** | Scans inline scripts (`python -c`, `node -e`, `base64 | sh`) for smuggled live commands or config tampering. |
| **19 & 20** | **Pre-Flight Conflicts & Freshness** | Verifies clean `git merge-tree` mergeability and checks local base branch freshness before opening PRs. |
| **21** | **Documentation Synchronization** | Verifies documentation is updated when introducing new public features or policies. |
| **22** | **TTY Hang Guard** | Blocks interactive editors (`vim`, `nano`), pagers (`less`), and commands missing non-interactive flags (`npm init` without `-y`). |
| **23** | **Package Supply-Chain Hygiene** | Blocks destructive `npm audit fix --force`, global unversioned installs (`npm i -g`), and direct CLI `npm publish`. |

👉 **For complete policy specifications and override rules, see [docs/policies.md](docs/policies.md).**

---

## Custom Tools Registered in OpenCode

* `guard_status`: Inspect active guardrails, current branch protection, and verification/review status.
* `guard_audit`: View recent audit log entries recorded in `workflow-guard.jsonl`.
* `guard_why`: Simulate and explain whether a specific tool call or command would be blocked.
* `record_review`: Record secondary reviewer subagent approval or critique across the 5 core review axes.
* `guard_worktree_create`: Create an isolated git worktree (with shared `node_modules` symlink) for concurrent subagent execution; rejects invalid and protected branch names.
* `guard_worktree_cleanup`: Snapshot-commit remaining changes and remove an isolated worktree directory.

---

## Documentation & Community

* [Installation Guide](docs/installation.md)
* [Policies & Overrides Reference](docs/policies.md)
* [Troubleshooting Guide](docs/troubleshooting.md)
* [Testing Guide](docs/testing.md)
* [Contributing Guide](CONTRIBUTING.md)
* [Acknowledgements & Ecosystem Credits](ACKNOWLEDGEMENTS.md)
* [Security Policy](SECURITY.md)

---

## License

[MIT](LICENSE)
