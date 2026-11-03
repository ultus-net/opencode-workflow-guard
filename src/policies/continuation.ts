import { randomUUID } from "node:crypto";
import { getRalphMaxIterations, getSdkClient, getWorkspaceRoot, isRalphModeEnabled } from "../lib/state.ts";
import { projectRootKey } from "../lib/project-config.ts";
import { effectiveTodosWithOwner, hasActiveTodo } from "./todo.ts";

const MAX_CONSECUTIVE_CONTINUATIONS = 3;
const MAX_GENERATED_MESSAGE_IDS = 100;
const TITLE_SETTLE_MS = 250;
const TITLE_SETTLE_ATTEMPTS = 8;
const DEFAULT_SESSION_TITLE = /^(?:New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
type ContinuationState = {
	counts: Map<string, number>;
	ralphOutcomes: Map<string, RalphOutcome>;
	generatedMessageIDs: Map<string, Set<string>>;
	lastUserMessageIDs: Map<string, string>;
	inFlight: Set<string>;
	interrupted: Set<string>;
};
export type RalphOutcome = "running" | "completed" | "blocked" | "budget_exhausted" | "user_stopped";
const states = new WeakMap<object, Map<string, ContinuationState>>();

/**
 * Whether the active client is the V2 shim, which can carry `delivery` and
 * `resume` on a synthetic continuation. `session.synthetic` is the
 * discriminator: the V2 shim supplies it, and the V1 SDK client does not
 * declare it. `session.todo` is required alongside it only because this module
 * reads todos through the same surface, so a client missing it cannot be the
 * V2 shim for our purposes.
 */
function isV2Host(): boolean {
	const session = getSdkClient()?.session as { synthetic?: unknown; todo?: unknown } | undefined;
	return typeof session?.synthetic === "function" && typeof session?.todo === "function";
}

export async function waitForSessionTitle(sessionID: string): Promise<void> {
	const session = getSdkClient()?.session;
	if (typeof session?.get !== "function") return;
	for (let attempt = 0; attempt < TITLE_SETTLE_ATTEMPTS; attempt++) {
		// Register the wake-up BEFORE reading, then release it once the read is
		// done. A rename that commits during the read is therefore still
		// observed: registering afterwards would let it land in the gap between
		// the read and the registration, which reads as "not yet renamed" and
		// costs a whole extra interval even though the title already settled.
		const wait = beginRenameWait(sessionID);
		let settled = false;
		try {
			const current = (await session.get({ path: { id: sessionID } }))?.data;
			settled = Boolean(current?.parentID) || typeof current?.title !== "string" || !DEFAULT_SESSION_TITLE.test(current.title);
		} catch {
			wait.cancel();
			return;
		}
		if (settled) {
			wait.cancel();
			return;
		}
		if (attempt + 1 >= TITLE_SETTLE_ATTEMPTS) {
			wait.cancel();
			return;
		}
		await wait.promise;
	}
}

/**
 * A pending wait for one session's title, resolved by `session.renamed` or by
 * one poll interval elapsing.
 *
 * The poll exists because the host generates a title asynchronously and a
 * continuation sent too early can be titled with the placeholder. `title` is a
 * model-request hook, so it runs *before* the title is written and cannot
 * report that the write happened. `session.renamed` is delivered when it does,
 * so the normal case ends as soon as the title commits while the worst case
 * stays the old interval. A host that never emits the event keeps the old
 * timing exactly.
 */
function beginRenameWait(sessionID: string): { promise: Promise<void>; cancel: () => void } {
	const waiters = renaming.get(sessionID) ?? new Set<() => void>();
	renaming.set(sessionID, waiters);
	let finish!: () => void;
	const promise = new Promise<void>((resolve) => {
		finish = resolve;
	});
	let settled = false;
	const done = (): void => {
		if (settled) return;
		settled = true;
		waiters.delete(done);
		if (waiters.size === 0) renaming.delete(sessionID);
		clearTimeout(timer);
		finish();
	};
	waiters.add(done);
	// A plain timer, not `unref`: an unref'd timer lets the process exit while
	// this promise is still pending, which would drop the wait.
	const timer = setTimeout(done, TITLE_SETTLE_MS);
	return { promise, cancel: done };
}

/** Named `renaming` rather than `sessions` to read as the event, not the store. */
const renaming = new Map<string, Set<() => void>>();

/**
 * Wake any wait for this session's title. Called from the `session.renamed`
 * subscription; a session with no waiter is a no-op.
 */
export function notifySessionRenamed(sessionID: string): void {
	const waiters = renaming.get(sessionID);
	if (!waiters) return;
	for (const waiter of [...waiters]) waiter();
}

function getState(): ContinuationState | undefined {
	const client = getSdkClient();
	if (!client || (typeof client !== "object" && typeof client !== "function")) return undefined;
	let clientStates = states.get(client as object);
	if (!clientStates) {
		clientStates = new Map();
		states.set(client as object, clientStates);
	}
	const root = projectRootKey(getWorkspaceRoot());
	let state = clientStates.get(root);
	if (!state) {
		state = { counts: new Map(), ralphOutcomes: new Map(), generatedMessageIDs: new Map(), lastUserMessageIDs: new Map(), inFlight: new Set(), interrupted: new Set() };
		clientStates.set(root, state);
	}
	return state;
}

export async function continueUnfinishedSession(sessionID: string, settleTitle = false): Promise<boolean> {
	const state = getState();
	if (!state || state.inFlight.has(sessionID)) return false;
	state.inFlight.add(sessionID);
	try {
		const ralph = isRalphModeEnabled(getWorkspaceRoot());
		if (ralph && state.ralphOutcomes.get(sessionID) === "user_stopped") return false;
		// A user-initiated interrupt (Esc) suspends automatic continuation:
		// only genuine user input re-enables it (see recordUserMessage).
		if (state.interrupted.has(sessionID)) return false;
		const effective = await effectiveTodosWithOwner(sessionID);
		if (!effective || effective.ownerSessionID !== sessionID || !hasActiveTodo(effective.todos)) {
			if (ralph && state.ralphOutcomes.has(sessionID)) state.ralphOutcomes.set(sessionID, "completed");
			return false;
		}
		if (settleTitle) await waitForSessionTitle(sessionID);

		const count = state.counts.get(sessionID) ?? 0;
		const maxContinuations = ralph ? getRalphMaxIterations(getWorkspaceRoot()) : MAX_CONSECUTIVE_CONTINUATIONS;
		if (count >= maxContinuations) {
			if (ralph) state.ralphOutcomes.set(sessionID, "budget_exhausted");
			return false;
		}

		const session = getSdkClient()?.session;
		if (typeof session?.promptAsync !== "function") return false;

		const messageID = `msg_wg_${randomUUID().replace(/-/g, "")}`;
		state.counts.set(sessionID, count + 1);
		if (ralph) state.ralphOutcomes.set(sessionID, "running");
		const generatedIDs = state.generatedMessageIDs.get(sessionID) ?? new Set<string>();
		if (generatedIDs.size >= MAX_GENERATED_MESSAGE_IDS) {
			const oldestID = generatedIDs.values().next().value;
			if (oldestID) generatedIDs.delete(oldestID);
		}
		generatedIDs.add(messageID);
		state.generatedMessageIDs.set(sessionID, generatedIDs);
		const activeTasks = (effective.todos ?? [])
			.filter((t) => t.status === "in_progress" || t.status === "pending")
			.slice(0, 10);
		const tasksSummary = activeTasks.length > 0
			? "\nRemaining active tasks:\n" + activeTasks.map((t) => `- [${t.status === "in_progress" ? "IN_PROGRESS" : "PENDING"}] ${t.content}`).join("\n")
			: "";

		try {
			// Delivery and resume are stated explicitly so a V2 synthetic
			// continuation does not depend on host defaults. `queue` keeps it in
			// the session's inbox instead of steering an in-flight turn, and
			// `resume: true` starts a run when the session is idle.
			//
			// The fields are V2-only. The V1 SDK body type declares neither
			// (`SessionPromptAsyncData` in @opencode-ai/sdk), so adding them
			// there would send unmodelled fields to a strict server. The V2
			// client shim reads them off this same object, so the values travel
			// without changing the V1 request shape.
			const promptBody: {
				messageID: string;
				parts: Array<{ type: "text"; text: string; synthetic?: boolean }>;
				delivery?: "steer" | "queue";
				resume?: boolean;
			} = {
				messageID,
				parts: [{
					type: "text" as const,
					text: `Workflow Guard: unfinished todos remain. Continue working through them.${tasksSummary}\nIf you need user input, use the question tool instead of ending the run. Check guard_status for outstanding verification/review requirements, and guard_review_rubric before final completion.`,
					synthetic: true,
				}],
			};
			if (isV2Host()) {
				promptBody.delivery = "queue";
				promptBody.resume = true;
			}
			await session.promptAsync({ path: { id: sessionID }, body: promptBody });
			return true;
		} catch {
			state.counts.set(sessionID, count);
			generatedIDs.delete(messageID);
			if (generatedIDs.size === 0) state.generatedMessageIDs.delete(sessionID);
			return false;
		}
	} finally {
		state.inFlight.delete(sessionID);
	}
}

export function recordUserMessage(sessionID: string, messageID?: string): void {
	const state = getState();
	if (!state) return;
	const generatedIDs = state.generatedMessageIDs.get(sessionID);
	if (messageID && generatedIDs?.has(messageID)) return;
	if (messageID && state.lastUserMessageIDs.get(sessionID) === messageID) return;
	if (messageID) state.lastUserMessageIDs.set(sessionID, messageID);
	state.counts.delete(sessionID);
	state.interrupted.delete(sessionID);
	if (isRalphModeEnabled(getWorkspaceRoot()) && state.ralphOutcomes.has(sessionID)) {
		if (state.ralphOutcomes.get(sessionID) === "user_stopped") state.ralphOutcomes.delete(sessionID);
		else state.ralphOutcomes.set(sessionID, "user_stopped");
	}
}

// Record a user-initiated interrupt (Esc): the session's run was aborted
// from the user side, so automatic continuation must stop. Ralph runs are
// marked user_stopped, mirroring genuine user input. A later genuine user
// message re-enables continuation (recordUserMessage clears the flag).
export function markInterrupted(sessionID: string): void {
	const state = getState();
	if (!state) return;
	state.interrupted.add(sessionID);
	if (isRalphModeEnabled(getWorkspaceRoot()) && state.ralphOutcomes.has(sessionID)) {
		state.ralphOutcomes.set(sessionID, "user_stopped");
	}
}

export function getRalphOutcome(sessionID: string): RalphOutcome | undefined {
	return getState()?.ralphOutcomes.get(sessionID);
}

export function isGeneratedContinuationMessage(sessionID: string, messageID?: string): boolean {
	if (!messageID) return false;
	return getState()?.generatedMessageIDs.get(sessionID)?.has(messageID) === true;
}

export function clearContinuationState(sessionID: string): void {
	const state = getState();
	if (!state) return;
	state.counts.delete(sessionID);
	state.ralphOutcomes.delete(sessionID);
	state.generatedMessageIDs.delete(sessionID);
	state.lastUserMessageIDs.delete(sessionID);
	state.inFlight.delete(sessionID);
	state.interrupted.delete(sessionID);
}
