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
};
export type RalphOutcome = "running" | "completed" | "blocked" | "budget_exhausted" | "user_stopped";
const states = new WeakMap<object, Map<string, ContinuationState>>();

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
	let clientStates = states.get(client as object);
	if (!clientStates) {
		clientStates = new Map();
		states.set(client as object, clientStates);
	}
	const root = projectRootKey(getWorkspaceRoot());
	let state = clientStates.get(root);
	if (!state) {
		state = { counts: new Map(), ralphOutcomes: new Map(), generatedMessageIDs: new Map(), lastUserMessageIDs: new Map(), inFlight: new Set() };
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

		const messageID = `workflow-guard-${randomUUID()}`;
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
			await session.promptAsync({
				path: { id: sessionID },
				body: {
					messageID,
					parts: [{
						type: "text",
						text: `Workflow Guard: unfinished todos remain. Continue working through them.${tasksSummary}\nIf you need user input, use the question tool instead of ending the run.`,
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
	if (messageID && generatedIDs?.has(messageID)) return;
	if (messageID && state.lastUserMessageIDs.get(sessionID) === messageID) return;
	if (messageID) state.lastUserMessageIDs.set(sessionID, messageID);
	state.counts.delete(sessionID);
	if (isRalphModeEnabled(getWorkspaceRoot()) && state.ralphOutcomes.has(sessionID)) {
		if (state.ralphOutcomes.get(sessionID) === "user_stopped") state.ralphOutcomes.delete(sessionID);
		else state.ralphOutcomes.set(sessionID, "user_stopped");
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
}
