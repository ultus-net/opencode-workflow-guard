/**
 * Tool pruning for read-only subagent roles.
 *
 * `execute.before` already denies a mutation from a read-only role, but only
 * after the model has planned the call and the host has admitted it. The V2
 * `session.hook("context")` sees the per-request tool snapshot, so the
 * stronger invariant is to remove the mutating tools before the model can
 * choose them.
 *
 * This is a narrowing only. The `execute.before` seat stays in place as the
 * backstop: tools supplied by an ACP agent or a nested Code Mode call may not
 * appear in the host snapshot, and a pruned list is not an authorization
 * boundary on its own.
 */

/**
 * Tools removed from a read-only role's request.
 *
 * - `write`/`edit`/`patch`/`apply_patch` author file contents.
 * - `shell`/`bash` author bytes through redirects and can mutate git state.
 * - `execute` is Code Mode, which runs nested tool calls. Nested calls are not
 *   documented to fire the guard's hooks, so a read-only role must not reach
 *   them.
 * - `todowrite` replaces the whole task list; read-only roles do not plan work.
 * - `subagent`/`task` can delegate a mutation to a child that runs with the
 *   child's own role.
 * - `guard_worktree_create`/`guard_worktree_cleanup` mutate repository state
 *   and are already denied by the dispatcher for this role.
 */
export const READ_ONLY_PRUNED_TOOLS: readonly string[] = [
	"write",
	"edit",
	"patch",
	"apply_patch",
	"shell",
	"bash",
	"execute",
	"todowrite",
	"subagent",
	"task",
	"guard_worktree_create",
	"guard_worktree_cleanup",
];

/**
 * Delete the mutating tools from a per-request tool snapshot.
 *
 * Returns the ids actually removed, so the caller can journal the narrowing.
 * The snapshot is host-owned and mutable for the duration of the request;
 * deleting a key affects only the outgoing call.
 */
export function pruneToolsForReadOnlyRole(tools: Record<string, unknown> | undefined): string[] {
	if (!tools || typeof tools !== "object") return [];
	const removed: string[] = [];
	for (const id of READ_ONLY_PRUNED_TOOLS) {
		if (!(id in tools)) continue;
		delete tools[id];
		removed.push(id);
	}
	return removed;
}
