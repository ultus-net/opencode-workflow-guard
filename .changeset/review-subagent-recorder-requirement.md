---
"opencode-workflow-guard": minor
---

`record_review` supports an opt-in strict recorder mode: setting `requireSubagentReview: true` in `.opencode/workflow-guard.json` (or `WORKFLOW_GUARD_REQUIRE_SUBAGENT_REVIEW=1`) rejects approvals recorded by the root session itself, so a passing verdict must be recorded from a subagent session with a parent. This closes the root-session self-approval path that content binding intentionally leaves open for relay flows with read-only reviewer toolsets; changes-requested findings remain relayable, the default behavior is unchanged, the audit entry records reason `subagent_recorder_required`, and `WORKFLOW_GUARD_REQUIRE_SUBAGENT_REVIEW=0` disables the requirement even when project config enables it. `guard_status` echoes the effective requirement in its `projectConfig` summary.
