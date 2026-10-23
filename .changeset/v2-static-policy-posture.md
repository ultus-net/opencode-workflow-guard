---
"opencode-workflow-guard": minor
---

Add `opencode-workflow-guard policies --print`, which emits a static host-level policy block for invariants a repository cannot lift: protected-trunk pushes, live control-plane edits, secret reads, external-directory widening, and the Code Mode surface. The command prints JSONC to stdout and refuses to install it, because a plugin that writes the config holding its own static rails has moved them back inside the plugin.

**The default emits both host envelopes.** OpenCode 2.0.x evaluates `experimental.policies` with `action: "permission"`, and OpenCode 2.1.x evaluates a top-level `policies` array with `action: "tool.use"`. Each host ignores the key it does not read and reports no error, so a single-key block loads cleanly on the other host and enforces nothing. Live denial canaries confirmed both silent no-ops: the `2.0` block executed a denied command on 2.1.3, and the `next` block executed it on 2.0.15. `--print` therefore defaults to `both`, and `--format 2.0` / `--format next` remain for pinning one host.

The same canaries confirm the default block denies on both hosts with `Blocked by configuration policy`. The `execute` invariant is documented as inert on both qualified hosts, because neither registers an `execute` tool.

See [docs/policy-posture.md](docs/policy-posture.md) for precedence, the two rules that are judgement calls, the acceptance matrix, and the residual risk: whole-string shell globs do not cover compound command lines, and a config that can be written can be edited.
