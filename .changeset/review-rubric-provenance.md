---
"opencode-workflow-guard": patch
---

`guard_review_rubric` now names the workspace, base ref, and diff byte count it graded in a `Provenance:` line. When no listed base yields a diff it refuses with the workspace, every base it tried, and the remedy, instead of silently grading `git diff HEAD~1`. `HEAD~1` is graded only when the caller passes `base: "HEAD~1"`.

The injected workflow guidance and both tool descriptions now say the calling session records the reviewer subagent's verdict, because a reviewer agent's host permission list may omit `record_review`.

A recognized shell writer (redirect, `tee`, `sed -i`, `cp`/`mv`/`ln`, `rm`, `truncate`, `dd of=`, `git apply`, `git am`, and a `mv` source) is now refused when its target is claimed by another session, matching the direct-edit claim check. A shell write never acquires a claim, so it cannot strand one.
