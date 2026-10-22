---
"opencode-workflow-guard": minor
---

Adopt five OpenCode 2 plugin APIs that were previously unused, and correct documentation that had drifted from the host.

`ctx.command.transform` now registers a server-side `/guard-status` command, so guard state is readable from every V2 client without the separately installed TUI companion. The report is delivered as a synthetic message, which costs no model turn.

Read-only subagent roles now lose the mutating tools from their per-request tool snapshot in `session.hook("context")` (`write`, `edit`, `patch`, `apply_patch`, `shell`, `bash`, `execute`, `todowrite`, `subagent`/`task`, and the worktree lifecycle tools). Previously they received guidance text and were denied late in `execute.before`; now the model cannot plan the call at all. The `execute.before` seat is unchanged and remains the backstop for tools supplied outside the host snapshot. Every pruning is journaled as `session.context` / `read_only_role_tools_pruned`.

`guard_worktree_create` uses the host worktree API when the host exposes a project id, so the worktree lands in the operator's configured `worktree.directory` and appears in host inventory. The host's answer is validated independently (existing directory, a registered worktree of this repository, never the primary tree) and any failure falls back to the existing git path. `guard_worktree_cleanup` still owns removal, because the host's `remove` has a `force` flag and no snapshot step, so delegating it could destroy uncommitted work the guard preserves. Cleanup accepts a directory outside the guard's storage only when the host declares it, and it asks the host to refresh its inventory afterwards.

The MCP policy now widens its guarded server tokens from `ctx.mcp.list()`, refreshed on `mcp.tools.changed`. A renamed or enterprise instance of a guarded product is matched without a code change. Widening is one-way: removing a server adds nothing and the static token list stays the floor, because tool names are model-supplied text and the MCP policy is a live-system rail.

`command.executed` is now journaled. The previous comment claimed V2 had no such event; the installed 2.0.10 schema has it, and the 2.0.15 host emits it.

Docs corrected in the same pass: `docs/policies.md` now lists the V2 hook names alongside the V1 ones (V1 plugin implementations do not run on OpenCode 2), qualifies the `todowrite` version boundary (absent through 2.0.15, reintroduced in 2.1.x behind `experimental.todo`), and names `session.hook("compaction")` as the V2 compaction seat. Stale comments in `src/lib/v2-todo.ts` and `src/lib/v2-plugin.ts` now state the version boundary instead of asserting that no `todowrite` exists.
