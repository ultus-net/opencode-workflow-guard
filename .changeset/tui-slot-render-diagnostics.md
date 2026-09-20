---
"opencode-workflow-guard": patch
---

TUI companion: degrade gracefully when a V2 slot render fails

V2 slot renders (home/prompt footer badge) no longer rethrow when the TUI
render context is unavailable. Previously the host error boundary toasted
"workflow-guard-ui crashed in slot home.footer.status: No renderer found" on
every retry after a plugin version swap inside a long-running session. A
failing slot now renders nothing and retries on the next render pass, while
failures are logged with full context (stack, solid owner context keys,
`RendererContext`/`usePlugin` probes) to
`$XDG_STATE_HOME/opencode/workflow-guard-ui.log` (default
`~/.local/state/opencode/workflow-guard-ui.log`, size-capped). Logging is
bounded to the first 3 failures per slot between successes, with recovery
logged again; every setup and module load is logged for easier bug reports.
