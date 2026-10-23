---
"opencode-workflow-guard": minor
---

OpenCode 2 policy posture: close a write-confinement escape, add the permission
seat, ship installable static policies, restore the task/todo distinction, and
pin the host dependency.

**Security fix.** A session could widen its write boundary into another
repository through a single allowed read, because a path-derived workspace
candidate was adopted even for an already-bound session. That is the one change
in this release with a security impact; see the dedicated write-confinement
changeset for the mechanism and its regression checks.

The rest:

- **Permission seat.** `ctx.permission.hook("evaluate")` now denies before a
  tool starts, tightening only: a configured `deny` is already final, so the
  hook never re-permits one.
- **Static policy posture.** `opencode-workflow-guard policies --print` emits a
  host-level policy block for invariants a repository cannot lift. It prints and
  refuses to install, because a plugin that writes the config holding its own
  static rails has moved them back inside the plugin.
- **Todo capability.** The `todowrite` capability is probed from the tool
  registry instead of inferred from history, so OpenCode 2.1.x gates a session
  that never planned while 2.0.x still fails open, now with a once-per-session
  warning and a `todoCapability` field in `guard_status`.
- **Pinned host dependency.** Direct dependencies no longer float on `latest`,
  and `guard_status` reports the qualified host version next to the loaded one.
- **`setup` writes the right key.** OpenCode 2 reads `plugins`, not the singular
  `plugin`; the old writer produced a config that looked configured and loaded
  nothing on 2.x. The TUI file is the exception: `tui.json` keeps singular
  `plugin` on both majors, because 2.x reads that key and migrates it into
  `cli.json.plugins`.
- **Subagents inherit the parent's write boundary.** A subagent has no direct
  binding of its own, so a path-derived candidate used to look like a first bind
  even when its parent was confined: one allowed foreign read moved the child
  into another repository. Registration now resolves the nearest bound ancestor
  first, so the child stays inside the parent's boundary and the refusal is
  journaled.
- **Adopted current plugin APIs.** Server-side `/guard-status` command, read-only
  tool pruning from the per-request snapshot, native worktree creation with
  host-declared cleanup, and a widen-only MCP inventory.

## Verification status

Probe-gated, not date-gated. Verified on the installed host:

| Gate | Result |
|---|---|
| `npm run typecheck` | clean on the final tree |
| `npm test` | 1261 passed, 0 failed |
| `npm run test:install` | 27 passed, 0 failed, on OpenCode v2.0.15 |
| `WORKFLOW_GUARD_LIVE_E2E=1 npm run test:install` | 29 passed, 0 failed, 3 live unavailable. All three model-driven probes reached the provider, got `Model unavailable: openrouter/openrouter/auto`, and were classified unavailable rather than passed or failed |
| Static-policy denial canary | **NOT RUN**: needs a live session and an operator-installed config; the guard's tamper rail correctly blocks an agent from writing a live control-plane path |
| OpenCode 2.1.x todo acceptance | **NOT RUN**: the installed host is 2.0.15 and has no `todowrite` to probe. Covered by synthetic registry and session data only |

Do not read the unrun rows as passes. They are recorded gaps, and each names the
condition that would close it.
