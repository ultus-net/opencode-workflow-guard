---
"opencode-workflow-guard": patch
---

Anchor the settings-tamper guard to live config consumption surfaces instead of path segments. Versioned draft config trees (e.g. dotfiles repos), scratch copies, deep docs/examples files, and agent/command payload markdown under `.opencode/agent[s]|command[s]/` are editable again, while project-root config files, the `.opencode/` control directory, the live user-level config directory, and installed guard copies (`node_modules`/versioned caches) stay protected. Branch creation (`checkout -b`, `switch -c`) is never gated: base staleness becomes an audited advisory instead of a block, keeping branch creation the sanctioned escape from branch protection. Policy decisions now carry the matched `surface` and the sanctioned `alternative`, exposed through `guard_why` and the audit trail.
