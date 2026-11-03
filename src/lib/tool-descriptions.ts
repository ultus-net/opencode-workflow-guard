/**
 * Single source of truth for the builtin tool-description suffixes.
 *
 * Both entrypoints append the same text: the V1 `tool.definition` hook in
 * `workflow-guard.ts` and the V2 `ctx.tool.transform` enrichment in
 * `lib/v2-plugin.ts`. Keeping one copy prevents the two hosts from drifting
 * apart, which would make a model's expectations depend on which host it runs
 * on.
 *
 * Each suffix carries a marker. The marker is the idempotence key: a
 * description already containing it is left untouched, so a second plugin
 * instance (or a re-applied transform) cannot append the text twice.
 */

export const TODOWRITE_MARKER = "verification evidence";
export const TODOWRITE_SUFFIX =
	"\n\nWorkflow Guard lifecycle: use todowrite to plan before working - it is the only view of progress the operator has, and every file mutation is gated on it. Each call replaces the complete task list: preserve every pending/in_progress task in subsequent updates until you explicitly mark it completed or cancelled, and do not omit active tasks when adding new work. A task may be marked completed only after its own work is recorded: the guard blocks a completion that has no file mutation in that task's active window, and one mutation cannot vouch for several completions. If a task is genuinely read-only (review, investigation, reading), append the marker `[read-only]` to its text; every such use is journaled. Use `cancelled` for work that was deliberately dropped. Marking every task completed triggers the finalization gate - fresh verification evidence (test run) is required after the last mutation, and protected-branch/conflict checks apply. Proactively call guard_next_tasks when planning work to discover existing roadmap/TODOs, and guard_status to check outstanding requirements.";

export const EDIT_MARKER = "Workflow Guard requirement";
export const EDIT_SUFFIX =
	"\n\nWorkflow Guard requirement: Modifications require an active task in todowrite (status pending or in_progress), a feature branch (edits on main/master are blocked), and a prior read of existing files in the current session.";

export const SUBAGENT_MARKER = "Workflow Guard subagent guidance";
export const SUBAGENT_SUFFIX =
	"\n\nWorkflow Guard subagent guidance: When spawning parallel worker subagents, use guard_worktree_create to isolate file mutations in separate worktrees. When conducting code reviews before task completion or PR creation, fetch the rubric with guard_review_rubric and provide it to a reviewer subagent to evaluate and record via record_review.";

/**
 * Append `suffix` unless the description already carries `marker`.
 *
 * Returns `undefined` when the suffix is already present, so a caller can tell
 * "nothing to do" from "wrote an empty string".
 */
export function appendToolDescriptionSuffix(description: string, suffix: string, marker: string): string | undefined {
	if (description.includes(marker)) return undefined;
	return description + suffix;
}
