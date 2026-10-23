/**
 * Cross-instance tool-call claiming.
 *
 * OpenCode 2 merges plugin arrays, so naming the guard in both the global and
 * the project config loads the same module twice under two ids. Both instances
 * register `tool.execute.before`, which evaluated and audited every call twice
 * and let a second instance's decision shadow the first.
 *
 * The first instance to reach a given (session, call, tool) owns the decision.
 * A second instance for the same call defers instead of evaluating again, so a
 * call produces exactly one policy decision and one decision audit record.
 * Within a single instance nothing is skipped: the claim only deduplicates
 * *across* instances, because one instance must still evaluate each of its own
 * calls even if a host reuses call ids.
 */

const MAX_CLAIMS = 4096;
// Process-global, not module-global: OpenCode can load the guard from two
// distinct paths (a cache copy plus a source checkout), and each copy
// evaluates this module separately. A `Symbol.for` slot on `globalThis` keeps
// ONE claim table so the second copy still defers to the first.
const CLAIMS_REGISTRY = Symbol.for("opencode-workflow-guard.call-claims.v1");
const globalRegistry = globalThis as unknown as Record<symbol, Map<string, string> | undefined>;
const claims: Map<string, string> = globalRegistry[CLAIMS_REGISTRY] ?? (globalRegistry[CLAIMS_REGISTRY] = new Map());

function claimKey(sessionID: string | undefined, callID: string | undefined, tool: string): string | undefined {
	if (!sessionID || !callID) return undefined;
	return `${sessionID}::${callID}::${tool}`;
}

/**
 * Claim a tool call for `instanceKey`. Returns true when the caller owns the
 * decision. Returns false when another instance already claimed it, which means
 * the caller must defer (no evaluation, no audit) to keep one decision per call.
 */
export function claimToolCall(
	instanceKey: string,
	sessionID: string | undefined,
	callID: string | undefined,
	tool: string,
): boolean {
	const key = claimKey(sessionID, callID, tool);
	if (!key) return true;
	const owner = claims.get(key);
	if (owner === undefined) {
		claims.set(key, instanceKey);
		if (claims.size > MAX_CLAIMS) {
			const oldest = claims.keys().next().value;
			if (oldest !== undefined) claims.delete(oldest);
		}
		return true;
	}
	return owner === instanceKey;
}

/** Release a claim after the call settles so the map stays bounded in long sessions. */
export function releaseToolCallClaim(
	instanceKey: string,
	sessionID: string | undefined,
	callID: string | undefined,
	tool: string,
): void {
	const key = claimKey(sessionID, callID, tool);
	if (!key) return;
	if (claims.get(key) === instanceKey) claims.delete(key);
}

/** Test seam. */
export function resetToolCallClaimsForTesting(): void {
	claims.clear();
}
