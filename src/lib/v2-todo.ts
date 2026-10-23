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
 *   fail open.
 *
 * Capability is therefore probed, not inferred from history: `detectTodoCapability`
 * asks the host's tool registry (`ctx.tool.list()`) whether `todowrite` is
 * registered. History tells you whether a session planned; the registry tells
 * you whether planning was possible. Only the second question decides whether
 * an empty list means "not yet planned" or "cannot plan".
 *
 * This module distinguishes "definitively empty" from "cannot determine", which
 * the policy layer relies on to decide whether to enforce the active-todo gate.
 * Todos are never evidence: a `todowrite` call replaces the whole list, so a
 * model can mark everything completed without doing the work.
 */

import type { TodoItem } from "./types.ts";

/** Minimal session-context surface needed to read message history. */
export interface TodoScanContext {
	session: {
		context: (input: { sessionID: string }) => Promise<unknown>;
	};
}

/** Minimal tool-registry surface needed to probe for `todowrite`. */
export interface TodoCapabilityContext {
	tool?: {
		list?: () => Promise<unknown>;
	};
}

/**
 * Whether this host can plan at all.
 *
 * - `available`: the registry reports `todowrite`, so an empty list means the
 *   session never planned and the gate must enforce.
 * - `unavailable`: the registry answered and has no `todowrite`, so the gate
 *   must fail open or builtin-only sessions deadlock.
 * - `unknown`: the registry could not be read. Treat as unavailable for
 *   enforcement, but say so out loud (the caller logs once per session).
 */
export type TodoCapability = "available" | "unavailable" | "unknown";

/**
 * Probe the host's tool registry for `todowrite`.
 *
 * Tool ids on the host are effective names, so a namespaced or prefixed
 * registration (`todowrite`, `todo.write`) still counts. A registry that throws
 * or is absent reports `unknown` rather than `unavailable`, because "we could
 * not ask" must never be reported as "the host said no".
 */
export async function detectTodoCapability(ctx: TodoCapabilityContext | undefined): Promise<TodoCapability> {
	const list = ctx?.tool?.list;
	if (typeof list !== "function") return "unknown";
	try {
		const entries = await list.call(ctx!.tool);
		if (!Array.isArray(entries)) return "unknown";
		return entries.some((entry) => {
			const name = (entry as { name?: unknown; id?: unknown } | undefined)?.name ?? (entry as { id?: unknown } | undefined)?.id;
			return typeof name === "string" && /^todowrite$/i.test(name);
		})
			? "available"
			: "unavailable";
	} catch {
		return "unknown";
	}
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
 * Proven capability per plugin instance, for reporting and for the fail-open
 * warning. Held on `globalThis` via `Symbol.for` because OpenCode can load the
 * same package from two module paths (a cache copy plus a source checkout), and
 * the capability answer must agree between them.
 */
const TODO_CAPABILITY = Symbol.for("opencode-workflow-guard.todo-capability.v1");
const capabilityRegistry = globalThis as unknown as Record<symbol, TodoCapability | undefined>;

/** Last probed capability. `unknown` before setup, which fails open. */
export function recordedTodoCapability(): TodoCapability {
	return capabilityRegistry[TODO_CAPABILITY] ?? "unknown";
}

/**
 * Record the probed capability. Returns the previous value so the caller can
 * tell whether this is the first probe for the process.
 */
export function recordTodoCapability(capability: TodoCapability): TodoCapability {
	const previous = recordedTodoCapability();
	capabilityRegistry[TODO_CAPABILITY] = capability;
	return previous;
}

export function resetTodoCapabilityForTesting(): void {
	delete capabilityRegistry[TODO_CAPABILITY];
}

/**
 * Sessions already warned about the fail-open path. Bounded: the warning is
 * once per session, and a process that outlives thousands of sessions must not
 * leak a set for every one of them.
 */
const WARNED_SESSIONS = Symbol.for("opencode-workflow-guard.todo-warned.v2");
const warnedRegistry = globalThis as unknown as Record<symbol, Set<string> | undefined>;
const warnedSessions: Set<string> =
	warnedRegistry[WARNED_SESSIONS] ?? (warnedRegistry[WARNED_SESSIONS] = new Set());
const MAX_WARNED_SESSIONS = 512;

/**
 * Report the active-todo gate failing open, once per session.
 *
 * Silent fail-open is how a rails policy becomes decorative: the gate stops
 * enforcing and nothing says so. Returns true when this call was the first for
 * the session, so the caller can journal it exactly once.
 */
export function reportTodoGateFailOpen(sessionID: string | undefined, capability: TodoCapability): boolean {
	const key = sessionID ?? "<no-session>";
	if (warnedSessions.has(key)) return false;
	if (warnedSessions.size >= MAX_WARNED_SESSIONS) warnedSessions.clear();
	warnedSessions.add(key);
	try {
		console.warn(
			`[workflow-guard] warn: active-todo gate is not enforcing for session ${key}: ` +
				`todoCapability=${capability}. Mutations are allowed without an active todo.`,
		);
	} catch {}
	return true;
}

/**
 * Reconstruct one session's current todo list from its message history. The
 * newest applied `todowrite` tool call's input is the current state.
 *
 * Returns:
 * - `TodoItem[]` when a `todowrite` part defines the list, including `[]` when
 *   the newest applied call emptied it;
 * - `undefined` when todo state is unknown: the history cannot be read, or the
 *   session contains no `todowrite` part and the capability is absent.
 *
 * `capability` decides what an empty history means. When the host reports
 * `available`, a session with no `todowrite` part has never planned, so the
 * result is `[]` and the mutation gate enforces. When it is `unavailable` or
 * `unknown`, an empty history stays `undefined` so builtin-only sessions fail
 * open instead of deadlocking on a tool they cannot call.
 *
 * Callers must treat `undefined` as "cannot determine" (fail open) and `[]` as
 * "definitively no active todos" (enforce). Collapsing the two is what
 * deadlocks builtin-only V2 sessions, which can never create a todo.
 */
export async function scanSessionTodos(
	ctx: TodoScanContext,
	sessionID: string,
	capability: TodoCapability = "unknown",
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
		// No applied `todowrite` part. With a registered tool that means the
		// session never planned, which must gate. Without one, the session
		// cannot plan at all, so the gate has nothing to enforce.
		if (capability === "available") return [];
		// A `todowrite` part exists but none is applied yet (e.g. still
		// streaming): the list is in flux, report it as empty rather than
		// unknown so the gate stays closed until the write settles.
		return sawTodoWrite ? [] : undefined;
	} catch {
		return undefined;
	}
}
