import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { getProjectConfig } from "../lib/state.ts";
import { runVerify, snipVerifyOutput } from "../lib/verify.ts";
import { extractPatchPaths } from "./boundary.ts";

export interface FileSnapshot {
	path: string;
	digest?: string;
}

function globRegex(pattern: string): RegExp {
	let source = "^";
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		if (char === "*") {
			if (pattern[i + 1] === "*") {
				i++;
				if (pattern[i + 1] === "/") {
					i++;
					source += "(?:.*/)?";
				} else {
					source += ".*";
				}
			} else {
				source += "[^/]*";
			}
		} else if (char === "?") {
			source += "[^/]";
		} else {
			source += char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
		}
	}
	return new RegExp(`${source}$`);
}

export function snapshotFile(path: string): FileSnapshot {
	try {
		return { path, digest: createHash("sha256").update(readFileSync(path)).digest("hex") };
	} catch {
		return { path };
	}
}

export function editTargets(args: unknown, root: string): string[] {
	if (!args || typeof args !== "object") return [];
	const record = args as Record<string, unknown>;
	const raw = typeof record.filePath === "string" ? record.filePath : typeof record.path === "string" ? record.path : undefined;
	if (raw) return [isAbsolute(raw) ? raw : resolve(root, raw)];
	if (typeof record.patchText !== "string") return [];
	return extractPatchPaths(record.patchText).map((path) => isAbsolute(path) ? path : resolve(root, path));
}

export async function runPostEditValidators(root: string, before: FileSnapshot): Promise<string | undefined> {
	const after = snapshotFile(before.path);
	if (after.digest === before.digest) return undefined;
	const relativePath = relative(root, before.path).replaceAll("\\", "/");
	const validators = getProjectConfig(root).postEditValidators;
	if (!Array.isArray(validators)) return undefined;

	const failures: string[] = [];
	for (const [index, validator] of validators.entries()) {
		if (!validator || typeof validator.pattern !== "string" || !validator.pattern || /[{}\[\]]/.test(validator.pattern) || typeof validator.command !== "string" || !validator.command.trim() || (validator.timeoutMs !== undefined && (!Number.isFinite(validator.timeoutMs) || validator.timeoutMs <= 0))) {
			failures.push(`[workflow-guard] Invalid postEditValidators configuration at index ${index}: pattern must be a non-empty *, **, ? glob without brace/class syntax; command must be non-empty; timeoutMs must be a positive finite number when provided.`);
			continue;
		}
		if (!globRegex(validator.pattern).test(relativePath)) continue;
		const timeoutMs = validator.timeoutMs ?? 30_000;
		const result = await runVerify(validator.command, root, timeoutMs);
		if (!result.passed) {
			failures.push(`[workflow-guard] Post-edit validator failed for ${relativePath}: ${validator.command}\n${snipVerifyOutput(result.output, false)}`);
		}
	}
	return failures.length ? failures.join("\n\n") : undefined;
}
