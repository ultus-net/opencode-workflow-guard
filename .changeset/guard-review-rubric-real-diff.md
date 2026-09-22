---
"opencode-workflow-guard": patch
---

`guard_review_rubric` now embeds the real branch diff. The tool passed `--` before the revision (`git diff -- <base>...HEAD` and `git diff -- HEAD~1`), so git parsed the revision as a pathspec and every rubric prompt carried an empty "Code Diff Under Review" block — reviewers were handed the 5-axis rubric with no diff to evaluate. Fix the argument order (revision before `--`) and add `--no-ext-diff`, matching the verification fingerprint convention. A regression test pins that a real change's content and path appear in the rubric.
