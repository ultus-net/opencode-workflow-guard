import type { TodoItem } from "../lib/types.ts";
import { getSdkClient } from "../lib/state.ts";

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
	const client = getSdkClient();
	const session = client?.session;
	const get = session?.get;
	if (typeof get !== "function") return undefined;
	try {
		const result = await get.call(session, { path: { id: sessionID } });
		const parent = (result as { data?: { parentID?: unknown } } | undefined)?.data?.parentID;
		return typeof parent === "string" && parent ? parent : undefined;
	} catch {
		return undefined;
	}
}

export async function effectiveTodos(
	sessionID: string | undefined,
): Promise<TodoItem[] | undefined> {
	if (!sessionID) return undefined;
	const seen = new Set<string>();
	let current: string | undefined = sessionID;
	while (current && !seen.has(current)) {
		seen.add(current);
		const todos = await fetchSessionTodos(current);
		if (todos === undefined) return undefined;
		if (todos.length > 0) return todos;
		current = await fetchParentSessionID(current);
	}
	return [];
}

export async function effectiveTodoOwnerSessionID(
	sessionID: string | undefined,
): Promise<string | undefined> {
	if (!sessionID) return undefined;
	const seen = new Set<string>();
	let current: string | undefined = sessionID;
	while (current && !seen.has(current)) {
		seen.add(current);
		const todos = await fetchSessionTodos(current);
		if (todos === undefined) return sessionID;
		if (todos.length > 0) return current;
		current = await fetchParentSessionID(current);
	}
	return sessionID;
}

export function hasActiveTodo(todos: TodoItem[]): boolean {
	return todos.some((todo) => ACTIVE_TODO_STATUSES.has(String(todo.status ?? "")));
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
			const newContentCounts = new Map<string, number>();
			for (const todo of newTodos) {
				const content = String(todo.content ?? "").trim();
				newContentCounts.set(content, (newContentCounts.get(content) ?? 0) + 1);
			}
			const missing = activeExisting.find((todo) => {
				const content = String(todo.content ?? "").trim();
				const remaining = newContentCounts.get(content) ?? 0;
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
