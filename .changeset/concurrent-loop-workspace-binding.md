---
"opencode-workflow-guard": patch
---

Resolve every workspace-dependent guard decision from the call's own context and the session's own workspace binding instead of one process-global slot: concurrent loop sessions sharing a single guard process no longer re-anchor each other's boundary checks, git push/branch evaluation, `guard_status`, or `record_review` bindings (session workspaces are registered from tool-call arguments or host-provided per-call worktrees, and a plugin-instance default can no longer re-anchor an already-bound session).

Bind secondary-review verdicts per exact worktree: `getLastReviewResultForWorkspace` prefers an exact worktree-path match, then a same-repo review whose tracked-content fingerprint matches the consuming worktree, and only then falls back to repository-level recency — so two loops sharing one repository stop displacing each other's approvals between `record_review` and `gh pr create`. `record_review` without any resolvable reviewed workspace (no explicit `directory`, no session binding, no per-call worktree) is now rejected with an actionable cause instead of silently binding to a latched root.

Make the PR-creation lockfile gate section-aware for `package.json`: it fires when a section the lockfile records changed (`dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies`, `peerDependenciesMeta`, `engines`, `packageManager`, `overrides`, `resolutions`, `workspaces`, `pnpm`, `name`, `version`). Scripts-only or metadata-only manifest edits — which regenerate `package-lock.json` byte-identical — no longer block PR creation with an unsatisfiable demand. `Cargo.toml`/`go.mod` keep the conservative manifest-changed trigger.
