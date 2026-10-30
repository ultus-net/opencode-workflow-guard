import { dogfoodEvidence } from "./evidence.ts";
import { getDogfoodDeployMatrix, getDogfoodRecordsForWorkspace, isDogfoodRequired } from "./state.ts";
import { getCurrentGitCommitHash, getTrackedWorktreeFingerprint } from "./verify.ts";
import type { DogfoodResult } from "./types.ts";

export interface DogfoodGateResult {
	required: boolean;
	/** Matrix hosts still missing a fresh passing record. */
	missingHosts: string[];
	/** The record that satisfied the gate, when one did. */
	matched?: DogfoodResult;
	/** Every record counted toward the gate, one per host. */
	matchedRecords?: DogfoodResult[];
	/** Why the gate is unsatisfied, cause-attributed. */
	reason?: string;
	/** Evidence id of the matched record, for audit correlation. */
	evidenceId?: string;
}

/**
 * Why one record cannot count for this worktree, or undefined when it can.
 *
 * Each cause is named separately because they have different remedies. A
 * missing fingerprint is an environment problem, a fingerprint mismatch is a
 * stale run, and a commit mismatch is an unrecorded commit. Collapsing them
 * into one message sends the agent looking for the wrong fix.
 */
function stalenessReason(record: DogfoodResult, commitHash: string | undefined, fingerprint: string | undefined): string | undefined {
	if (!fingerprint) {
		return "Worktree fingerprint could not be computed (git unavailable or worktree unreadable), so dogfood evidence cannot be bound to this worktree; resolve worktree readability and re-run the dogfood scenario.";
	}
	if (!record.worktreeFingerprint) {
		return `The recorded dogfood run ('${record.scenarioId}') has no worktree fingerprint binding (recorded against an unreadable worktree); re-run the dogfood scenario and record it with record_dogfood.`;
	}
	if (record.worktreeFingerprint !== fingerprint) {
		return `The recorded dogfood run ('${record.scenarioId}' on '${record.host.label}') does not match the current worktree contents (tracked content changed after the run); re-run the dogfood scenario and record it with record_dogfood.`;
	}
	if (record.commitHash && commitHash && record.commitHash !== commitHash) {
		return `The recorded dogfood run ('${record.scenarioId}' on '${record.host.label}') is bound to commit ${record.commitHash.slice(0, 12)} but this worktree is at commit ${commitHash.slice(0, 12)}; re-run the dogfood scenario at the current commit and record it with record_dogfood.`;
	}
	return undefined;
}

/**
 * Judges the dogfood gate for one worktree.
 *
 * Shared by PR preflight and `guard_status` so the two can never disagree about
 * whether the gate is satisfied. Freshness is content-scoped, matching review:
 * a record covers the tracked tree it ran against, so untracked scratch
 * cleanup cannot invalidate it while any tracked edit or new commit does.
 */
export function evaluateDogfoodGate(root: string): DogfoodGateResult {
	if (!isDogfoodRequired(root)) return { required: false, missingHosts: [] };
	const matrix = getDogfoodDeployMatrix(root);
	const records = getDogfoodRecordsForWorkspace(root);
	const commitHash = getCurrentGitCommitHash(root);
	const fingerprint = getTrackedWorktreeFingerprint(root);

	if (records.length === 0) {
		return {
			required: true,
			missingHosts: matrix.length > 0 ? matrix : ["this host"],
			reason: "Passing dogfood evidence is required (requireDogfood); run the dogfood runner and record the result with record_dogfood.",
		};
	}

	// Only the newest record per host can count. An older pass is superseded by
	// a newer run of the same host, including a newer HOLD, so a stale pass
	// cannot hide a regression the same host later found. A same-millisecond
	// tie resolves to the HOLD explicitly: re-running is cheap, and trusting a
	// stale pass is the failure that matters.
	// A record that cannot be judged either way must not win by luck. Records
	// arrive newest first, so the later entry wins a same-millisecond tie, and a
	// HOLD is preferred explicitly: re-running is cheap, and trusting a stale
	// pass is the failure that matters.
	const newestPerHost = new Map<string, DogfoodResult>();
	for (const record of records) {
		const seen = newestPerHost.get(record.host.label);
		if (!seen || record.timestamp > seen.timestamp) {
			newestPerHost.set(record.host.label, record);
		} else if (record.timestamp === seen.timestamp && seen.verdict === "pass" && record.verdict === "hold") {
			newestPerHost.set(record.host.label, record);
		}
	}

	const unmatched: string[] = [];
	const held: DogfoodResult[] = [];
	const stale: Array<{ record: DogfoodResult; reason: string }> = [];
	const matchedRecords: DogfoodResult[] = [];
	for (const [host, record] of newestPerHost) {
		if (record.verdict !== "pass") {
			held.push(record);
			if (matrix.length === 0 || matrix.includes(host)) unmatched.push(host);
			continue;
		}
		const reason = stalenessReason(record, commitHash, fingerprint);
		if (reason) {
			stale.push({ record, reason });
			if (matrix.length === 0 || matrix.includes(host)) unmatched.push(host);
			continue;
		}
		if (matrix.length > 0 && !matrix.includes(host)) continue;
		matchedRecords.push(record);
	}

	if (matrix.length > 0) {
		for (const host of matrix) if (!newestPerHost.has(host)) unmatched.push(host);
	}

	if (unmatched.length > 0) {
		const missingHosts = [...new Set(unmatched)];
		// A HOLD is more actionable than a matrix gap, so name it first.
		if (held.length > 0) {
			const first = held[0];
			return {
				required: true,
				missingHosts,
				reason: `The most recent dogfood run for host '${first.host.label}' ('${first.scenarioId}') returned HOLD${first.taxonomyClass ? ` with class '${first.taxonomyClass}'` : ""}; fix the finding and re-run before opening a PR.`,
			};
		}
		if (stale.length > 0) {
			return { required: true, missingHosts, reason: stale[0].reason };
		}
		const outsideMatrix = [...newestPerHost.keys()].filter((host) => !matrix.includes(host));
		if (matrix.length > 0 && matchedRecords.length === 0 && outsideMatrix.length > 0) {
			return {
				required: true,
				missingHosts,
				reason: `Dogfood evidence was recorded for host(s) ${outsideMatrix.join(", ")}, which are not in the deploy matrix (${matrix.join(", ")}); run the dogfood scenario on each matrix host and record each result.`,
			};
		}
		return {
			required: true,
			missingHosts,
			reason: `Dogfood evidence is missing for host(s) ${missingHosts.join(", ")} in the deploy matrix (${matrix.join(", ")}); run the dogfood scenario on each and record each result with record_dogfood.`,
		};
	}

	// Satisfied. Report the newest contributing record, and keep the per-host
	// set so the caller can journal every host that was actually covered.
	const newest = matchedRecords.reduce<DogfoodResult | undefined>((best, record) => !best || record.timestamp > best.timestamp ? record : best, undefined);
	return { required: true, missingHosts: [], matched: newest, matchedRecords, evidenceId: newest ? dogfoodEvidence(newest).id : undefined };
}
