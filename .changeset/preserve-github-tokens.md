---
"opencode-workflow-guard": patch
---

Exclude `GITHUB_TOKEN` and `GH_TOKEN` from `SENSITIVE_ENV_RE` so GitHub CLI (`gh`) and Git subshells preserve authorization and do not prompt for login.
