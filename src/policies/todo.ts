import type { TodoItem } from "../lib/types.ts";
import { getSessionMutationCount, getSdkClient, getSubagentMutationBudget } from "../lib/state.ts";

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
 * Completion-claim laundering signal (observed, never enforced).
 *
 * A `todowrite` call replaces the whole list, so a model can flip every item to
 * `completed` without doing any work. Todos are never evidence and never
 * authority: the verification and review gates decide whether the work is done.
 * This function answers one narrower question, for the audit trail: did the
 * session mark work complete without mutating anything since the previous
 * todo write?
 *
 * Mirrors Policy 24 (`policies/completion.ts`): it records a mismatch, it never
 * blocks. Blocking here would be wrong, because a session can legitimately
 * complete read-only tasks (a review, an investigation) without mutating.
 *
 * `mutationDelta` is the change in the session's mutation count since the last
 * todowrite for this session. `undefined` means there is no baseline (first
 * todowrite in the session), in which case a completion claiming work is
 * reported only when the session has never mutated at all.
 */
export function completionClaimMismatch(
	previousTodos: TodoItem[] | undefined,
	nextTodos: TodoItem[],
	mutationDelta: number | undefined,
	totalMutations: number,
): string[] {
	const priorStatus = new Map<string, string>();
	for (const todo of previousTodos ?? []) {
		priorStatus.set(String(todo.content ?? "").trim(), String(todo.status ?? ""));
	}
	const transitions = nextTodos.filter((todo) => {
		const content = String(todo.content ?? "").trim();
		const now = String(todo.status ?? "");
		if (now !== "completed") return false;
		// No prior list: every completed item is a first claim, so it counts.
		if (previousTodos === undefined) return true;
		const before = priorStatus.get(content);
		return before !== undefined && before !== "completed";
	});
	if (transitions.length === 0) return [];
	// A first-write completion counts as a mismatch only when the session has
	// never mutated, which is the blatant case. With a baseline, any mutation
	// activity since the previous write is enough to suppress the signal,
	// because mapping edits to individual tasks is not something this layer can
	// do honestly.
	const mutated = mutationDelta === undefined ? totalMutations > 0 : mutationDelta > 0;
	if (mutated) return [];
	return transitions.map((todo) => String(todo.content ?? "").trim()).filter(Boolean);
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
				const content = String(todo.content ?? "").trim();
				newContentCounts.set(content, (newContentCounts.get(content) ?? 0) + 1);
			}
			const retainedReviewCounts = new Map<string, number>();
			for (const todo of activeNew) {
				const content = String(todo.content ?? "").trim();
				retainedReviewCounts.set(content, (retainedReviewCounts.get(content) ?? 0) + 1);
			}
			let retainedReviewObligations = 0;
			for (const todo of activeExisting) {
				const content = String(todo.content ?? "").trim();
				const remaining = retainedReviewCounts.get(content) ?? 0;
				if (remaining > 0 && isReviewObligation(content)) {
					retainedReviewCounts.set(content, remaining - 1);
					retainedReviewObligations++;
				}
			}
			let replacementReviewObligations = activeNew.filter((t) => isReviewObligation(String(t.content ?? ""))).length - retainedReviewObligations;
			const missing = activeExisting.find((todo) => {
				const content = String(todo.content ?? "").trim();
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
