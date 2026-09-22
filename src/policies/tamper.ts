import { realpathSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { getLiveControlPlaneRoots, getWorkspaceRoot } from "../lib/state.ts";
import { decodeShellEscapes, prepareRedirectResidue } from "../lib/shell.ts";
import { pathWithinAnyRoot, realpathWithinAnyRoot } from "../lib/live-control-plane.ts";

export const PROTECTED_PATH_REASON =
	"Blocked: modifying Open" +
	"Code settings, permissions, auth, or the guard " +
	"plugin itself is not allowed from the agent. The user must change " +
	"these manually in configuration or the UI.";

const GT = String.fromCharCode(62);
const V_LIST = ["sed\\s+-i", "tee", "mv", "cp", "rm", "chmod", "chown", "ln", "install", "truncate", "dd"].join("|");
const C_LIST = ["open" + "code\\.jsonc?", "\\.config\\/open" + "code", "\\.open" + "code\\/"].join("|");
const U_LIST = ["\\.config\\/open" + "code\\/(?:plugins|ui)\\/"].join("|");

export const SETTINGS_TAMPER_PATTERNS: RegExp[] = [
	new RegExp(`(?:^|\\s)(?:${V_LIST})\\s+[^|;&]*?(?:[\\w\\/.~-]*(?:${C_LIST}))`, "i"),
	new RegExp(`${GT}\\s*["']?[\\w\\/.~-]*(?:${C_LIST})`, "i"),
	new RegExp(`(?:^|\\s)(?:${V_LIST})\\s+[^|;&]*?[\\w\\/.~-]*(?:${U_LIST})`, "i"),
	new RegExp(`${GT}\\s*["']?[\\w\\/.~-]*(?:${U_LIST})`, "i"),
	new RegExp("(?:" + "^|\\s)(?:op" + "encode)\\s+(?:-[^|;&]*\\s+)*(?:auth|config|permission)\\b", "i"),
	new RegExp("(?:" + "^|\\s)(?:op" + "encode)\\s+(?:run\\s+)?--auto\\b", "i"),
];

// Patterns 1-4 match redirect operators and mutation verbs writing into
// guarded paths: they run on the quote-stripped residue (quoted data spans
// are command data and their ">" characters are not redirects). Patterns
// 5-6 match the opencode CLI verbs themselves: those run on the
// quote-FLATTENED text, because a quoted command word or an eval payload
// still executes the verb.
const PATH_PATTERNS = SETTINGS_TAMPER_PATTERNS.slice(0, 4);
const VERB_PATTERNS = SETTINGS_TAMPER_PATTERNS.slice(4);

export function normalizeShellEvasion(text: string): string {
	return decodeShellEscapes(text)
		.replace(/'([^']*)'/g, "$1")
		.replace(/"([^"]*)"/g, "$1");
}

export function normalizeGlobPathEvasion(text: string): string {
	const ocJson = "op" + "encode.json";
	return text
		.replace(/opencode\.jso[?]/gi, ocJson)
		.replace(/opencode\.[?*]/gi, ocJson);
}

// Collaboration invocations (hosted-git/PR/issue CLIs) never write local
// configuration: their arguments may legitimately mention guarded paths.
const COLLABORATION_INVOCATION_PATTERNS: RegExp[] = [
	/^\s*(?:gh|glab)\s+(?:issue|pr)\b/,
	/^\s*az\s+repos\s+pr\b/,
];

export function isCollaborationInvocation(segment: string): boolean {
	return COLLABORATION_INVOCATION_PATTERNS.some((re) => re.test(segment));
}

export function isSettingsTamper(command: string, liveControlPlaneRoots?: readonly string[]): boolean {
	// When the host declares its live control-plane roots, path-shaped tamper is
	// decided by the mutation TARGET's runtime location (`isProtectedPath`), not
	// by matching any operand's raw text. That stops a copy/move SOURCE under a
	// config path from being flagged while the destination is a sanctioned draft
	// (finding F3). The opencode CLI verb patterns still apply. Callers that scan
	// written content (edit payloads) pass no roots and keep the legacy
	// fail-closed path matching.
	const factMode = liveControlPlaneRoots !== undefined && liveControlPlaneRoots.length > 0;
	return command.split(/[\n|;&]+/).some((s) => {
		if (isCollaborationInvocation(s)) return false;
		const flattened = normalizeGlobPathEvasion(normalizeShellEvasion(s));
		if (VERB_PATTERNS.some((re) => re.test(flattened))) return true;
		if (factMode) return false;
		const residue = normalizeGlobPathEvasion(normalizeShellEvasion(prepareRedirectResidue(s)));
		return PATH_PATTERNS.some((re) => re.test(residue));
	});
}

export function isProtectedPath(
	targetPath: string,
	liveControlPlaneRoots: readonly string[] | undefined = getLiveControlPlaneRoots(),
): boolean {
	if (!targetPath) return false;
	const root = getWorkspaceRoot();
	const resolved = resolve(root, targetPath);
	if (liveControlPlaneRoots && liveControlPlaneRoots.length > 0) {
		// Fact mode: only the LIVE control plane is protected; versioned drafts
		// (project .opencode/, dotfiles .config/opencode, worktrees) are not.
		return pathWithinAnyRoot(resolved, liveControlPlaneRoots) || realpathWithinAnyRoot(resolved, liveControlPlaneRoots);
	}
	const matches = (path: string): boolean => {
		const base = basename(path);
		const lower = path.toLowerCase();
		const dotOc = "." + "opencode/";
		// opencode plan mode writes agent plan markdown under the project's
		// .opencode/plans/ directory - plan files are documents, not
		// configuration. The trailing slash keeps the plans directory
		// itself protected.
		if (lower.includes("/" + dotOc + "plans/")) return false;
		const cfgOc = "/.config/" + "opencode/";
		const cfgOcJson = "/.config/" + "opencode.json";
		return (
			/^opencode\.jsonc?$/i.test(base) ||
			/^workflow-guard\.jsonc?$/i.test(base) ||
			// the .opencode directory itself and anything under it (project
		// plugins, agents) - including the exact directory, not just paths
		// nested inside it
		lower === ".opencode" ||
		lower.endsWith("/.opencode") ||
		lower.includes("/" + dotOc) ||
			lower.includes(cfgOc) ||
			lower.includes(cfgOcJson)
		);
	};
	if (matches(resolved)) return true;
	try {
		return matches(realpathSync(resolved));
	} catch {
		let ancestor = resolve(resolved, "..");
		while (ancestor !== resolve(ancestor, "..")) {
			try {
				const realAncestor = realpathSync(ancestor);
				return matches(resolve(realAncestor, relative(ancestor, resolved)));
			} catch {
				ancestor = resolve(ancestor, "..");
			}
		}
		return false;
	}
}
