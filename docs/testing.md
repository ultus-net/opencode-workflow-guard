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
Runs the comprehensive unit and adversarial tests covering all guard policies, lifecycle validation, subagent parent-chain resolution, privilege-isolated verification, and path/symlink boundary checks:
```bash
npm test            # runs node test.mts (Node >= 22.18) or bun test.mts
```

### 3. OpenCode Runtime & Install Tests
Packs the npm tarball, installs it into an isolated project to verify the modular entrypoint resolves, then copies the server source into an isolated `.opencode/workflow-guard-source/` directory and exposes its `WorkflowGuard` plugin function through an explicitly registered `.opencode/plugins/` adapter. A provider-free config probe verifies OpenCode resolves that local plugin before the opt-in model-driven `opencode run` probes exercise its hooks:
```bash
npm run test:install # package install + provider-free OpenCode loader check
WORKFLOW_GUARD_LIVE_E2E=1 npm run test:install # also run model-driven policy probes with OpenCode's most recently selected model
```
Package and loader checks remain deterministic. Live probes explicitly select the first entry in OpenCode's persisted recent-model state (`${XDG_STATE_HOME:-~/.local/state}/opencode/model.json`) instead of silently inheriting the configured default model. Set `WORKFLOW_GUARD_LIVE_MODEL=provider/model` to override that selection; provider credentials still come from the normal OpenCode environment. If the selected model provider rejects a live prompt before guard behavior can run because credits, rate limits, capacity, or overload make the provider unavailable, that live case is reported as unavailable rather than as a guard failure. Other live-runtime failures still fail the suite.

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
| **Policy 1: Lifecycle** | Verifies flexible task completion, concurrent `in_progress` tasks (single-focus rule removed), and silent deletion prevention. |
| **Policy 1: Subagent Inheritance** | Verifies subagents walk up the `parentID` hierarchy to inherit parent/grandparent todos, and handles cycle termination. |
| **Policies 2 & 7: Git Branches** | Verifies push blocking on `main`/`master`, feature-branch editing allowances, and git commit gates. |
| **Policy 3: PR Changelog** | Verifies `gh pr create` requires a changelog in body or diff. |
| **Policy 4: Live Commands** | Verifies destructive CLI command blocking across Kubernetes, Terraform, Helm, cloud CLIs, and databases, plus user-set `WORKFLOW_GUARD_ALLOW_LIVE=1` override. |
| **Policy 5: MCP Mutations** | Verifies GitHub/Azure mutating MCP tools are blocked while read-only tools pass. |
| **Policy 6: Settings Tamper** | Verifies protection of `opencode.json`, `~/.config/opencode/*`, and `opencode auth`. |
| **Policy 8: Workspace Boundary** | Verifies path traversal (`../`), symlinks, and absolute path escape protection in `edit`, `write`, `apply_patch`, and shell mutations. |
| **Policy 10: Evidence Verification** | Verifies isolated verification execution, timeout handling, scrubbed environment, and finalization gating on fresh passing tests. |
| **Adversarial Invariants** | Verifies defense against compound shell mutations, symlink escapes, chained git normalization, verify script abuse, and external repo mutations. |
| **Audit & Permission Events** | Verifies the typed `permission.ask` hook, permission replies, and command journaling in the audit trail. |
| **Completion Claims & Tool Honesty** | Verifies the claims-vs-evidence detector (missing/failing/stale/fresh states), `experimental.text.complete` journaling, and `tool.definition` enrichment idempotence. |
| **Compaction & TUI Feedback** | Verifies active task injection in `experimental.session.compacting`, session-scoped dynamic last-block badge state, guard-only toast sourcing, and clean error propagation. |
| **Runtime Instance Isolation** | Verifies concurrent plugin instances keep workspace root and SDK client state isolated via `runWithRuntimeState`. |
| **Modular Exports & Shape** | Verifies V1 `PluginModule` `{ id, server }` structure, modular policy imports, and `output.args` hook contract. |
