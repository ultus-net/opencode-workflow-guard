---
"opencode-workflow-guard": patch
---

Block PR descriptions with literal newline escapes that would render as text, direct callers to shell-safe multiline forms, and load SQLite through Bun when running inside OpenCode so durable guard state initializes correctly.
