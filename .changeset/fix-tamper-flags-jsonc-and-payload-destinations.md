---
"opencode-workflow-guard": patch
---

Security hardening and parser fixes:
- Catch global option flags before subcommands in `SETTINGS_TAMPER_PATTERNS` (`opencode --dir . auth ...`)
- Target-specific destination extraction in `outsideWritePathInPayload` avoiding false positives on data payloads containing path strings
- Strip comments and trailing commas in `loadProjectConfig` so `.jsonc` configuration files parse reliably
