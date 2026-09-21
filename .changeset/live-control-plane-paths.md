---
"opencode-workflow-guard": minor
---

Add opt-in `liveControlPlanePaths` (project config `.opencode/workflow-guard.json`, or the `WORKFLOW_GUARD_LIVE_CONTROL_PLANE_PATHS` env override). When set, the Settings Tamper Guard classifies by runtime consumption instead of filename segments: only targets that resolve under a declared live control-plane root are protected (symlink-aware), so copying **from** a live config path into a sanctioned workspace draft is no longer blocked, and versioned drafts (a project `.opencode/`, a dotfiles `.config/opencode`, a worktree) are editable. Roots must be absolute (`~`/`$HOME` are expanded); an unusable root rejects the whole set and falls back to the legacy fail-closed segment matching. Unset keeps the legacy behavior.
