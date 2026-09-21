import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { ShellMutation } from "../lib/types.ts";
import {
	getWorkspaceRoot,
	getWorkspaceRootReal,
	recordMutation,
} from "../lib/state.ts";
import { shellWords, unwrapShellCommand } from "../lib/shell.ts";
import { isCollaborationInvocation, isProtectedPath, PROTECTED_PATH_REASON, protectedPathAlternative } from "./tamper.ts";
import { isSecretPath, secretIn } from "./secrets.ts";
import { onProtectedBranch, branchGuardReason } from "./git.ts";
import {
	expandShellTargetPath,
	filesystemTransferInfo,
	redirectMutationsIn,
	shellMutationIn,
	simpleFilesystemMutations,
	stripQuotedSpans,
	teeTargetsIn,
} from "./shell-mutations.ts";
import {
	effectiveTodos,
	effectiveTodoOwnerSessionID,
	hasActiveTodo,
} from "./todo.ts";

// Pure shell mutation extraction lives in shell-mutations.ts so the tamper
// policy can anchor on the same write destinations without an import cycle.
// The symbols are re-exported here to keep the historical import surface.
export {
	detectShellMutation,
	expandShellTargetPath,
	filesystemTransferInfo,
	shellMutationIn,
	simpleFilesystemMutations,
	teeTargetsIn,
} from "./shell-mutations.ts";

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
		/^\*\*\*\s+(?:Add File|Update File|Delete File|Move to|Move from):\s*(.+?)\s*$/gm;
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

export function secretSourceInFilesystemCommand(segment: string): string | undefined {
	const transfer = filesystemTransferInfo(segment);
	if (!transfer) return undefined;
	for (const source of transfer.sources) {
		if (isSecretPath(source)) return source;
	}
	return undefined;
}

export async function guardShellMutation(
	command: string,
	sessionID: string | undefined,
	record = true,
): Promise<string | undefined> {
	const root = getWorkspaceRoot();
	let hasMutation = false;
	for (const rawSegment of command.split(/[\n|;&]+/)) {
		// Same residue analysis as detectShellMutation: quoted arguments of
		// gh/glab/az PR/issue commands are command data, not shell redirects,
		// while unquoted redirects still get full validation below.
		const segment = isCollaborationInvocation(rawSegment) ? stripQuotedSpans(rawSegment) : rawSegment;
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
				return `${PROTECTED_PATH_REASON} ${protectedPathAlternative()}`;
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
	if (hasMutation && record) {
		recordMutation(await effectiveTodoOwnerSessionID(sessionID), sessionID);
	}
	return undefined;
}
