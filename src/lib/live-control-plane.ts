import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * Expands a leading `~`/`~user`/`$HOME`/`${HOME}` in a declared path and
 * rejects any remaining unresolved `$VARIABLE` (returns undefined so callers
 * fail closed rather than treating an unresolvable root as absent).
 */
export function expandLivePath(value: string): string | undefined {
	const trimmed = value.trim().replace(/^["']|["']$/g, "");
	if (!trimmed) return undefined;
	const home = process.env.HOME || homedir();
	let out = trimmed;
	if (out === "~") {
		out = home;
	} else if (out.startsWith("~/") || out.startsWith("~\\")) {
		out = join(home, out.slice(2));
	} else if (/^~[A-Za-z0-9_.-]+(?:\/|\\|$)/.test(out)) {
		const parts = out.slice(1).split(/[/\\]/);
		out = join(dirname(home), parts[0]!, ...parts.slice(1));
	} else if (/^\$(?:HOME|\{HOME\})(?=$|[/\\])/.test(out)) {
		out = out.replace(/^\$(?:HOME|\{HOME\})/, home);
	}
	if (out.includes("$")) return undefined;
	return out;
}

/**
 * Normalizes the host-declared live control-plane roots. A root is usable only
 * when it expands (no unresolved `$VAR`) and is absolute; on ANY unusable root
 * the whole set is rejected (undefined) so classification falls back to the
 * fail-closed legacy segment matching rather than trusting partial facts.
 */
export function normalizeLiveControlPlaneRoots(
	values: readonly string[] | undefined,
): readonly string[] | undefined {
	if (!values || values.length === 0) return undefined;
	const roots: string[] = [];
	for (const value of values) {
		const expanded = expandLivePath(value);
		if (expanded === undefined || !isAbsolute(expanded)) return undefined;
		roots.push(resolve(expanded));
	}
	return roots;
}

function realpathWithMissingTail(path: string): string | undefined {
	let ancestor = path;
	while (true) {
		try {
			return resolve(realpathSync(ancestor), relative(ancestor, path));
		} catch {
			const parent = dirname(ancestor);
			if (parent === ancestor) return undefined;
			ancestor = parent;
		}
	}
}

/** True when `candidate` is, or is nested under, any root (root realpath-aware). */
export function pathWithinAnyRoot(candidate: string, roots: readonly string[]): boolean {
	return roots.some((root) => {
		const realRoot = realpathWithMissingTail(resolve(root)) ?? resolve(root);
		const rel = relative(realRoot, candidate);
		return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
	});
}

/** Symlink-aware variant: resolves `candidate`'s existing ancestor before matching. */
export function realpathWithinAnyRoot(candidate: string, roots: readonly string[]): boolean {
	const real = realpathWithMissingTail(candidate);
	return real !== undefined && real !== candidate && pathWithinAnyRoot(real, roots);
}
