/**
 * V2 todo reconstruction shared by the plugin entrypoint and its V1 SDK
 * adapter.
 *
 * Version boundary, because the two generations need different treatment:
 *
 * - **OpenCode 2.0.x** exposes no todo endpoint and its builtin tool registry
 *   has no `todowrite` (the V1 name). Todo state only exists when an ACP agent
 *   supplies its own `todowrite` tool, so the list is reconstructed from
 *   session message history.
 * - **OpenCode 2.1.x** reintroduces a builtin `todowrite` behind the
 *   `experimental.todo` config key. When that tool is registered, a session
 *   with no todo part has never planned, which must gate mutations rather than
 *   fail open. `todoCapability` in this module reports which case applies, and
 *   the caller decides whether history reconstruction is authoritative.
 *
 * This module reads that state from session message history and distinguishes
 * "definitively empty" from "cannot determine", which the policy layer relies
 * on to decide whether to enforce the active-todo gate. Todos are never
 * evidence: a `todowrite` call replaces the whole list, so a model can mark
 * everything completed without doing the work.
 */

import type { TodoItem } from "./types.ts";

/** Minimal session-context surface needed to read message history. */
export interface TodoScanContext {
	session: {
		context: (input: { sessionID: string }) => Promise<unknown>;
	};
}

/**
 * V2 tool parts carry the tool name in `tool` (the V1 field was `name`); ACP
 * agents may still report either shape, so accept both.
 */
export function toolPartName(part: { tool?: unknown; name?: unknown }): string | undefined {
	if (typeof part.tool === "string") return part.tool;
	if (typeof part.name === "string") return part.name;
	return undefined;
}

/**
 * Reconstruct one session's current todo list from its message history. The
 * newest applied `todowrite` tool call's input is the current state.
 *
 * Returns:
 * - `TodoItem[]` when a `todowrite` part defines the list, including `[]` when
 *   the newest applied call emptied it;
 * - `undefined` when todo state is unknown: the history cannot be read, or the
 *   session contains no `todowrite` part at all (no todo capability).
 *
 * Callers must treat `undefined` as "cannot determine" (fail open) and `[]` as
 * "definitively no active todos" (enforce). Collapsing the two is what
 * deadlocks builtin-only V2 sessions, which can never create a todo.
 */
export async function scanSessionTodos(
	ctx: TodoScanContext,
	sessionID: string,
): Promise<TodoItem[] | undefined> {
	try {
		const messages = (await ctx.session.context({ sessionID })) as unknown as Array<{ content?: unknown }>;
		if (!Array.isArray(messages)) return undefined;
		let sawTodoWrite = false;
		for (let i = messages.length - 1; i >= 0; i--) {
			const content = (messages[i] as { content?: unknown })?.content;
			if (!Array.isArray(content)) continue;
			for (let j = content.length - 1; j >= 0; j--) {
				const part = content[j] as { type?: string; tool?: unknown; name?: unknown; state?: { status?: string; input?: { todos?: unknown } } };
				if (part?.type !== "tool") continue;
				const toolName = toolPartName(part);
				if (toolName === undefined || !/^todowrite$/i.test(toolName)) continue;
				sawTodoWrite = true;
				const status = part.state?.status;
				if (status === "pending" || status === "streaming" || status === "running") continue;
				const todos = part.state?.input?.todos;
				if (Array.isArray(todos)) return todos as TodoItem[];
			}
		}
		// A `todowrite` part exists but none is applied yet (e.g. still
		// streaming): the list is in flux, report it as empty rather than
		// unknown so the gate stays closed until the write settles.
		return sawTodoWrite ? [] : undefined;
	} catch {
		return undefined;
	}
}
