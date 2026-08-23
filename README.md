# opencode-workflow-guard

[![npm](https://img.shields.io/npm/v/opencode-workflow-guard.svg)](https://www.npmjs.com/package/opencode-workflow-guard)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Tests](https://img.shields.io/badge/tests-415%2B%20passing-brightgreen.svg)](test/test.mts)

OpenCode plugin enforcing workflow discipline, agent focus, and deterministic safety boundaries through **hard plugin hooks**, not prompt instructions that LLMs can ignore.

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

*Requires OpenCode >= 1.18.* See [docs/installation.md](docs/installation.md) for full setup options and TUI companion badge configuration.

### 2. Verification

```bash
npm run typecheck    # Strict TypeScript check (0 errors)
npm test             # Run 415+ unit and adversarial tests
npm run test:all     # Run full verification suite (typecheck + unit + live e2e)
```

---

## Core Guardrails Overview

The plugin enforces **24 deterministic policy rules** across four main pillars:

* **Branch & History Protection:** Enforces feature-branch workflows (blocks edits/commits on `main`/`master`), hard-blocks direct or forced pushes to protected branches, enforces mergeability pre-flight checks, and requires PR changelogs / changesets.
* **Task & Verification Discipline:** Gates file mutations on active `todowrite` tasks with subagent inheritance, blocks silent task deletion, enforces fresh test verification evidence before task completion, and journals completion claims vs. verification mismatches.
* **Secrets & Workspace Confinement:** Confines all edits, shell redirects, and git operations within the workspace root (symlink & `../` escape safe), scrubs sensitive environment variables in agent subshells, and redacts `.env` reads with safe schema masks.
* **Destructive CLI & Environment Safety:** Intercepts destructive cloud/database/infrastructure commands, stops script laundering and interpreter evasion, blocks TTY hangs (`vim`, `nano`, `sudo`), and guards against dangerous package manager flags.

For complete policy specifications and override rules, see [docs/policies.md](docs/policies.md).

---

## Documentation Index

| Guide | Description |
|---|---|
| [**Policy Reference**](docs/policies.md) | Comprehensive specification of all 24 enforced policies, invariants, and override semantics |
| [**Installation & Configuration**](docs/installation.md) | Setup options, global vs. local install, worktree isolation, and project configuration |
| [**Troubleshooting**](docs/troubleshooting.md) | Diagnosing policy blocks, common false positives, and emergency override procedures |
| [**Testing Architecture**](docs/testing.md) | Test harness design, adversarial regression matrix, and CI verification |
| [**Contributing Guide**](CONTRIBUTING.md) | Development workflow, coding conventions, test requirements, and changeset PR rules |
| [**Security Policy**](SECURITY.md) | Vulnerability disclosure policy and threat model |

---

## Custom Tools Registered in OpenCode

| Tool | Purpose |
|---|---|
| `guard_status` | Inspect active guardrails, current branch protection, and verification/review status |
| `guard_why` | Simulate and explain whether a specific tool call or command would be blocked |
| `guard_audit` | View recent audit log entries recorded in `workflow-guard.jsonl` |
| `guard_review_rubric` | Generate the 5-axis secondary review rubric for the current branch diff |
| `record_review` | Record a secondary reviewer subagent's verdict evaluated against the review rubric |
| `guard_worktree_create` | Create an isolated git worktree directory for concurrent subagent execution |
| `guard_worktree_cleanup` | Snapshot-commit remaining changes and remove an isolated worktree directory |

---

## Repository Tree

```
opencode-workflow-guard/
├── src/                       # Production plugin sources
│   ├── workflow-guard.ts      # Server plugin entrypoint (hook orchestrator & public exports)
│   ├── workflow-guard-ui.ts   # Optional TUI companion prompt badge
│   ├── policies/              # Modular policy implementations (task gate, git, secrets, boundary, ...)
│   └── lib/                   # Engine services (state, verify, audit, review, worktree, utils, types)
├── test/                      # Test suites
│   ├── test.mts               # 415+ in-memory unit & adversarial tests
│   └── test-e2e.mts           # npm tarball resolution + live runtime OpenCode loader tests
├── docs/                      # In-depth documentation & guides
│   ├── policies.md            # Complete 24-policy reference & overrides
│   ├── installation.md        # Setup options, worktrees & permissions
│   ├── troubleshooting.md     # Error diagnosis & bypass explanations
│   └── testing.md             # Test architecture & coverage matrix
├── .changeset/                # Fragment-based versioning & release changelogs
├── ACKNOWLEDGEMENTS.md        # Open-source community credits & inspirations
├── CONTRIBUTING.md            # Development guide, test patterns & PR rules
├── CHANGELOG.md               # Version history
└── SECURITY.md                # Vulnerability disclosure policy
```

---

## License

[MIT](LICENSE)
