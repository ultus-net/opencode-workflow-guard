---
"opencode-workflow-guard": minor
---

**Modular codebase architecture.** Split the ~3.3k-line `src/workflow-guard.ts` monolith into per-policy modules under `src/policies/` and engine services under `src/lib/` (state, utils, audit, verify, review, worktree, types), with `src/workflow-guard.ts` as the orchestrator re-exporting the full public helper surface.

**Permission prompt journaling (Policy 14).** Permission requests are now captured via the typed `permission.ask` plugin hook and replies preserve the actual outcome (including rejections) in the audit trail, instead of labeling every permission event as allowed.

**Runtime instance isolation.** Per-invocation workspace root, SDK client, and project config now flow through `runWithRuntimeState` (AsyncLocalStorage), so co-hosted plugin instances cannot read each other's runtime context.

**Dynamic session-scoped TUI badge (Policy 16).** The TUI companion now shows the last block reason (`Active` vs `Blocked: <reason>`) scoped to the triggering session, sourced only from guard-originated toasts.

**Testing & docs.** `test/test-e2e.mts` now packs and installs the npm tarball to verify the modular entrypoint resolves, in addition to the live local-copy plugin-load checks. `AGENTS.md`, README, and policy/testing/installation docs were synchronized with the new layout and hook contracts.
