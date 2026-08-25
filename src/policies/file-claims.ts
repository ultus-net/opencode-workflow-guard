import { readlinkSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

interface FileClaim {
	sessionID: string;
	callID: string;
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
	for (const path of canonical) {
		const existing = claims.get(path);
		if (existing && existing.sessionID !== sessionID) {
			return `Blocked: file '${path}' is claimed by another active session ('${existing.sessionID}'). Wait for that edit to finish or use an isolated worktree.`;
		}
	}
	for (const path of canonical) {
		if (!claims.has(path)) {
			claims.set(path, { sessionID, callID });
		}
	}
	return undefined;
}

export function releaseFileClaims(sessionID: string, callID?: string): void {
	for (const [path, claim] of claims) {
		if (claim.sessionID === sessionID && (callID === undefined || claim.callID === callID)) {
			claims.delete(path);
		}
	}
}
