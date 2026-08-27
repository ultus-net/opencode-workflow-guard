import { randomUUID } from "node:crypto";
import { getSdkClient } from "../lib/state.ts";
import { effectiveTodosWithOwner, hasActiveTodo } from "./todo.ts";

const MAX_CONSECUTIVE_CONTINUATIONS = 3;
const TITLE_SETTLE_MS = 250;
const TITLE_SETTLE_ATTEMPTS = 8;
const DEFAULT_SESSION_TITLE = /^(?:New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
type ContinuationState = {
	counts: Map<string, number>;
	generatedMessageIDs: Map<string, Set<string>>;
	inFlight: Set<string>;
};
const states = new WeakMap<object, ContinuationState>();

export async function waitForSessionTitle(sessionID: string): Promise<void> {
	const session = getSdkClient()?.session;
	if (typeof session?.get !== "function") return;
	for (let attempt = 0; attempt < TITLE_SETTLE_ATTEMPTS; attempt++) {
		try {
			const current = (await session.get({ path: { id: sessionID } }))?.data;
			if (current?.parentID || typeof current?.title !== "string" || !DEFAULT_SESSION_TITLE.test(current.title)) return;
		} catch {
			return;
		}
		if (attempt + 1 < TITLE_SETTLE_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, TITLE_SETTLE_MS));
	}
}

function getState(): ContinuationState | undefined {
	const client = getSdkClient();
	if (!client || (typeof client !== "object" && typeof client !== "function")) return undefined;
	let state = states.get(client as object);
	if (!state) {
		state = { counts: new Map(), generatedMessageIDs: new Map(), inFlight: new Set() };
		states.set(client as object, state);
	}
	return state;
}

export async function continueUnfinishedSession(sessionID: string, settleTitle = false): Promise<boolean> {
	const state = getState();
	if (!state || state.inFlight.has(sessionID)) return false;
	state.inFlight.add(sessionID);
	try {
		const effective = await effectiveTodosWithOwner(sessionID);
		if (!effective || effective.ownerSessionID !== sessionID || !hasActiveTodo(effective.todos)) return false;
		if (settleTitle) await waitForSessionTitle(sessionID);

		const count = state.counts.get(sessionID) ?? 0;
		if (count >= MAX_CONSECUTIVE_CONTINUATIONS) return false;

		const session = getSdkClient()?.session;
		if (typeof session?.promptAsync !== "function") return false;

		const messageID = `workflow-guard-${randomUUID()}`;
		state.counts.set(sessionID, count + 1);
		const generatedIDs = state.generatedMessageIDs.get(sessionID) ?? new Set<string>();
		generatedIDs.add(messageID);
		state.generatedMessageIDs.set(sessionID, generatedIDs);
		try {
			await session.promptAsync({
				path: { id: sessionID },
				body: {
					messageID,
					parts: [{
						type: "text",
						text: "Workflow Guard: unfinished todos remain. Continue working through them. If you need user input, use the question tool instead of ending the run.",
						synthetic: true,
					}],
				},
			});
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
	if (messageID && generatedIDs?.delete(messageID)) {
		if (generatedIDs.size === 0) state.generatedMessageIDs.delete(sessionID);
		return;
	}
	state.counts.delete(sessionID);
}

export function isGeneratedContinuationMessage(sessionID: string, messageID?: string): boolean {
	if (!messageID) return false;
	return getState()?.generatedMessageIDs.get(sessionID)?.has(messageID) === true;
}

export function clearContinuationState(sessionID: string): void {
	const state = getState();
	if (!state) return;
	state.counts.delete(sessionID);
	state.generatedMessageIDs.delete(sessionID);
	state.inFlight.delete(sessionID);
}
