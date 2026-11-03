---
"opencode-workflow-guard": patch
---

Restore V2 enforcement that keyed on event types the host never delivers, and honor the user interrupt.

The V2 event stream is served from `EventManifest.ServerDefinitions`. A type present in `Definitions` but absent from that manifest is never delivered, even when a plugin handles it. Three handlers were built on such types.

- Tool-outcome telemetry now records from `ctx.tool.hook("execute.after")` instead of the never-delivered `session.message.content.updated` type. The repeated-failure circuit breaker and the Policy 25 live-documentation research floor were dead on V2, because `getFailureCount()` could only return 0. A failed tool call now accrues failure debt and a successful call clears it, preserving the existing failure signature (`sha256(tool \0 error)`).
- `session.execution.interrupted` is handled, so a user interrupt (Esc) suspends automatic continuation on V2. Only reason `user` suspends. `shutdown`, `superseded`, and `inactivity` are host-lifecycle events and leave continuation state alone. Ralph runs record the `user_stopped` outcome in the same handler, so both continuation budgets agree.
- The MCP inventory refresh now triggers on the delivered `mcp.status.changed` instead of the never-delivered `mcp.tools.changed`, so a guarded server connecting mid-session is guarded without waiting for the next session. Widening stays additive; static tokens are never removed.
- The idle handler moved from the deprecated `session.idle` to `session.status` with `status.type === "idle"`. Side effects are unchanged.
- The `command.executed` audit handler was removed. It never ran on V2, and no delivered event carries a slash-command invocation, so Policy 13 now documents that audit as V1-only.
- Automatic continuation passes `delivery: "queue"` and `resume: true` explicitly instead of relying on host defaults.
- The V2 entrypoint no longer imports the V1 entrypoint. `guardToolCall`, `guardToolDecision`, and `buildCompactionContext` moved to `src/lib/guard-api.ts`, which breaks an import cycle that pulled the V1 file and its SDK subtree into a V2 host. The builtin tool-description suffixes moved to `src/lib/tool-descriptions.ts` so both hosts share one copy.
- Block toasts are no longer awaited on V2, where the client shim supplies no TUI surface. The thrown tool error still carries the block reason to the model.
