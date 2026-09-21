import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { getWorkspaceRoot } from "../lib/state.ts";
import { decodeShellEscapes, prepareRedirectResidue } from "../lib/shell.ts";
import { expandShellTargetPath, isCollaborationInvocation, mutationDestinationsIn } from "./shell-mutations.ts";

// Collaboration-segment classification moved to shell-mutations.ts (shared
// with the boundary policy); re-exported here for the historical surface.
export { isCollaborationInvocation } from "./shell-mutations.ts";

export const PROTECTED_PATH_REASON =
	"Blocked: modifying Open" +
	"Code settings, permissions, auth, or the guard " +
	"plugin itself is not allowed from the agent. The user must change " +
	"these manually in configuration or the UI.";

/**
 * Names the sanctioned path forward for a protected-path block: the agent
 * works on versioned drafts inside the repository; the user owns the live
 * config and the guard itself.
 */
export function protectedPathAlternative(): string {
	return (
		"Work on the versioned draft inside the repository and open a PR; " +
		"the user promotes changes to the live OpenCode config and updates the guard themselves."
	);
}

// The opencode CLI verbs themselves: these run on the quote-FLATTENED text,
// because a quoted command word or an eval payload still executes the verb.
// Path-based tamper detection is no longer pattern-based: mutation
// destinations are extracted and matched against live config surfaces
// (consumption anchoring) in isSettingsTamper below.
export const SETTINGS_TAMPER_PATTERNS: RegExp[] = [
	new RegExp("(?:" + "^|\\s)(?:op" + "encode)\\s+(?:-[^|;&]*\\s+)*(?:auth|config|permission)\\b", "i"),
	new RegExp("(?:" + "^|\\s)(?:op" + "encode)\\s+(?:run\\s+)?--auto\\b", "i"),
];

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

// Agent payload under .opencode/: role definitions, prompts, and command
// markdown are harness payload - the safe, versionable, reviewable
// modifiable surface. Plugins, config, memory, and the guard source stay
// protected. (The live user-level config directory has no payload
// exemption: agents never write live paths; the user promotes drafts.)
const OPENCODE_PAYLOAD_DIRS = new Set(["agent", "agents", "command", "commands"]);

function workspaceProtected(root: string, path: string): boolean {
	const rel = relative(root, path);
	if (!rel || rel.startsWith("..")) return false;
	const relLower = rel.toLowerCase();
	if (relLower === ".opencode" || relLower.startsWith(".opencode/")) {
		// opencode plan mode writes agent plan markdown under the project's
		// .opencode/plans/ directory - plan files are documents, not
		// configuration. The plans directory itself stays protected.
		if (relLower.startsWith(".opencode/plans/")) return false;
		const first = relLower.slice(".opencode/".length).split("/")[0]!;
		if (OPENCODE_PAYLOAD_DIRS.has(first)) {
			// The exemption covers markdown payload only: role definitions and
			// command markdown are the versionable, reviewable documents. Any
			// other file type under a payload directory (scripts, binaries,
			// unknown extensions) is control-plane surface and stays protected.
			const rest = relLower.slice(".opencode/".length + first.length + 1);
			if (rest.endsWith(".md") || rest.endsWith(".markdown")) return false;
			return true;
		}
		return true;
	}
	if (/^opencode\.jsonc?$/.test(relLower) || /^workflow-guard\.jsonc?$/.test(relLower)) return true;
	if (relLower === ".config/opencode" || relLower.startsWith(".config/opencode/")) return true;
	if (relLower === ".config/opencode.json" || relLower === ".config/opencode.jsonc") return true;
	if (relLower === "node_modules/opencode-workflow-guard" || relLower.startsWith("node_modules/opencode-workflow-guard/")) return true;
	return false;
}

function liveConfigBase(): string {
	return process.env.XDG_CONFIG_HOME ? resolve(process.env.XDG_CONFIG_HOME) : join(homedir(), ".config");
}

/**
 * Live user-level OpenCode config consumed by the running process: only
 * absolute paths under the global config directory (or its legacy file
 * locations) match. No payload exemption here - agents never write live
 * paths; the user promotes versioned drafts.
 */
function liveUserConfigProtected(path: string): boolean {
	const base = liveConfigBase();
	const cfgDir = join(base, "opencode");
	const cfgDirPrefix = cfgDir.endsWith("/") ? cfgDir : cfgDir + "/";
	if (path === cfgDir || path.startsWith(cfgDirPrefix)) return true;
	return path === join(base, "opencode.json") || path === join(base, "opencode.jsonc");
}

/**
 * Installed copies of the guard plugin itself, wherever package resolution
 * finds them: node_modules trees and versioned install caches under the
 * opencode cache directory. These are consumption anchors (how the runtime
 * loads the guard), not name matches.
 */
function guardInstallProtected(path: string): boolean {
	const lower = path.toLowerCase();
	return (
		lower.includes("/node_modules/opencode-workflow-guard") ||
		(lower.includes("/.cache/opencode/") && lower.includes("opencode-workflow-guard@"))
	);
}

/**
 * Whether `targetPath` (resolved against the workspace root) is a surface
 * the running OpenCode process actually consumes: project-root config
 * files, the project .opencode control directory (minus agent/command
 * payload and plans), the live user-level config directory, and installed
 * guard copies.
 *
 * Matching is anchored on consumption - nested config-shaped trees inside
 * the repo (versioned dotfiles drafts), scratch copies, and docs are NOT
 * protected surfaces. Checks remain symlink-aware: the final existing path
 * and, for new files, the nearest existing ancestor are resolved through
 * realpath before matching.
 */
export function isProtectedPath(targetPath: string): boolean {
	if (!targetPath) return false;
	const root = getWorkspaceRoot();
	const resolved = resolve(root, targetPath);
	if (guardInstallProtected(resolved)) return true;
	if (liveUserConfigProtected(resolved)) return true;
	if (workspaceProtected(root, resolved)) return true;
	try {
		const real = realpathSync(resolved);
		if (guardInstallProtected(real)) return true;
		if (liveUserConfigProtected(real)) return true;
		if (workspaceProtected(root, real)) return true;
	} catch {
		let ancestor = resolve(resolved, "..");
		while (ancestor !== resolve(ancestor, "..")) {
			try {
				const realAncestor = realpathSync(ancestor);
				const joined = resolve(realAncestor, relative(ancestor, resolved));
				if (guardInstallProtected(joined)) return true;
				if (liveUserConfigProtected(joined)) return true;
				if (workspaceProtected(root, joined)) return true;
				break;
			} catch {
				ancestor = resolve(ancestor, "..");
			}
		}
		return false;
	}
	return false;
}

// Interpreter payloads are program text, not shell: write destinations
// cannot be extracted structurally (computed paths like os.homedir() +
// "/.config/opencode/..." produce no shell mutation to anchor on). In
// payload mode the matcher therefore falls back to config-shaped segment
// names in the flattened text - the historical, conservative payload
// behavior. Shell commands keep the anchored destination scan.
const CONFIG_SEGMENT_RE = new RegExp(
	"(?:\\.config\\/open" + "code|(?:^|[\\/\\\\])\\.open" + "code(?:[\\/\\\\]|$)|open" + "code\\.jsonc?|workflow-guard\\.jsonc?|open" + "code-workflow-guard@)",
	"i",
);

export function isSettingsTamper(command: string, payloadMode = false): boolean {
	const root = getWorkspaceRoot();
	return command.split(/[\n|;&]+/).some((s) => {
		if (isCollaborationInvocation(s)) return false;
		const flattened = normalizeGlobPathEvasion(normalizeShellEvasion(s));
		if (SETTINGS_TAMPER_PATTERNS.some((re) => re.test(flattened))) return true;
		if (payloadMode && CONFIG_SEGMENT_RE.test(flattened)) return true;
		// Path tamper detection is anchored to live config surfaces: extract
		// actual write destinations and check where they land, never match
		// path segments anywhere in the text (drafts, scratch, docs are free).
		const residue = normalizeGlobPathEvasion(normalizeShellEvasion(prepareRedirectResidue(s)));
		for (const destination of mutationDestinationsIn(residue)) {
			const expanded = expandShellTargetPath(destination);
			if (expanded === null) {
				// Indeterminate destination: fail closed only for config-shaped
				// segment names (exactly where the old matcher fired), so
				// ordinary `$OUT/build.log` outputs are not tamper hits.
				if (CONFIG_SEGMENT_RE.test(destination)) {
					return true;
				}
				continue;
			}
			if (isProtectedPath(resolve(root, expanded))) return true;
		}
		return false;
	});
}
