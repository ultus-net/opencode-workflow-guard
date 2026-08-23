---
"opencode-workflow-guard": patch
---

**Policy 8 boundary fix.** Removed the `WORKFLOW_GUARD_ALLOW_LIVE` bypass from the external `git -C <repo>` workspace-boundary check. The docs and `guardShellMutation` have always stated the boundary has no allow-live override; the orchestrator's external-git branch was the one inconsistent path, now aligned. Added a regression test asserting external git writes stay blocked under allow-live.

**Review rubric is now a real flow.** `buildReviewRubric` is no longer a dead export: a new `guard_review_rubric` tool emits the rubric with the current branch diff for the orchestrator to hand to a reviewer subagent, and `record_review` rejects summaries that don't reference the review axes.

**Docs drift cleanup.** `docs/testing.md` no longer references the removed single-focus rule; `docs/policies.md` names the full hook surface; the stale `## Unreleased` block in CHANGELOG.md (content that shipped in 1.2.0) is removed.
