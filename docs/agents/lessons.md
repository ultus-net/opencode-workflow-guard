# Agent loop lessons

Append-only, evidence-backed lessons from base-loop iterations. Each item: id, evidence, one bullet.

- **LL-001 — Git revision/pathspec argument order is a silent failure mode; assert on diff contents, not wrapper text.** Evidence: `guard_review_rubric` in `src/lib/custom-tools.ts` passed `--` before the revision (`git diff -- <base>...HEAD`, `git diff -- HEAD~1`), so git parsed the revision as a pathspec: `git diff -- HEAD~1` returned 0 bytes while `git diff --no-ext-diff HEAD~1` returned 68,709 bytes, and a live rubric call returned 1,714 bytes with an empty `diff` block (12 rubric invocations present in the device audit log). No existing test caught it because the rubric tests asserted the static heading `Code Diff Under Review` rather than the diff body; the fix (revision before `--`, plus `--no-ext-diff`) is covered by a regression test that asserts a changed path/content marker, and post-fix the live rubric grew to 31,714 bytes with real diff markers.
