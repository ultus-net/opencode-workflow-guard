import { createHash } from "node:crypto";

export interface ToolOutcomePart {
	type?: unknown;
	sessionID?: unknown;
	callID?: unknown;
	tool?: unknown;
	state?: {
		status?: unknown;
		error?: unknown;
		time?: { start?: unknown; end?: unknown };
	};
}

export interface ToolOutcome {
	sessionID: string;
	callID: string;
	tool: string;
	status: "completed" | "error";
	durationMs?: number;
	repeatedFailureCount?: number;
}

const MAX_TRACKED_CALLS = 4096;

export class ToolOutcomeTracker {
	private readonly terminalCalls = new Map<string, Set<string>>();
	private readonly fallbackCalls = new Map<string, Set<string>>();
	private readonly failures = new Map<string, { signature: string; count: number }>();

	record(part: ToolOutcomePart): ToolOutcome | undefined {
		if (part.type !== "tool" || typeof part.sessionID !== "string" || typeof part.callID !== "string" || typeof part.tool !== "string") return undefined;
		const status = part.state?.status;
		if (status !== "completed" && status !== "error") return undefined;
		let terminalCalls = this.terminalCalls.get(part.sessionID);
		if (!terminalCalls) {
			terminalCalls = new Set();
			this.terminalCalls.set(part.sessionID, terminalCalls);
		}
		if (terminalCalls.has(part.callID)) return undefined;
		const fallbackCalls = this.fallbackCalls.get(part.sessionID);
		if (fallbackCalls?.delete(part.callID) && status === "completed") {
			terminalCalls.add(part.callID);
			return undefined;
		}
		terminalCalls.add(part.callID);
		if (terminalCalls.size > MAX_TRACKED_CALLS) terminalCalls.delete(terminalCalls.values().next().value!);

		const start = part.state?.time?.start;
		const end = part.state?.time?.end;
		const durationMs = typeof start === "number" && Number.isFinite(start) && typeof end === "number" && Number.isFinite(end) ? Math.max(0, end - start) : undefined;
		if (status === "completed") {
			this.failures.delete(part.sessionID);
			return { sessionID: part.sessionID, callID: part.callID, tool: part.tool, status, durationMs };
		}

		const error = typeof part.state?.error === "string" ? part.state.error : "";
		const signature = createHash("sha256").update(`${part.tool}\0${error}`).digest("hex");
		const previous = this.failures.get(part.sessionID);
		const count = previous?.signature === signature ? previous.count + 1 : 1;
		this.failures.set(part.sessionID, { signature, count });
		return { sessionID: part.sessionID, callID: part.callID, tool: part.tool, status, durationMs, repeatedFailureCount: count };
	}

	recordFallbackCompleted(sessionID: string, callID: string, tool: string, durationMs?: number): ToolOutcome | undefined {
		if (this.terminalCalls.get(sessionID)?.has(callID) || this.fallbackCalls.get(sessionID)?.has(callID)) return undefined;
		let fallbackCalls = this.fallbackCalls.get(sessionID);
		if (!fallbackCalls) {
			fallbackCalls = new Set();
			this.fallbackCalls.set(sessionID, fallbackCalls);
		}
		fallbackCalls.add(callID);
		if (fallbackCalls.size > MAX_TRACKED_CALLS) fallbackCalls.delete(fallbackCalls.values().next().value!);
		return { sessionID, callID, tool, status: "completed", durationMs };
	}

	clearSession(sessionID: string): void {
		this.failures.delete(sessionID);
		this.terminalCalls.delete(sessionID);
		this.fallbackCalls.delete(sessionID);
	}
}
