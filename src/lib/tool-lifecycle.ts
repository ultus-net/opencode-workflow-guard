import type { FileSnapshot } from "../policies/post-edit-validation.ts";
import type { ReadObservation } from "../policies/stale-write.ts";

function invocationKey(sessionID: string, callID: string): string {
	return `${sessionID}\0${callID}`;
}

export class ToolInvocationLifecycle {
	private readonly postEditSnapshots = new Map<string, { root: string; snapshots: FileSnapshot[] }>();
	private readonly startedAt = new Map<string, number>();
	private readonly readObservations = new Map<string, ReadObservation>();
	private readonly recoveryRuns = new Map<string, number>();

	start(sessionID: string, callID: string): void {
		this.startedAt.set(invocationKey(sessionID, callID), Date.now());
	}

	finish(sessionID: string, callID: string): number | undefined {
		const key = invocationKey(sessionID, callID);
		const startedAt = this.startedAt.get(key);
		this.startedAt.delete(key);
		return startedAt;
	}

	setReadObservation(sessionID: string, callID: string, observation: ReadObservation): void {
		this.readObservations.set(invocationKey(sessionID, callID), observation);
	}

	takeReadObservation(sessionID: string, callID: string): ReadObservation | undefined {
		const key = invocationKey(sessionID, callID);
		const observation = this.readObservations.get(key);
		this.readObservations.delete(key);
		return observation;
	}

	setPostEditSnapshots(sessionID: string, callID: string, root: string, snapshots: FileSnapshot[]): void {
		this.postEditSnapshots.set(invocationKey(sessionID, callID), { root, snapshots });
	}

	takePostEditSnapshots(sessionID: string, callID: string): { root: string; snapshots: FileSnapshot[] } | undefined {
		const key = invocationKey(sessionID, callID);
		const snapshots = this.postEditSnapshots.get(key);
		this.postEditSnapshots.delete(key);
		return snapshots;
	}

	setRecoveryRun(sessionID: string, run: number): void {
		this.recoveryRuns.set(sessionID, run);
	}

	takeRecoveryRun(sessionID: string): number | undefined {
		const run = this.recoveryRuns.get(sessionID);
		this.recoveryRuns.delete(sessionID);
		return run;
	}

	clearSession(sessionID: string): void {
		const prefix = `${sessionID}\0`;
		for (const map of [this.startedAt, this.readObservations, this.postEditSnapshots]) {
			for (const key of map.keys()) {
				if (key.startsWith(prefix)) map.delete(key);
			}
		}
	}
}
