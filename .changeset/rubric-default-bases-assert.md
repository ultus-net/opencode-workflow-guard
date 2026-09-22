---
"opencode-workflow-guard": patch
---

`guard_review_rubric` diff invocations keep a trailing `--` after the revision so a configured base ref can never parse as a pathspec (defense-in-depth on top of the revision-before-`--` fix), and the default-bases fallback loop (origin/main → origin/master → main → master, then HEAD~1) is directly asserted: a repository with no origin remote embeds the real branch diff from the local main branch.
