# Testing & Verification Guide

This repository includes both in-memory unit tests and live runtime installation tests.

---

## Test Commands

### 1. Build & Typecheck
Runs strict TypeScript compilation checks across all source and test files:
```bash
npm run typecheck   # or: npm run build
```

### 2. In-Memory Unit Tests
Runs the 87 unit tests covering all 10 guard policies, lifecycle validation, subagent parent-chain resolution, and path boundary checks:
```bash
npm test            # runs node test.mts (Node >= 22.18) or bun test.mts
```

### 3. Live OpenCode Runtime & Install Tests
Spawns an isolated temporary workspace, copies `workflow-guard.ts` into `.opencode/plugins/`, and runs live `opencode run` sessions to verify that OpenCode's real runtime loader discovers, loads, and executes the plugin hooks:
```bash
npm run test:install # runs node test-e2e.mts
```

### 4. Full Verification Suite
Runs typecheck, unit tests, and live runtime installation tests in sequence:
```bash
npm run test:all
```

---

## Test Suite Coverage

| Test Group | Checks |
|---|---|
| **Policy 1: Native Todo Gate** | Verifies edits are blocked when todos are missing, completed, or cancelled, and allowed when `pending` or `in_progress` todos exist. |
| **Policy 1: Lifecycle & Focus** | Verifies the single `in_progress` focus rule, top-down sequential order, and silent deletion prevention. |
| **Policy 1: Subagent Inheritance** | Verifies subagents walk up the `parentID` hierarchy to inherit parent/grandparent todos, and handles cycle termination. |
| **Policies 2 & 7: Git Branches** | Verifies push blocking on `main`/`master`, feature-branch editing allowances, and git commit gates. |
| **Policy 3: PR Changelog** | Verifies `gh pr create` requires a changelog in body or diff. |
| **Policy 4: Live Commands** | Verifies destructive CLI command blocking across Kubernetes, Terraform, Helm, cloud CLIs, and databases, plus `# allow-live` overrides. |
| **Policy 5: MCP Mutations** | Verifies GitHub/Azure mutating MCP tools are blocked while read-only tools pass. |
| **Policy 6: Settings Tamper** | Verifies protection of `opencode.json`, `~/.config/opencode/*`, and `opencode auth`. |
| **Policy 8: Workspace Boundary** | Verifies path traversal (`../`) and absolute path escape protection in `edit`, `write`, and `apply_patch`. |
| **Compaction & TUI Feedback** | Verifies active task injection in `experimental.session.compacting` and toast emission on blocked calls. |
| **Export Shape & Loader Contract** | Verifies V1 `PluginModule` `{ id, server }` structure and `output.args` hook contract. |
