---
"opencode-workflow-guard": minor
---

Add `opencode-workflow-guard policies --print`, which emits a static host-level policy block for invariants a repository cannot lift: protected-trunk pushes, live control-plane edits, secret reads, external-directory widening, and the Code Mode surface. The command prints JSONC to stdout and refuses to install it, because a plugin that writes the config holding its own static rails has moved them back inside the plugin. `--format 2.0` (default) emits the shape OpenCode 2.0.x actually reads; `--format next` emits the newer documented shape.

See [docs/policy-posture.md](docs/policy-posture.md) for precedence, the two rules that are judgement calls, and the residual risk: whole-string shell globs do not cover compound command lines, and a config that can be written can be edited.
