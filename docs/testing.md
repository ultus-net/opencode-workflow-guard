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
Runs the unit and adversarial tests covering all guard policies, lifecycle validation, subagent parent-chain resolution, privilege-isolated verification, and path/symlink boundary checks:
```bash
npm test            # runs test.mts with isolated XDG state/data (Node >= 22.18)
```

### 3. OpenCode Runtime & Install Tests
Packs the npm tarball into an isolated project to verify the modular entrypoint resolves. It then copies the server source into an isolated `.opencode/workflow-guard-source/` directory. That source's `WorkflowGuard` plugin function is exposed through an explicitly registered `.opencode/plugins/` adapter. A provider-free config probe verifies OpenCode resolves that local plugin before the opt-in model-driven `opencode run` probes exercise its hooks:
```bash
npm run test:install # package install + provider-free OpenCode loader check
WORKFLOW_GUARD_LIVE_E2E=1 npm run test:install # also run model-driven policy probes with OpenCode's most recently selected model
```
Package and loader checks remain deterministic. Live probes explicitly select the first entry in OpenCode's persisted recent-model state (`${XDG_STATE_HOME:-~/.local/state}/opencode/model.json`). They never silently inherit the configured default model. Set `WORKFLOW_GUARD_LIVE_MODEL=provider/model` to override that selection. Provider credentials still come from the normal OpenCode environment. A provider may reject a live prompt before guard behavior can run. That happens when credits, rate limits, capacity, overload, or an unresolvable model make the provider unavailable. Such a case is reported as unavailable rather than as a guard failure. The classifier matches the host's literal `Model unavailable:` error line rather than the bare phrase, so model prose cannot mask a real guard regression. Other live-runtime failures still fail the suite.

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
| **Policy 10: Evidence Verification** | Verifies isolated verification execution, timeout handling, scrubbed environment, and finalization gating on fresh passing tests. A timeout blocks finalization under its own code, and its reason names the limit and the remedy instead of claiming a failing test. |
| **Adversarial Invariants** | Verifies defense against compound shell mutations, symlink escapes, chained git normalization, verify script abuse, and external repo mutations. |
| **Audit & Permission Events** | Verifies the typed `permission.ask` hook, permission replies, and command journaling in the audit trail. |
| **Completion Claims & Tool Honesty** | Verifies the claims-vs-evidence detector (missing/failing/stale/fresh states), `experimental.text.complete` journaling, and `tool.definition` enrichment idempotence. |
| **Compaction & TUI Feedback** | Verifies active task injection in `experimental.session.compacting`, the static TUI badge, guard block warning toasts, and clean error propagation. |
| **Runtime Instance Isolation** | Verifies concurrent plugin instances keep workspace root and SDK client state isolated via `runWithRuntimeState`. |
| **V2 Permission Seat Abstention** | Verifies the simulated seat denies a real finding, abstains on `needs_approval` (`remote_state_unchecked`) instead of denying, never upgrades a configured `ask`, and journals the abstention as `deferred_to_execute_before` with the preserved decision. |
| **V2 Todo Capability** | Verifies the `todowrite` registry probe (`available` / `unavailable` / `unknown`), that an empty history gates only when planning is possible, the once-per-session fail-open warning and audit record, and `todoCapability` in `guard_status`. |
| **Per-Task Completion Evidence** | Verifies a task cannot move to `completed` without a mutation in its own window, that one mutation cannot vouch for several completions, that staggered windows reject a claim whose window saw no work, that mutations before a task became active never count, that `[read-only]` completes freely and is journaled, that the marker can be appended to an already-planned task without tripping the no-silent-deletion rule, that duplicate content cannot hide a new completion, and that `guard_why` reports the same verdict while moving no window. |
| **Static Policy Posture** | Verifies the emitted posture is deny-only, emits both host envelopes (`experimental.policies`/`permission` for 2.0.x, top-level `policies`/`tool.use` for 2.1.x), requires both to reach the same verdict for every probed resource, and matches the intended commands under a replica of the host's whole-string glob matcher, including the compound-command evasion it does not cover. |
| **Dogfood Gate (Policy 27)** | Verifies the gate stays off until a repository opts in, that PR creation is blocked without fresh evidence and allowed with it, that a tracked edit and a new commit each invalidate the record with a named cause, that a HOLD is never durable and removes that host's cached pass so a restart cannot re-satisfy the gate, that a HOLD in a cold process or in another workspace leaves unrelated hosts' passes intact, that an out-of-matrix HOLD is not reported as the blocking cause, that a `pass` is refused when any check is skipped or the check list is empty, that a HOLD must name a taxonomy class, that an actor session cannot record its own verdict, that the deploy matrix needs one fresh pass per host, that a newer HOLD on a host reopens the gate, that the PR audit names every covered host, and that per-host retention cannot evict another host's pass. |
| **Modular Exports & Shape** | Verifies V1 `PluginModule` `{ id, server }` structure, modular policy imports, and `output.args` hook contract. |
