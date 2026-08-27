import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ProjectConfig } from "./types.ts";

const projectConfigCache = new Map<string, ProjectConfig>();

export function projectRootKey(root: string): string {
	try {
		return realpathSync(root);
	} catch {
		return resolve(root);
	}
}

export function projectConfigCandidates(root: string): string[] {
	return [
		join(root, ".opencode", "workflow-guard.json"),
		join(root, ".opencode", "workflow-guard.jsonc"),
		join(root, "workflow-guard.json"),
		join(root, "workflow-guard.jsonc"),
	];
}

export function projectConfigPath(root: string): string {
	const candidates = projectConfigCandidates(root);
	return candidates.find(existsSync) ?? candidates[0]!;
}

/** Strip JSONC comments and trailing commas without altering string literals. */
export function stripJsonComments(jsonc: string): string {
	let insideString = false;
	let stringQuote = "";
	let escaped = false;
	let output = "";
	let i = 0;
	while (i < jsonc.length) {
		const char = jsonc[i]!;
		const next = jsonc[i + 1];
		if (escaped) { output += char; escaped = false; i++; continue; }
		if (char === "\\") { output += char; escaped = true; i++; continue; }
		if (char === '"' || char === "'") {
			if (!insideString) { insideString = true; stringQuote = char; }
			else if (stringQuote === char) insideString = false;
			output += char; i++; continue;
		}
		if (!insideString && char === "/" && next === "/") {
			i += 2;
			while (i < jsonc.length && jsonc[i] !== "\n" && jsonc[i] !== "\r") i++;
			continue;
		}
		if (!insideString && char === "/" && next === "*") {
			i += 2;
			while (i < jsonc.length && !(jsonc[i] === "*" && jsonc[i + 1] === "/")) i++;
			i += 2; continue;
		}
		output += char; i++;
	}
	return output.replace(/,(\s*[}\]])/g, "$1");
}

export function loadProjectConfig(root: string): ProjectConfig {
	for (const candidate of projectConfigCandidates(root)) {
		try {
			return JSON.parse(stripJsonComments(readFileSync(candidate, "utf8")));
		} catch {}
	}
	return {};
}

export function reloadProjectConfig(root: string): void {
	projectConfigCache.set(projectRootKey(root), loadProjectConfig(root));
}

export function getCachedProjectConfig(root: string): ProjectConfig | undefined {
	return projectConfigCache.get(projectRootKey(root));
}
