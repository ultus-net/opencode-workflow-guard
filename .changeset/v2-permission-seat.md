---
"opencode-workflow-guard": minor
---

The V2 `permission.hook("evaluate")` seat now enforces instead of only journaling. It maps the host's normalized permission `action`/`resources` back onto the policy core and sets `effect = "deny"` with an attributable message, so a denied shell command or file mutation never starts. Shell resources feed the shell, git, destructive, and workspace policies, `read` resources feed the secret policy, `edit`/`write`/`patch`/`apply_patch` resources feed the boundary, tamper, secret, protected-branch, and todo policies, and guarded MCP servers feed the MCP policy. The seat only tightens: an explicit configured `deny` stays final, unmapped host actions remain with host policy, and a seat failure fails closed. `execute.before` is kept as the last-resort seat because it is the only one that sees raw tool input.
