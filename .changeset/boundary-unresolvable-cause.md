---
"opencode-workflow-guard": patch
---

Workspace-boundary blocks now attribute the unresolvable-variable cause: a mutation, redirect, or patch target containing an unresolvable `$VARIABLE` reference (for example `mkdir -p $D/sub` or `> $CACHE/out.txt`) is indeterminate without executing shell semantics and is treated as outside the workspace, but the block message now says so — "contains an unresolvable variable reference … use a literal workspace-relative path" — instead of the generic escape message, across the edit/write path, `apply_patch`, and shell mutations. Deterministically expandable forms (`~`, `$HOME`) and literal paths inside the workspace keep the generic messages; the fail-closed behavior itself is unchanged. docs/policies.md and docs/troubleshooting.md document the rule and the remedy.
