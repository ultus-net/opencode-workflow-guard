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
