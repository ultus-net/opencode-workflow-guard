---
"opencode-workflow-guard": patch
---

Expand the provider-free e2e harness to verify guard policy decisions via `guard_why` simulate (protected-branch push, secret-file reads, workspace boundary escape, interactive TTY shell-safety), project configuration loading from `.opencode/workflow-guard.json`, and the full config-gated 18-tool registration surface through the real OpenCode runtime. Test-only change; no runtime behavior changes.
