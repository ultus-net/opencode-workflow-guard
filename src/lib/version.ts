import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The version of the package this module was loaded from, read from the
 * adjacent package.json (the package ships TypeScript source, so the manifest
 * always sits two levels above src/). Fail-soft: an unreadable or malformed
 * manifest (for example a bundled or relocated copy without package.json)
 * yields undefined, and callers surface that absence rather than guessing.
 * This exists because OpenCode resolves configured bare package names through
 * Node's parent-directory lookup from its configuration location, so the
 * loaded copy can silently differ from a globally npm-installed one.
 */
export function loadedPluginVersion(moduleUrl: string = import.meta.url): string | undefined {
	try {
		const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", moduleUrl)), "utf8")) as { version?: unknown };
		return typeof manifest.version === "string" && manifest.version ? manifest.version : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The OpenCode release this build is qualified against, read from the pinned
 * `@opencode/plugin` dependency in the same manifest.
 *
 * Pinning the host API stops an unreviewed major from floating in, but a
 * published guard can still be installed into a host that is newer or older
 * than the one it was verified on. Reporting the qualified pair next to the
 * loaded host version makes that mismatch visible before it becomes a silent
 * no-op, which is the failure mode the migration guide names.
 */
export function qualifiedHostVersion(moduleUrl: string = import.meta.url): string | undefined {
	try {
		const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", moduleUrl)), "utf8")) as {
			dependencies?: Record<string, unknown>;
		};
		const pinned = manifest.dependencies?.["@opencode/plugin"];
		return typeof pinned === "string" && /^\d+\.\d+\.\d+/.test(pinned) ? pinned : undefined;
	} catch {
		return undefined;
	}
}
