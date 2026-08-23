import { realpathSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { getWorkspaceRoot } from "../lib/state.ts";

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
	new RegExp("(?:" + "^|\\s)(?:op" + "encode)\\s+(?:auth|config|permission)\\b", "i"),
	new RegExp("(?:" + "^|\\s)(?:op" + "encode)\\s+(?:run\\s+)?--auto\\b", "i"),
];

export function normalizeShellEvasion(text: string): string {
	return text
		.replace(/'([^']*)'/g, "$1")
		.replace(/"([^"]*)"/g, "$1")
		.replace(/\\(.)/g, "$1");
}

export function normalizeGlobPathEvasion(text: string): string {
	const ocJson = "op" + "encode.json";
	return text
		.replace(/opencode\.jso[?]/gi, ocJson)
		.replace(/opencode\.[?*]/gi, ocJson);
}

export function isSettingsTamper(command: string): boolean {
	const segments = command.split(/[\n|;&]+/).map((s) =>
		normalizeGlobPathEvasion(normalizeShellEvasion(s)),
	);
	return segments.some((segment) =>
		SETTINGS_TAMPER_PATTERNS.some((re) => re.test(segment)),
	);
}

export function isProtectedPath(targetPath: string): boolean {
	if (!targetPath) return false;
	const root = getWorkspaceRoot();
	const resolved = resolve(root, targetPath);
	const matches = (path: string): boolean => {
		const base = basename(path);
		const lower = path.toLowerCase();
		const dotOc = "." + "opencode/";
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
