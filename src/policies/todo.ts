import type { TodoItem } from "../lib/types.ts";
import { getSessionMutationCount, getSdkClient, getSubagentMutationBudget, todoTaskStarts } from "../lib/state.ts";

export const EDIT_TOOL_NAMES = new Set(["edit", "write", "patch", "apply_patch"]);
export const ACTIVE_TODO_STATUSES = new Set(["pending", "in_progress"]);

export async function fetchSessionTodos(sessionID: string): Promise<TodoItem[] | undefined> {
	const client = getSdkClient();
	const session = client?.session;
	const todo = session?.todo;
	if (typeof todo !== "function") return undefined;
	try {
		const result = await todo.call(session, { path: { id: sessionID } });
		const data = (result as { data?: unknown } | undefined)?.data;
		return Array.isArray(data) ? (data as TodoItem[]) : undefined;
	} catch {
		return undefined;
	}
}

export async function fetchParentSessionID(sessionID: string): Promise<string | undefined> {
	const result = await fetchParentSession(sessionID);
	return result.ok ? result.parentID : undefined;
}

export async function subagentMutationBudgetReason(
	sessionID: string,
	root: string,
): Promise<string | undefined> {
	if (!await fetchParentSessionID(sessionID)) return undefined;
	const count = getSessionMutationCount(sessionID);
	const budget = getSubagentMutationBudget(root);
	if (count < budget) return undefined;
	return `Blocked: subagent session '${sessionID}' has reached its mutation budget (${count}/${budget}). Hand work back to parent orchestrator.`;
}

export async function fetchParentSession(sessionID: string): Promise<{ ok: true; parentID?: string } | { ok: false }> {
	const client = getSdkClient();
	const session = client?.session;
	const get = session?.get;
	if (typeof get !== "function") return { ok: false };
	try {
		const result = await get.call(session, { path: { id: sessionID } });
		const data = (result as { data?: { parentID?: unknown } } | undefined)?.data;
		if (!data) return { ok: false };
		const parent = data.parentID;
		return { ok: true, parentID: typeof parent === "string" && parent ? parent : undefined };
	} catch {
		return { ok: false };
	}
}

export async function effectiveTodos(
	sessionID: string | undefined,
): Promise<TodoItem[] | undefined> {
	return (await effectiveTodosWithOwner(sessionID))?.todos;
}

export async function effectiveTodosWithOwner(
	sessionID: string | undefined,
): Promise<{ todos: TodoItem[]; ownerSessionID?: string } | undefined> {
	if (!sessionID) return undefined;
	const seen = new Set<string>();
	let current: string | undefined = sessionID;
	let sawUnknown = false;
	while (current && !seen.has(current)) {
		seen.add(current);
		const todos = await fetchSessionTodos(current);
		if (todos === undefined) {
			// This link has no determinable list (no todo capability, read
			// error, or no endpoint). Do not treat it as empty and do not stop
			// the walk: a parent may still own an applicable list, and keeping
			// the walk going preserves evidence attribution to that owner. An
			// unknown link only fails open if no ancestor provides a list.
			sawUnknown = true;
		} else if (todos.length > 0) {
			return { todos, ownerSessionID: current };
		}
		current = await fetchParentSessionID(current);
	}
	if (sawUnknown) return undefined;
	return { todos: [] };
}

export async function effectiveTodoOwnerSessionID(
	sessionID: string | undefined,
): Promise<string | undefined> {
	if (!sessionID) return undefined;
	const effective = await effectiveTodosWithOwner(sessionID);
	return effective?.ownerSessionID ?? sessionID;
}

export function hasActiveTodo(todos: TodoItem[]): boolean {
	return todos.some((todo) => ACTIVE_TODO_STATUSES.has(String(todo.status ?? "")));
}

/**
 * Explicit read-only escape. A task whose text carries this marker completes
 * without a mutation in its window. Every use is journaled, so an agent that
 * marks real work read-only leaves a visible trail instead of passing silently.
 */
export const READ_ONLY_TODO_MARKER = /\[read[-_ ]?only\]/i;

export function isReadOnlyTodo(todo: TodoItem): boolean {
	return READ_ONLY_TODO_MARKER.test(String(todo.content ?? ""));
}

/**
 * Task identity: trimmed content with the read-only marker removed.
 *
 * The marker is an annotation about a task, not part of which task it is. An
 * agent that planned a task and only then discovers it is read-only appends the
 * marker; that must not read as deleting one task and inventing another, or the
 * documented remedy would be blocked by the no-silent-deletion rule. It also
 * keeps the task's window, so annotating instead of re-planning loses nothing.
 */
export function todoTaskKey(todo: TodoItem): string {
	return String(todo.content ?? "")
		.replace(READ_ONLY_TODO_MARKER, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Raw task text, for messages the model has to match against its own list. */
function todoTaskLabel(todo: TodoItem): string {
	return String(todo.content ?? "").trim();
}

/**
 * Record when each active task entered its current active window, in the
 * session's mutation count. Completion evidence is judged against this.
 *
 * Call this only for a `todowrite` the guard allowed: a blocked write never
 * becomes the task list, so it must not move a task's start.
 */
export function recordTodoTaskStarts(
	starts: Map<string, number>,
	previousTodos: TodoItem[] | undefined,
	nextTodos: TodoItem[],
	mutationCount: number,
): void {
	const previouslyActive = new Set<string>();
	for (const todo of previousTodos ?? []) {
		if (ACTIVE_TODO_STATUSES.has(String(todo.status ?? ""))) previouslyActive.add(todoTaskKey(todo));
	}
	const live = new Set<string>();
	for (const todo of nextTodos) {
		const key = todoTaskKey(todo);
		if (!key) continue;
		if (ACTIVE_TODO_STATUSES.has(String(todo.status ?? ""))) {
			live.add(key);
			// A task keeps its original window across rewrites and status
			// changes within the active set. A task returning to active after
			// finishing starts a fresh window.
			if (!previouslyActive.has(key) || !starts.has(key)) starts.set(key, mutationCount);
		}
	}
	// Finished or dropped tasks close their window; a later task with the
	// same text starts clean instead of inheriting stale evidence.
	for (const key of [...starts.keys()]) {
		if (!live.has(key)) starts.delete(key);
	}
}

/**
 * Completion evidence, enforced: a task may not move to `completed` unless the
 * session mutated at least once inside that task's active window. One mutation
 * cannot vouch for several completions, so N completions need N mutations
 * counted from the earliest of them.
 *
 * Read-only tasks are the documented escape: they carry `[read-only]` in their
 * text and complete freely. Todos are still not authority on finalization; the
 * verification gate remains the authority there.
 *
 * Tasks are matched to their prior occurrence by count, not by last-write-wins,
 * so duplicate content cannot hide a new completion behind an already-completed
 * item of the same text.
 *
 * Returns the tasks that still lack evidence. An empty list means the write may
 * proceed.
 */
export function unverifiedTodoCompletions(
	previousTodos: TodoItem[] | undefined,
	nextTodos: TodoItem[],
	starts: Map<string, number>,
	mutationCount: number,
): string[] {
	// Each prior occurrence can absorb at most one new item of the same key. A
	// prior `completed` occurrence absorbs a new `completed` item silently; any
	// other prior occurrence leaves the new item as a fresh claim.
	const absorbable = new Map<string, number>();
	const absorbCompleted = new Map<string, number>();
	for (const todo of previousTodos ?? []) {
		const key = todoTaskKey(todo);
		if (!key) continue;
		absorbable.set(key, (absorbable.get(key) ?? 0) + 1);
		if (String(todo.status ?? "") === "completed") {
			absorbCompleted.set(key, (absorbCompleted.get(key) ?? 0) + 1);
		}
	}

	const claimed: Array<{ task: string; start: number }> = [];
	for (const todo of nextTodos) {
		const key = todoTaskKey(todo);
		if (!key) continue;
		if (String(todo.status ?? "") !== "completed") continue;
		const completedBefore = absorbCompleted.get(key) ?? 0;
		if (completedBefore > 0) {
			// An unchanged completed item, not a new claim.
			absorbCompleted.set(key, completedBefore - 1);
			const remaining = absorbable.get(key) ?? 0;
			if (remaining > 0) absorbable.set(key, remaining - 1);
			continue;
		}
		const remaining = absorbable.get(key) ?? 0;
		if (remaining > 0) absorbable.set(key, remaining - 1);
		if (isReadOnlyTodo(todo)) continue;
		claimed.push({ task: todoTaskLabel(todo), start: starts.get(key) ?? 0 });
	}

	if (claimed.length === 0) return [];
	// Each completion needs its own distinct mutation inside its own window.
	// Checking only the earliest start would let mutations spent before a later
	// task began vouch for it. Sorted by window start, a claim can only be
	// satisfied if the window from that point still holds at least one mutation
	// per remaining claim; the first failure marks an infeasible suffix, since
	// every task after it has an equal or narrower window.
	claimed.sort((a, b) => a.start - b.start);
	for (let index = 0; index < claimed.length; index++) {
		const remainingClaims = claimed.length - index;
		if (mutationCount - claimed[index]!.start < remainingClaims) {
			return claimed.slice(index).map((claim) => claim.task);
		}
	}
	return [];
}

export function readOnlyTodoCompletions(
	previousTodos: TodoItem[] | undefined,
	nextTodos: TodoItem[],
): string[] {
	// Count prior occurrences by key and how many were already completed. An
	// item carrying the marker is journaled when it is a new completion, which
	// includes the common case of annotating an already-planned task.
	const completedBefore = new Map<string, number>();
	for (const todo of previousTodos ?? []) {
		const key = todoTaskKey(todo);
		if (!key) continue;
		if (String(todo.status ?? "") === "completed") completedBefore.set(key, (completedBefore.get(key) ?? 0) + 1);
	}
	const readOnly: string[] = [];
	for (const todo of nextTodos) {
		if (String(todo.status ?? "") !== "completed" || !isReadOnlyTodo(todo)) continue;
		const key = todoTaskKey(todo);
		if (!key) continue;
		const unchanged = completedBefore.get(key) ?? 0;
		if (unchanged > 0) {
			completedBefore.set(key, unchanged - 1);
			continue;
		}
		readOnly.push(todoTaskLabel(todo));
	}
	return readOnly;
}

export function todoCompletionBlockReason(blocked: string[]): string {
	const tasks = blocked.map((task) => `'${task}'`).join(", ");
	return (
		`Blocked todowrite: ${blocked.length === 1 ? "task" : "tasks"} ${tasks} marked completed without enough recorded work in the task window. ` +
		"Complete the task's work first, then mark it completed. " +
		"If the task was genuinely read-only (review, investigation, reading), append the marker `[read-only]` to its text and mark it completed. " +
		"Use `cancelled` for work that was deliberately dropped."
	);
}

/**
 * Read-only view of a session's task evidence, for `guard_status`. Reports what
 * the completion gate would decide now, so the requirement is visible before it
 * blocks anything.
 */
export async function todoEvidenceReport(sessionID: string | undefined): Promise<{
	active: number;
	completed: number;
	tasksWithoutRecordedWork: string[];
	readOnlyTasks: string[];
}> {
	if (!sessionID) return { active: 0, completed: 0, tasksWithoutRecordedWork: [], readOnlyTasks: [] };
	const todos = await effectiveTodos(sessionID);
	if (!todos) return { active: 0, completed: 0, tasksWithoutRecordedWork: [], readOnlyTasks: [] };
	const starts = todoTaskStarts(sessionID);
	const count = getSessionMutationCount(sessionID);
	const active = todos.filter((todo) => ACTIVE_TODO_STATUSES.has(String(todo.status ?? "")));
	const tasksWithoutRecordedWork: string[] = [];
	const readOnlyTasks: string[] = [];
	for (const todo of active) {
		const label = todoTaskLabel(todo);
		if (!label) continue;
		if (isReadOnlyTodo(todo)) {
			readOnlyTasks.push(label);
			continue;
		}
		if (count <= (starts.get(todoTaskKey(todo)) ?? 0)) tasksWithoutRecordedWork.push(label);
	}
	return {
		active: active.length,
		completed: todos.filter((todo) => String(todo.status ?? "") === "completed").length,
		tasksWithoutRecordedWork,
		readOnlyTasks,
	};
}

export function validateTodoLifecycle(
	newTodos: TodoItem[],
	existingTodos: TodoItem[] | undefined,
): string | undefined {
	// Rule: No silent task deletion while active work remains
	// (single-focus rule removed: multiple tasks may be in_progress to allow
	// concurrent subagent work on different tasks)
	if (existingTodos && existingTodos.length > 0) {
		const activeExisting = existingTodos.filter((t) => {
			const s = String(t.status ?? "");
			return s === "pending" || s === "in_progress";
		});
		if (activeExisting.length > 0) {
			const activeNew = newTodos.filter((t) => ACTIVE_TODO_STATUSES.has(String(t.status ?? "")));
			const reviewObligation = /\b(?:secondary\s+review|re-?review|reviewer|(?:run|perform|request|obtain|complete)\s+(?:an?\s+)?review)\b/i;
			const remediationAction = /\b(?:address|fix|resolve|remediate)\b/i;
			const reviewReference = /\b(?:secondary\s+review|re-?review|reviewer|review)\b/i;
			const remediationSubject = /\b(?:findings?|feedback|comments?|issues?)\b/i;
			const isReviewObligation = (content: string) => reviewObligation.test(content) && !(remediationAction.test(content) && reviewReference.test(content) && remediationSubject.test(content));
			const newContentCounts = new Map<string, number>();
			for (const todo of newTodos) {
				const content = todoTaskKey(todo);
				newContentCounts.set(content, (newContentCounts.get(content) ?? 0) + 1);
			}
			const retainedReviewCounts = new Map<string, number>();
			for (const todo of activeNew) {
				const content = todoTaskKey(todo);
				retainedReviewCounts.set(content, (retainedReviewCounts.get(content) ?? 0) + 1);
			}
			let retainedReviewObligations = 0;
			for (const todo of activeExisting) {
				const content = todoTaskKey(todo);
				const remaining = retainedReviewCounts.get(content) ?? 0;
				if (remaining > 0 && isReviewObligation(content)) {
					retainedReviewCounts.set(content, remaining - 1);
					retainedReviewObligations++;
				}
			}
			let replacementReviewObligations = activeNew.filter((t) => isReviewObligation(todoTaskKey(t))).length - retainedReviewObligations;
			const missing = activeExisting.find((todo) => {
				const content = todoTaskKey(todo);
				const remaining = newContentCounts.get(content) ?? 0;
				if (remaining === 0 && isReviewObligation(content) && replacementReviewObligations > 0) {
					replacementReviewObligations--;
					return false;
				}
				if (remaining === 0) return true;
				newContentCounts.set(content, remaining - 1);
				return false;
			});
			if (missing) {
				return (
					`Blocked todowrite: active task '${String(missing.content ?? "")}' was removed ` +
					"without being marked completed or cancelled. Tasks cannot silently disappear."
				);
			}
		}
	}

	return undefined;
}
