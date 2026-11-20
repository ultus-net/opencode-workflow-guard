---
"opencode-workflow-guard": minor
---

Refuse shell-spawned agent CLIs, and close the live-system and self-config gaps around them.

- New Policy 28 blocks `claude`, `codex`, `gemini`, `aider`, and `opencode run` in command position. It unwraps shell wrappers, chained segments, `npx`/`bunx` package execution, and inline interpreter payloads first, so a spawned agent cannot bypass the guard's hooks. The host's `task` tool remains the governed path to a subagent.
- Policy 4 now blocks Azure RBAC role-assignment changes, PR merges through `gh`, and raw DELETE requests through `gh api`, including wrapped and chained forms.
- Policy 6 now blocks the `opencode plugin` and `opencode mcp` mutating verbs, so an agent cannot remove or replace the guard from its own control plane. Read-only listing stays allowed.
