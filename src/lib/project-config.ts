import { existsSync } from "node:fs";
import { join } from "node:path";

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
