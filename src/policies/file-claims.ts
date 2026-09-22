import { readlinkSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { audit } from "../lib/audit.ts";
import { getSdkClient } from "../lib/state.ts";

interface FileClaim {
	sessionID: string;
	callID: string;
	/** Creation timestamp; a claim older than its owner's last idle is stale. */
	ts: number;
}

const claims = new Map<string, FileClaim>();

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

export function fileClaimConflictReason(paths: string[], sessionID: string): string | undefined {
	const canonical = [...new Set(paths.map((path) => canonicalPath(path)))];
	for (const path of canonical) {
		const existing = claims.get(path);
		if (existing && existing.sessionID !== sessionID) {
			return `Blocked: file '${path}' is claimed by another active session ('${existing.sessionID}'). Wait for that edit to finish or use an isolated worktree.`;
		}
	}
	return undefined;
}

/**
 * A claim is normally released by its owning tool call (after-hook) or by the
 * owner's session.idle/session.deleted events. When an idle release is missed,
 * the claim would otherwise block every other session forever. A claim created
 * BEFORE its owner's last recorded idle timestamp cannot belong to an
 * in-flight tool call — that call finished before the turn ended — so it is
 * provably stale and is released with an audited takeover. Without an SDK
 * client, or when the owner record cannot be read, nothing is released:
 * fail-closed keeps live two-session protection intact. Clock skew between
 * this process and the server is not expected (local service); negative skew
 * fails closed. Concurrent claimants can emit duplicate takeover audits
 * (append-only, harmless). Release is per-claim: only the path whose claim is
 * provably stale is dropped, re-read AFTER the lookup round-trip so an owner
 * that re-claimed (and refreshed) the path meanwhile keeps its live claim.
 */
export async function releaseStaleFileClaims(paths: string[], claimantSessionID: string): Promise<void> {
	const canonical = [...new Set(paths.map((path) => canonicalPath(path)))];
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
