import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import type { ProjectConfig } from "./types.ts";

const projectConfigCache = new Map<string, ProjectConfig>();

export function projectRootKey(root: string): string {
	try {
		return realpathSync(root);
	} catch {
		return resolve(root);
	}
}

export function findGitRoot(startPath?: string): string | undefined {
	if (!startPath || typeof startPath !== "string") return undefined;
	try {
		const resolved = resolve(startPath);
		let dir = resolved;
		try {
			const stat = statSync(resolved);
			dir = stat.isDirectory() ? resolved : dirname(resolved);
		} catch {
			dir = dirname(resolved);
		}
		const res = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
			encoding: "utf8",
			timeout: 5_000,
		});
		if (res.status === 0 && res.stdout.trim()) {
			return projectRootKey(res.stdout.trim());
		}
	} catch {}
	return undefined;
}

export function getGitCommonDir(root: string): string | undefined {
	try {
		const res = spawnSync("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
			encoding: "utf8",
			timeout: 5_000,
		});
		if (res.status === 0 && res.stdout.trim()) {
			return projectRootKey(res.stdout.trim());
		}
	} catch {}
	return undefined;
}

export function isSameGitRepo(pathA?: string, pathB?: string): boolean {
	if (!pathA || !pathB) return false;
	const keyA = projectRootKey(pathA);
	const keyB = projectRootKey(pathB);
	if (keyA === keyB) return true;
	const commonA = getGitCommonDir(keyA);
	const commonB = getGitCommonDir(keyB);
	if (commonA && commonB && commonA === commonB) return true;
	const rootA = findGitRoot(keyA);
	const rootB = findGitRoot(keyB);
	if (rootA && rootB && rootA === rootB) return true;
	return false;
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

/** The project config file actually read for `root`, or undefined when none exists. */
export function existingProjectConfigPath(root: string): string | undefined {
	return projectConfigCandidates(root).find(existsSync);
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
