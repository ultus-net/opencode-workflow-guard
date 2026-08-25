---
"opencode-workflow-guard": minor
---

Add an idempotent `opencode-workflow-guard setup` CLI that registers both the server plugin and TUI companion in their respective OpenCode global configuration files. PR preflight checks now honor an explicit shell workdir so changesets in isolated worktrees are detected correctly.
