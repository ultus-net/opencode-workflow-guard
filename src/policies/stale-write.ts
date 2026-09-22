import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { canonicalPath } from "./file-claims.ts";

interface ReadFingerprint {
	dev: bigint;
	ino: bigint;
	size: bigint;
	mtimeNs: bigint;
	digest: string;
}

export interface ReadObservation {
	path: string;
	fingerprint: ReadFingerprint;
}

const reads = new Map<string, Map<string, ReadFingerprint>>();

function fingerprint(path: string): ReadFingerprint | undefined {
	try {
		const stat = statSync(path, { bigint: true });
		if (!stat.isFile()) return undefined;
		return {
			dev: stat.dev,
			ino: stat.ino,
			size: stat.size,
			mtimeNs: stat.mtimeNs,
			digest: createHash("sha256").update(readFileSync(path)).digest("hex"),
		};
	} catch {
		return undefined;
	}
}

function equal(a: ReadFingerprint, b: ReadFingerprint): boolean {
	return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.digest === b.digest;
}

export function beginReadObservation(path: string): ReadObservation | undefined {
	const observed = fingerprint(path);
	if (!observed) return undefined;
	return { path: canonicalPath(path), fingerprint: observed };
}

export function recordSuccessfulRead(observation: ReadObservation, sessionID: string): void {
	const current = fingerprint(observation.path);
	if (!current || !equal(observation.fingerprint, current)) return;
	const sessionReads = reads.get(sessionID) ?? new Map<string, ReadFingerprint>();
	sessionReads.set(observation.path, observation.fingerprint);
	reads.set(sessionID, sessionReads);
}

/**
 * Records the session's observation of a file it just mutated. A successful
 * edit/write means the session authored the resulting bytes, so a follow-up
 * edit to that file must not demand a redundant re-read. The pre-mutation
 * digest is compared so a no-op or failed call (content unchanged) does not
 * seed an observation, and an external change after the mutation still fails
 * the next comparison.
 */
export function recordMutationObservation(path: string, sessionID: string, beforeDigest?: string): void {
	const current = fingerprint(path);
	if (!current) return;
	if (beforeDigest !== undefined && current.digest === beforeDigest) return;
	const sessionReads = reads.get(sessionID) ?? new Map<string, ReadFingerprint>();
	sessionReads.set(canonicalPath(path), current);
	reads.set(sessionID, sessionReads);
}

export function staleWriteReason(path: string, sessionID: string): string | undefined {
	const current = fingerprint(path);
	const canonical = canonicalPath(path);
	const observed = reads.get(sessionID)?.get(canonical);
	if (!observed) {
		if (!current) return undefined;
		return `Blocked: existing file '${canonical}' has not been read by this session. Re-read it before editing or overwriting it.`;
	}
	if (!current || !equal(observed, current)) {
		return `Blocked: file '${canonical}' changed since this session read it. Re-read it before editing or overwriting it.`;
	}
	return undefined;
}

export function clearReadFingerprints(sessionID: string): void {
	reads.delete(sessionID);
}
