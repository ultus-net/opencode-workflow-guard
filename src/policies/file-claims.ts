import { readlinkSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { audit } from "../lib/audit.ts";
import { getProjectConfig, getSdkClient, getWorkspaceRoot } from "../lib/state.ts";

interface FileClaim {
	sessionID: string;
	callID: string;
	/** Creation timestamp; a claim older than its owner's last idle is stale. */
	ts: number;
}

const claims = new Map<string, FileClaim>();

/** Default claim TTL: a claim this old is leaked, because a tool call is not that long. */
export const DEFAULT_FILE_CLAIM_TTL_MS = 5 * 60_000;

/**
 * Effective claim TTL: `WORKFLOW_GUARD_CLAIM_TTL_MS` wins, then project config
 * `claimTtlMs`, then the 5-minute default. Non-positive or unparseable values
 * fall back to the default so a typo cannot disable expiry.
 */
export function fileClaimTtlMs(root: string = getWorkspaceRoot()): number {
	const envValue = Number(process.env.WORKFLOW_GUARD_CLAIM_TTL_MS);
	if (Number.isFinite(envValue) && envValue > 0) return envValue;
	const configured = getProjectConfig(root).claimTtlMs;
	return typeof configured === "number" && Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_FILE_CLAIM_TTL_MS;
}

export function canonicalPath(path: string, seen = new Set<string>()): string {
	const resolved = resolve(path);
	if (seen.has(resolved)) return resolved;
	seen.add(resolved);
	try {
		return realpathSync(resolved);
	} catch {
		try {
			return canonicalPath(resolve(dirname(resolved), readlinkSync(resolved)), seen);
		} catch {}
		let ancestor = dirname(resolved);
		while (true) {
			try {
				return resolve(realpathSync(ancestor), relative(ancestor, resolved));
			} catch {
				const parent = dirname(ancestor);
				if (parent === ancestor) return resolved;
				ancestor = parent;
			}
		}
	}
}

export function claimFiles(paths: string[], sessionID: string, callID: string): string | undefined {
	const canonical = [...new Set(paths.map((path) => canonicalPath(path)))];
	const conflict = fileClaimConflictReason(canonical, sessionID);
	if (conflict) return conflict;
	for (const path of canonical) {
		const existing = claims.get(path);
		if (!existing) {
			claims.set(path, { sessionID, callID, ts: Date.now() });
		} else if (existing.sessionID === sessionID) {
			// The same session re-claiming the path refreshes the claim so the
			// timestamp (and callID) reflect the in-flight call: stale-takeover
			// never fires for it, and the after-hook release matches.
			claims.set(path, { sessionID, callID, ts: Date.now() });
		}
	}
	return undefined;
}

export function fileClaimConflictReason(paths: string[], sessionID: string, root: string = getWorkspaceRoot()): string | undefined {
	const canonical = [...new Set(paths.map((path) => canonicalPath(path)))];
	const ttlMs = fileClaimTtlMs(root);
	for (const path of canonical) {
		const existing = claims.get(path);
		if (existing && existing.sessionID !== sessionID) {
			const ageMs = Math.max(0, Date.now() - existing.ts);
			const remainingSec = Math.max(1, Math.ceil((ttlMs - ageMs) / 1000));
			return `Blocked: file '${path}' is claimed by session '${existing.sessionID}' (claimed ${Math.round(ageMs / 1000)}s ago). Reclaim step: retry after the claim TTL (${remainingSec}s remaining), when the guard releases and audits a stale claim. Otherwise wait for that session's edit to finish, or use an isolated worktree.`;
		}
	}
	return undefined;
}

/**
 * A claim is normally released by its owning tool call (after-hook) or by the
 * owner's session.idle/session.deleted events. When an idle release is missed,
 * the claim would otherwise block every other session forever. Two provable
 * staleness rules reclaim it, each audited:
 *
 * - TTL: a claim older than `claimTtlMs` cannot belong to an in-flight tool
 *   call. It is released even when the owner's session record cannot be read,
 *   which covers a deleted session and a server restart.
 * - Idle: a claim created BEFORE its owner's last recorded idle timestamp
 *   finished before the turn ended. Without an SDK client, or when the owner
 *   record cannot be read, this rule releases nothing: fail-closed keeps live
 *   two-session protection intact.
 *
 * Clock skew between this process and the server is not expected for a local
 * (same-host) service: negative skew fails closed; forward skew could make
 * fresh claims look stale and is accepted for that deployment. Concurrent
 * claimants can emit duplicate reclaim audits (append-only, harmless). Release
 * is per-claim: only claims whose ts is provably stale are dropped, re-read
 * AFTER the lookup round-trip so an owner that re-claimed (and refreshed) a
 * path meanwhile keeps its live claim.
 */
export async function releaseStaleFileClaims(paths: string[], claimantSessionID: string, root: string = getWorkspaceRoot()): Promise<void> {
	const canonical = [...new Set(paths.map((path) => canonicalPath(path)))];
	// A claim older than the TTL cannot belong to an in-flight tool call, so it
	// is a leak from a session that ended without an idle/deleted release. It
	// is released even when the owner's record cannot be read (a deleted
	// session, a missing SDK lookup, a server restart), with an audited
	// reclaim. Only the contended paths are examined, so a long-running command
	// elsewhere keeps its claim.
	const ttlMs = fileClaimTtlMs(root);
	const now = Date.now();
	for (const claimPath of canonical) {
		const claim = claims.get(claimPath);
		if (!claim || claim.sessionID === claimantSessionID) continue;
		if (now - claim.ts < ttlMs) continue;
		claims.delete(claimPath);
		audit({
			ts: new Date().toISOString(),
			sessionID: claimantSessionID,
			tool: "file-claims",
			decision: "allow",
			phase: "event",
			reason: "claim_ttl_expired",
			evidence: { mutation: false, targetPath: claimPath, claimOwnerSessionID: claim.sessionID, claimAgeMs: now - claim.ts },
		});
	}
	const staleOwners = new Map<string, string>();
	for (const path of canonical) {
		const existing = claims.get(path);
		if (existing && existing.sessionID !== claimantSessionID && !staleOwners.has(existing.sessionID)) {
			staleOwners.set(existing.sessionID, path);
		}
	}
	if (staleOwners.size === 0) return;
	const client = getSdkClient();
	const session = client?.session;
	const get = session?.get;
	if (!session || typeof get !== "function") return;
	for (const [ownerSessionID] of staleOwners) {
		try {
			const result = await get.call(session, { path: { id: ownerSessionID } });
			const idle = (result as { data?: { time?: { idle?: unknown } } } | undefined)?.data?.time?.idle;
			if (typeof idle !== "number" || idle <= 0) continue;
			// Release every claim of this owner that is provably stale. Each
			// claim is re-read after the lookup round-trip so an owner that
			// re-claimed (and refreshed) a path meanwhile keeps its live claim.
			for (const [claimPath, claim] of [...claims]) {
				if (claim.sessionID !== ownerSessionID || claim.ts >= idle) continue;
				claims.delete(claimPath);
				audit({
					ts: new Date().toISOString(),
					sessionID: claimantSessionID,
					tool: "file-claims",
					decision: "allow",
					phase: "event",
					reason: "stale_claim_takeover",
					evidence: { mutation: false, targetPath: claimPath, claimOwnerSessionID: ownerSessionID },
				});
			}
		} catch {}
	}
}

export function releaseFileClaims(sessionID: string, callID?: string): void {
	for (const [path, claim] of claims) {
		if (claim.sessionID === sessionID && (callID === undefined || claim.callID === callID)) {
			claims.delete(path);
		}
	}
}
