---
"opencode-workflow-guard": minor
---

Enforce per-task completion evidence for `todowrite`.

A task may now enter `completed` only when the session recorded at least one file mutation inside that task's active window. Previously, a list-wide `todowrite` could flip every item to `completed` with no work behind it; the guard only journalled a `completion_claim_mismatch` audit record and allowed it. That signal is now an enforced policy.

- **Per-task windows, not a session baseline.** Each active task records the session mutation count when it entered its current window. One mutation cannot vouch for several completions, so N completions need N mutations counted from the earliest of them, and work done before a task became active never counts toward it. A finished or dropped task releases its window, so reusing a task's text starts clean. Task identity is the task text with the read-only marker stripped, and occurrences are counted rather than matched by last write, so duplicate text cannot hide a new completion.
- **`[read-only]` escape for review and investigation.** Tasks that legitimately change no file carry `[read-only]` in their text (also `[read_only]` / `[read only]`) and complete freely. Because the marker is an annotation rather than part of identity, it can be appended to an already-planned task instead of forcing a re-plan. Every use is journaled as `todo_completed_read_only`, so relabeling real work as read-only is visible in the audit trail instead of passing silently. Deliberately dropped work uses `cancelled`.
- **Planned late.** A task first observed already `completed` has no window, so it is scored against the session's mutation history, bounded by the one-mutation-per-completion rule.
- **Block message names the remedy.** A rejected write names the offending tasks and states the three legitimate paths: do the work, mark it `[read-only]`, or mark it `cancelled`.
- **Simulation predicts the gate.** `guard_why` now reports the same verdict the enforcement path would, and does not move any task window.
- **Steering, not just enforcement.** The `todowrite` tool description, the system-prompt guidance, and the compaction injection now state the lifecycle contract: plan before working, keep the list truthful, complete a task only after its work is done, and use the marker for genuinely read-only tasks.
- **`guard_status` reports `taskEvidence`** (`active`, `completed`, `tasksWithoutRecordedWork`, `readOnlyTasks`), so the requirement is visible before it blocks anything.

Todo state is per session and cleared on `session.deleted`. The completion check never replaces the finalization gates: fresh verification evidence and the review gate remain the authority on whether the work is done.
