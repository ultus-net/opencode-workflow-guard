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

For the optional TUI badge, configure `"opencode-workflow-guard"` in `tui.json` as well. Do not use `opencode-workflow-guard/ui`; npm parses that unscoped slash form as GitHub shorthand rather than a package export, which can trigger Git credential prompts. The package exposes OpenCode's native `./server` and `./tui` entrypoints so the package root is sufficient in both configs.

### 2. Verification

```bash
npm run typecheck    # Strict TypeScript check (0 errors)
npm test             # Run 415+ unit and adversarial tests
npm run test:all     # Typecheck + unit + install/load checks
WORKFLOW_GUARD_LIVE_E2E=1 npm run test:install # Also run model-driven OpenCode policy probes
```

---

## Core Guardrails Overview

The plugin enforces **24 deterministic policy rules** across four main pillars:

* **Branch & History Protection:** Enforces feature-branch workflows (blocks edits/commits on `main`/`master`), hard-blocks direct or forced pushes to protected branches, enforces mergeability pre-flight checks, and requires PR changelogs / changesets.
* **Task & Verification Discipline:** Gates file mutations on active `todowrite` tasks with subagent inheritance, blocks silent task deletion, enforces fresh test verification evidence before task completion, and journals completion claims vs. verification mismatches.
* **Secrets & Workspace Confinement:** Confines edit tools and recognized shell/git mutations within the workspace root (including symlink and `../` escape checks), scrubs sensitive environment variables in agent subshells, and redacts `.env` reads with safe schema masks. Arbitrary executables are not OS-sandboxed; use containers or filesystem isolation when hard confinement is required.
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
| `guard_next_tasks` | Load `TODO.md`, or fall back to repository roadmap/plan/task Markdown when deciding what to work on next |
| `guard_status` | Inspect active guardrails, current branch protection, and verification/review status |
| `guard_why` | Simulate and explain whether a specific tool call or command would be blocked |
| `guard_audit` | View recent audit log entries recorded in `workflow-guard.jsonl` |
| `guard_review_rubric` | Generate the 5-axis secondary review rubric for the current branch diff |
| `record_review` | Record a secondary reviewer subagent's verdict evaluated against the review rubric |
| `guard_worktree_create` | Create an isolated git worktree directory for concurrent subagent execution |
| `guard_worktree_cleanup` | Snapshot-commit remaining changes and remove an isolated worktree directory |
| `learning_profile` | Inspect the evidence-based local learner profile (when learning mode is enabled) |
| `learning_checkpoint` | Rank high-value Socratic opportunities while respecting the session intervention budget |
| `learning_record` | Persist concise evidence observed during a real learning interaction |
| `project_memory_search` | Search current durable project knowledge in the local index |
| `project_memory_record` | Record a durable fact, decision, constraint, or lesson with provenance |
| `project_memory_export` | Explicitly promote selected records to repo-local human-readable JSONL |
| `project_memory_import` | Import promoted repo-local knowledge into the local index |

### Experimental Socratic Learning

Learning mode is opt-in and advisory: it never blocks tool calls or weakens deterministic guardrails. Enable it by setting `WORKFLOW_GUARD_LEARNING=1` in the user environment before OpenCode starts. Project configuration cannot enable learning or expose the global profile on its own. `maxLearningInterventions` defaults to 3 per session and can be set to `0` in `.opencode/workflow-guard.json[c]` to suppress checkpoints.

The learner profile is global to the local user and follows the XDG data convention: `$XDG_DATA_HOME/opencode/workflow-guard/learner-profile.json`, or `~/.local/share/opencode/workflow-guard/learner-profile.json` when `XDG_DATA_HOME` is unset. It stores distilled concept evidence, session/project provenance, and progression (`exposed` through `critique`), not conversation transcripts or numeric grades. Unobserved concepts remain unknown rather than being labeled knowledge gaps. Back up or delete this file independently from project repositories as desired.

### Project Memory

Project memory keeps durable working knowledge between sessions without treating conversation history as project truth. Facts, decisions, constraints, and lessons are stored in a local SQLite/FTS5 index under `$XDG_DATA_HOME/opencode/workflow-guard/project-memory/`, or `~/.local/share/opencode/workflow-guard/project-memory/` when `XDG_DATA_HOME` is unset. Git repositories are identified from their common Git directory, so linked worktrees share the same local project index.

The local index is private working memory. Nothing from it is committed automatically. `project_memory_export` promotes only the explicitly selected current record IDs to `.opencode/memory/project-memory.jsonl`, a human-readable portable representation that another clone can import. The plugin adds `.opencode/memory/` to the clone-local `.git/info/exclude` by default; teams that deliberately want to version promoted knowledge can remove that exclusion or force-add the JSONL file. SQLite databases themselves should not be committed.

Memory is supporting context, not authority. Superseded records are excluded from normal retrieval, recording and plugin imports reject content recognized by Workflow Guard's secret detector, and compaction injects at most eight recent current local records. Portable repository records are never injected automatically; they are available through explicit memory search after import. A local record tied to repository paths and a Git commit is omitted from compaction when those paths have committed, staged, or unstaged changes after that commit. Always prefer current repository state when it conflicts with historical memory.

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
