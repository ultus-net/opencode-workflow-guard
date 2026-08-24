import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ShellMutation } from "../lib/types.ts";
import {
	getWorkspaceRoot,
	getWorkspaceRootReal,
	recordMutation,
} from "../lib/state.ts";
import { shellWords, unwrapShellCommand } from "../lib/utils.ts";
import { isProtectedPath, PROTECTED_PATH_REASON } from "./tamper.ts";
import { isSecretPath, secretIn } from "./secrets.ts";
import { onProtectedBranch, branchGuardReason } from "./git.ts";
import {
	effectiveTodos,
	effectiveTodoOwnerSessionID,
	hasActiveTodo,
} from "./todo.ts";

/**
 * Expands leading `~`, `~user`, `$HOME`, and `${HOME}` in candidate targets so
 * shell-level expansion cannot evade workspace boundary checks. Paths that
 * contain unresolvable `$VARIABLE` references return `null` so callers treat
 * indeterminate destinations as outside-workspace (fail-closed).
 */
export function expandShellTargetPath(targetPath: string): string | null {
	if (!targetPath) return targetPath;
	const trimmed = targetPath.trim().replace(/^["']|["']$/g, "");
	if (!trimmed) return trimmed;

	const home = process.env.HOME || homedir();

	if (trimmed === "~") return home;
	if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
		return join(home, trimmed.slice(2));
	}
	if (/^~[A-Za-z0-9_.-]+(?:\/|\\|$)/.test(trimmed)) {
		const parts = trimmed.slice(1).split(/[/\\]/);
		const user = parts[0]!;
		const rest = parts.slice(1);
		return join(dirname(home), user, ...rest);
	}

	let out = trimmed;
	if (/^\$(?:HOME|\{HOME\})(?=$|[/\\])/.test(out)) {
		out = out.replace(/^\$(?:HOME|\{HOME\})/, home);
	}

	if (out.includes("$")) {
		return null;
	}

	return out;
}

export function isPathOutsideWorkspace(targetPath: string, root: string): boolean {
	if (!targetPath) return false;
	const expanded = expandShellTargetPath(targetPath);
	if (expanded === null) return true;
	const resolved = resolve(root, expanded);
	const normalizedRoot = root.endsWith("/") ? root : root + "/";
	if (resolved !== root && !resolved.startsWith(normalizedRoot)) {
		return true;
	}
	const realRootVal = getWorkspaceRootReal();
	try {
		const real = realpathSync(resolved);
		const realRoot = realRootVal.endsWith("/") ? realRootVal : realRootVal + "/";
		if (real !== realRootVal && !real.startsWith(realRoot)) {
			return true;
		}
	} catch {
		let curr = resolved;
		while (curr && curr !== "/" && curr !== ".") {
			const parent = resolve(curr, "..");
			if (parent === curr) break;
			curr = parent;
			try {
				const realParent = realpathSync(curr);
				const realRoot = realRootVal.endsWith("/") ? realRootVal : realRootVal + "/";
				if (realParent !== realRootVal && !realParent.startsWith(realRoot)) {
					return true;
				}
				break;
			} catch {}
		}
	}
	return false;
}

export function extractPatchPaths(patchText: string): string[] {
	const paths: string[] = [];
	const markerRe =
		/^\*\*\*\s+(?:Add File|Update File|Delete File|Move to|Move from):\s*(\S+)/gm;
	let match: RegExpExecArray | null;
	while ((match = markerRe.exec(patchText)) !== null) {
		if (match[1]) paths.push(match[1]);
	}
	const diffRe = /^(?:---|\+\+\+)\s+(?:[ab]\/)?(\S+)/gm;
	while ((match = diffRe.exec(patchText)) !== null) {
		if (match[1] && match[1] !== "/dev/null") paths.push(match[1]);
	}
	return paths;
}

export function teeTargetsIn(segment: string): string[] {
	const words = shellWords(unwrapShellCommand(segment));
	if (words[0] !== "tee") {
		const teeIdx = words.indexOf("tee");
		if (teeIdx === -1) return [];
	}
	const startIdx = words[0] === "tee" ? 1 : words.indexOf("tee") + 1;
	const targets: string[] = [];
	let stopFlags = false;
	for (let i = startIdx; i < words.length; i++) {
		const w = words[i]!;
		if (/^[|;&<>]/.test(w)) break;
		if (!stopFlags) {
			if (w === "--") {
				stopFlags = true;
				continue;
			}
			if (w.startsWith("-")) continue;
		}
		targets.push(w);
	}
	return targets;
}

function redirectMutationsIn(segment: string): ShellMutation[] {
	const mutations: ShellMutation[] = [];
	const redirectRe = /(?:^|[\s>]|(?<=[^\s"']))([0-9]*&?>>?&?)\s*["']?([^\s>&|;"']+)/g;
	for (const redirectMatch of segment.matchAll(redirectRe)) {
		if (!redirectMatch[1] || !redirectMatch[2]) continue;
		const op = redirectMatch[1];
		const target = redirectMatch[2];
		// Filter fd duplication (e.g. 2>&1, >&2) where target is purely an fd number
		const isFdDup = op.endsWith("&") && /^\d+$/.test(target);
		if (!isFdDup && !/^\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)$/.test(target)) {
			mutations.push({
				kind: "redirect",
				target,
				what: `file redirect to '${target}'`,
			});
		}
	}
	return mutations;
}

export function shellMutationIn(segment: string): ShellMutation | undefined {
	const redirectMutation = redirectMutationsIn(segment)[0];
	if (redirectMutation) return redirectMutation;
	const teeTargets = teeTargetsIn(segment);
	if (teeTargets.length > 0) {
		return {
			kind: "command",
			target: teeTargets[0]!,
			what: `tee to '${teeTargets[0]!}'`,
		};
	}
	const sedWords = shellWords(unwrapShellCommand(segment));
	if (sedWords[0] === "sed" && sedWords.slice(1).some((word) => /^-(?:[a-zA-Z]*i|i\S*)$/.test(word) || /^--in-place(?:=.*)?$/.test(word))) {
		const operands = sedWords.slice(1).filter((word) => !word.startsWith("-"));
		const target = operands.at(-1);
		if (!target) return undefined;
		return { kind: "command", target, what: `sed -i on '${target}'` };
	}
	const transfer = filesystemTransferInfo(segment);
	if (transfer?.destination) {
		return {
			kind: "command",
			target: transfer.destination,
			what: `copy/move/link to '${transfer.destination}'`,
		};
	}
	const fsMutationMatch = segment.match(
		/\b(?:touch|mkdir|rm|unlink|rmdir|ln)\b[^|;&]*\s+["']?([^\s;&|"']+)["']?\s*$/,
	);
	if (fsMutationMatch?.[1] && !fsMutationMatch[1].startsWith("-")) {
		return {
			kind: "command",
			target: fsMutationMatch[1],
			what: `filesystem mutation of '${fsMutationMatch[1]}'`,
		};
	}
	const copyMatch = segment.match(
		/\b(?:cp|mv|rsync|install|cpio|scp|wget|curl)\b[^|;&]*?(-o\s+)?(["']?)([^\s;&|"']+)\2?\s*$/,
	);
	if (copyMatch?.[3] && /\b(?:cp|mv|rsync|install)\b/.test(segment)) {
		return {
			kind: "command",
			target: copyMatch[3],
			what: `copy/move to '${copyMatch[3]}'`,
		};
	}
	if (/\bgit\s+(?:apply|am)\b/.test(segment)) {
		return { kind: "command", what: "git apply/am (patch via shell)" };
	}
	return undefined;
}

const SIMPLE_MUTATION_COMMANDS = new Set(["touch", "mkdir", "rm", "unlink", "rmdir", "truncate"]);
const TRANSFER_COMMANDS = new Set(["cp", "mv", "ln"]);

export function simpleFilesystemMutations(segment: string): ShellMutation[] {
	const words = shellWords(unwrapShellCommand(segment));
	const command = words[0];
	if (!command) {
		return [];
	}
	if (command === "dd") {
		return words
			.slice(1)
			.filter((word) => word.startsWith("of=") && word.length > 3)
			.map((word) => {
				const target = word.slice(3);
				return {
					kind: "command" as const,
					target,
					what: `dd output to '${target}'`,
				};
			});
	}
	if (command === "sed") {
		let inPlace = false;
		let scriptSupplied = false;
		const targets: string[] = [];
		for (let i = 1; i < words.length; i++) {
			const word = words[i]!;
			if (/^-(?:[a-zA-Z]*i|i\S*)$/.test(word) || /^--in-place(?:=.*)?$/.test(word)) {
				inPlace = true;
				continue;
			}
			if (word === "-e" || word === "--expression" || word === "-f" || word === "--file") {
				scriptSupplied = true;
				i++;
				continue;
			}
			if (/^(?:-e|--expression=|-f|--file=)/.test(word) || word.startsWith("-")) {
				if (/^(?:-e|--expression=)/.test(word)) scriptSupplied = true;
				continue;
			}
			if (!scriptSupplied) {
				scriptSupplied = true;
				continue;
			}
			targets.push(word);
		}
		if (!inPlace) return [];
		return targets.map((target) => ({ kind: "command" as const, target, what: `sed -i on '${target}'` }));
	}
	if (!SIMPLE_MUTATION_COMMANDS.has(command)) return [];
	return words
		.slice(1)
		.filter((word) => !word.startsWith("-"))
		.map((target) => ({
			kind: "command" as const,
			target,
			what: `filesystem mutation of '${target}'`,
		}));
}

export function filesystemTransferInfo(
	segment: string,
): { sources: string[]; destination?: string } | undefined {
	const words = shellWords(unwrapShellCommand(segment));
	if (!words[0] || !TRANSFER_COMMANDS.has(words[0])) return undefined;
	const operands: string[] = [];
	let targetDirectory: string | undefined;
	for (let i = 1; i < words.length; i++) {
		const word = words[i]!;
		if (word === "-t" || word === "--target-directory") {
			targetDirectory = words[++i];
			continue;
		}
		if (word.startsWith("--target-directory=")) {
			targetDirectory = word.slice("--target-directory=".length);
			continue;
		}
		if (word.startsWith("-")) continue;
		operands.push(word);
	}
	if (targetDirectory) return { sources: operands, destination: targetDirectory };
	return {
		sources: operands.slice(0, -1),
		destination: operands.at(-1),
	};
}

export function secretSourceInFilesystemCommand(segment: string): string | undefined {
	const transfer = filesystemTransferInfo(segment);
	if (!transfer) return undefined;
	for (const source of transfer.sources) {
		if (isSecretPath(source)) return source;
	}
	return undefined;
}

export function detectShellMutation(command: string): ShellMutation | undefined {
	for (const segment of command.split(/[\n|;&]+/)) {
		const simpleMutations = simpleFilesystemMutations(segment);
		if (simpleMutations.length > 0) return simpleMutations[0];
		const teeTargets = teeTargetsIn(segment);
		if (teeTargets.length > 0) {
			return {
				kind: "command",
				target: teeTargets[0],
				what: `tee to '${teeTargets[0]}'`,
			};
		}
		const fallback = shellMutationIn(segment.trim());
		if (fallback) return fallback;
	}
	return undefined;
}

export async function guardShellMutation(
	command: string,
	sessionID: string | undefined,
): Promise<string | undefined> {
	const root = getWorkspaceRoot();
	let hasMutation = false;
	for (const segment of command.split(/[\n|;&]+/)) {
		const secretSource = secretSourceInFilesystemCommand(segment);
		if (secretSource) {
			return `Blocked: shell command would copy, move, or link sensitive file '${secretSource}' under a non-secret name.`;
		}
		// mv mutates its SOURCES too (they are removed from their origin), so
		// sources must respect the same boundaries as mutation targets: no
		// moving files in from outside the workspace, no moving protected
		// (settings/plugin) files to innocuous names.
		const transfer = filesystemTransferInfo(segment);
		if (transfer && shellWords(unwrapShellCommand(segment))[0] === "mv") {
			for (const source of transfer.sources) {
				if (isProtectedPath(source)) {
					return PROTECTED_PATH_REASON;
				}
				if (isPathOutsideWorkspace(source, root)) {
					return `Blocked: mv would remove source '${source}' from outside the workspace root (${root}). File mutations must stay within the workspace.`;
				}
			}
		}
		const simpleMutations = simpleFilesystemMutations(segment);
		const teeTargets = teeTargetsIn(segment);
		const teeMutations: ShellMutation[] = teeTargets.map((target) => ({
			kind: "command" as const,
			target,
			what: `tee to '${target}'`,
		}));
		const redirectMutations = redirectMutationsIn(segment.trim());
		const mutations = [...simpleMutations, ...teeMutations, ...redirectMutations];
		if (mutations.length === 0) {
			const fallbackMutation = shellMutationIn(segment.trim());
			if (fallbackMutation) mutations.push(fallbackMutation);
		}
		for (const mutation of mutations) {
			hasMutation = true;
			const secret = secretIn(segment);
			if (secret) {
				return `Blocked: shell file mutation payload appears to contain a ${secret}. Secrets must not be written to disk from agent commands.`;
			}
			const target = mutation.target ?? "";
			if (target && isProtectedPath(target)) {
				return PROTECTED_PATH_REASON;
			}
			if (target && isPathOutsideWorkspace(target, root)) {
				// The workspace boundary has no override: a write outside the
				// workspace is out of bounds even with WORKFLOW_GUARD_ALLOW_LIVE
				// (that override covers live-system commands, not the boundary).
				return `Blocked: shell mutation '${mutation.what}' targets a path outside the workspace root (${root}). All changes must stay within the workspace.`;
			}
			if (onProtectedBranch(root)) {
				return branchGuardReason();
			}
			const todos = await effectiveTodos(sessionID);
			if (todos !== undefined && !hasActiveTodo(todos)) {
				return (
					"Blocked: shell file mutation with no active todo item. " +
					"Break the request down with todowrite first, then apply " +
					"changes (the same gates apply to shell redirects, tee, " +
					"sed -i, cp/mv and git apply as to the edit tools)."
				);
			}
		}
	}
	if (hasMutation) {
		recordMutation(await effectiveTodoOwnerSessionID(sessionID));
	}
	return undefined;
}
