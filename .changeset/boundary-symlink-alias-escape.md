---
"opencode-workflow-guard": patch
---

Accept workspace-symlink-aliased absolute paths in the workspace boundary: a target that lexically looks outside the workspace root (for example `/home/hunter/...` where `/home` is a symlink to `var/home` and the workspace root lives under `/var/home/hunter/...`) is no longer blocked as `workspace_escape` when its canonical resolution is inside the root. Symlinks inside the workspace that point outside stay blocked (including new files under them, via the nearest-existing-ancestor walk), and indeterminate canonicalization still fails closed to the lexical verdict.