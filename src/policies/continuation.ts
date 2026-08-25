import { randomUUID } from "node:crypto";
import { getSdkClient } from "../lib/state.ts";
import { effectiveTodosWithOwner, hasActiveTodo } from "./todo.ts";

const MAX_CONSECUTIVE_CONTINUATIONS = 3;
type ContinuationState = {
	counts: Map<string, number>;
	generatedMessageIDs: Map<string, Set<string>>;
	inFlight: Set<string>;
};
const states = new WeakMap<object, ContinuationState>();

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

export async function continueUnfinishedSession(sessionID: string): Promise<boolean> {
	const state = getState();
	if (!state || state.inFlight.has(sessionID)) return false;
	state.inFlight.add(sessionID);
	try {
		const effective = await effectiveTodosWithOwner(sessionID);
		if (!effective || !hasActiveTodo(effective.todos) || effective.ownerSessionID !== sessionID) return false;

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
