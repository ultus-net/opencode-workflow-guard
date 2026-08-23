---
"opencode-workflow-guard": patch
---

Harden workspace boundary and secret-read policies against shell evasion patterns:
- Expand `~`, `~user`, `$HOME`, and fail closed on indeterminate `$VARIABLE` references in boundary targets
- Support `&>`, `&>>`, `>&`, `>>&`, and attached redirects in shell mutation parsing while filtering fd duplication (`2>&1`, `>&2`)
- Generic `tee` flag skipping (`-a`, `--append`, `-ai`, `--`) and multi-target boundary validation
- Enforce external-repository confinement on `GIT_DIR=` and `GIT_WORK_TREE=` environment assignments
- Scan inline interpreter payloads (`python -c`, `node -e`, `bash -c`, `sh -c`, `zsh -c`) for secret-file reads and out-of-workspace writes
