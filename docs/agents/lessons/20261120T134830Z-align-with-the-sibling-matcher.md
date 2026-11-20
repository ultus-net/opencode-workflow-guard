# LL-016 — A false-positive matcher is usually a matcher that disagrees with a tested sibling; align the two instead of adding a rule

- **Evidence:** `/rsi-campaign` on `opencode-workflow-guard`, 3 iterations, ledger n=3/4/5, PRs #226/#228/#229. Every accepted fix landed on a question that a sibling matcher in the same policy core already answered, and every rejected candidate would have added a rule instead. Telemetry: 45 block codes over 7458 journal records; the two `interactive_tty` blocks were both `sudo`-as-grep-pattern, and the same false positive blocked two live commands during the iteration that fixed it.

| Iteration | Broken matcher | Tested sibling that already decided it | Change |
| --- | --- | --- | --- |
| n=3 | exact-text todo identity rejected a reworded active task | the annotated-normalized lifecycle key (`src/policies/todo.ts:326-357`) | carry the task window across a token-superset refinement |
| n=4 | legacy tamper mode matched every operand of `cp`/`ln`/`install` | fact mode judged the mutation target (`liveControlPlanePaths`) and allowed a guarded source | judge copy-like verbs by destination; `mv` keeps the broad match |
| n=5 | interactive-TTY patterns matched the raw command text | monitors and pagers already matched at command position | read the command word per segment; `sudo` comes from the unwrapper |

- **Fix:** each iteration aligned the broken matcher with its sibling and shipped both directions. The control run restores the base source file alone, never the tests: n=3 makes 8 of the new checks fail against `origin/main`'s sources; n=4 makes 8 fail against `origin/main`'s `tamper.ts` (6 allowances, 2 pre-existing fd-split destinations); n=5 makes 7 fail against the base `shell-safety.ts`. Suite at each iteration tip: 1756 (#226), 1784 (#228), 1809 (#229), each with 0 failed. The two screening rejections (unverified line numbers; no decision change) were the candidates with no sibling to align with.

- **Lesson:** name the sibling before naming the fix. If the same question already has a tested answer in the policy core, the preregistration cites it, the diff inverts the pinned false positive, and the held-out set proves the opposite direction still blocks. If no sibling exists, the candidate needs a design discussion rather than an iteration. A control that restores the base source and leaves the new tests in place is what makes the gain attributable to the alignment alone.
