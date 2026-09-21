import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ShellMutation } from "../lib/types.ts";
import { prepareRedirectResidue, shellWords, unwrapShellCommand } from "../lib/shell.ts";

/**
 * Pure shell-parsing helpers that classify collaboration invocations and
 * enumerate filesystem mutation destinations. Shared by the boundary policy
 * (workspace escape / protected targets) and the tamper policy (anchored
 * live-config destination scanning) so both policies parse shell segments
 * identically. Nothing here reads runtime state.
 */

// Collaboration invocations (hosted-git/PR/issue CLIs) never write local
// configuration: their arguments may legitimately mention guarded paths.
const COLLABORATION_INVOCATION_PATTERNS: RegExp[] = [
	/^\s*(?:gh|glab)\s+(?:issue|pr)\b/,
	/^\s*az\s+repos\s+pr\b/,
];

export function isCollaborationInvocation(segment: string): boolean {
	return COLLABORATION_INVOCATION_PATTERNS.some((re) => re.test(segment));
}

// Remove single- and double-quoted spans from a shell segment. Used to
// analyze the residue of collaboration invocations: quoted arguments are
// command data and can never be shell redirects, while unquoted redirects
// keep receiving full validation. NOTE: unlike shell.ts's
// prepareRedirectResidue, this strips EVERY span including redirect
// targets and glued concatenations - only use it for collaboration
// segments where all quoted content is command data.
export function stripQuotedSpans(segment: string): string {
	return segment.replace(/'[^'\n]*'/g, " ").replace(/"[^"\n]*"/g, " ");
}

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

const SIMPLE_MUTATION_COMMANDS = new Set(["touch", "mkdir", "rm", "unlink", "rmdir", "truncate", "chmod", "chown", "chgrp"]);
const TRANSFER_COMMANDS = new Set(["cp", "mv", "ln", "rsync", "install", "cpio", "scp"]);

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

export function redirectMutationsIn(segment: string): ShellMutation[] {
	const mutations: ShellMutation[] = [];
	// Redirect detection runs on the quote-stripped residue: quoted data
	// spans are command data and their ">" characters are not redirects,
	// while redirect targets keep their value whether quoted or not.
	// The `(?!=)` lookahead after the op rejects comparison operators (`>=`,
	// `==`) so they cannot match as a redirect op with `=` as its target.
	const residue = prepareRedirectResidue(segment);
	const redirectRe = /(?:^|[\s>]|(?<=[^\s"']))([0-9]*&?>>?&?(?!=))\s*["']?([^\s>&|;"']+)/g;
	for (const redirectMatch of residue.matchAll(redirectRe)) {
		if (!redirectMatch[1] || !redirectMatch[2]) continue;
		const op = redirectMatch[1];
		const target = redirectMatch[2];
		// Filter fd duplication (e.g. 2>&1, >&2) where target is purely an fd number
		const isFdDup = op.endsWith("&") && /^\d+$/.test(target);
		// Filter comparison operands from embedded non-shell syntax (SQL, awk,
		// test expressions): `WHERE count > 5`, `x >= 10`. A bare `>` whose
		// target is purely numeric is overwhelmingly a comparison operand, not
		// a redirect into a numeric filename. `>>` and fd forms (`2>`) keep
		// redirect semantics.
		const isComparisonOperand = op === ">" && /^\d+$/.test(target);
		if (!isFdDup && !isComparisonOperand && !/^\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)$/.test(target)) {
			mutations.push({
				kind: "redirect",
				target,
				what: `file redirect to '${target}'`,
			});
		}
	}
	return mutations;
}

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
	const simple = simpleFilesystemMutations(segment);
	if (simple.length > 0) return simple[0];

	const transfer = filesystemTransferInfo(segment);
	if (transfer?.destination) {
		return {
			kind: "command",
			target: transfer.destination,
			what: `copy/move/link to '${transfer.destination}'`,
		};
	}
	const words = shellWords(unwrapShellCommand(segment));
	const command = words[0];
	if (!command) return undefined;

	if (command === "curl") {
		for (let i = 1; i < words.length; i++) {
			const w = words[i]!;
			if ((w === "-o" || w === "--output") && i + 1 < words.length) {
				return { kind: "command", target: words[i + 1]!, what: `curl output to '${words[i + 1]!}'` };
			}
			if (w.startsWith("--output=")) {
				const target = w.slice("--output=".length);
				return { kind: "command", target, what: `curl output to '${target}'` };
			}
		}
	}
	if (command === "wget") {
		for (let i = 1; i < words.length; i++) {
			const w = words[i]!;
			if ((w === "-O" || w === "--output-document") && i + 1 < words.length) {
				return { kind: "command", target: words[i + 1]!, what: `wget output to '${words[i + 1]!}'` };
			}
			if (w.startsWith("--output-document=")) {
				const target = w.slice("--output-document=".length);
				return { kind: "command", target, what: `wget output to '${target}'` };
			}
		}
	}
	if (command === "git") {
		const sub = words.slice(1).find((w) => !w.startsWith("-"));
		if (sub === "apply" || sub === "am") {
			return { kind: "command", what: "git apply/am (patch via shell)" };
		}
	}
	return undefined;
}

export function detectShellMutation(command: string): ShellMutation | undefined {
	for (const rawSegment of command.split(/[\n|;&]+/)) {
		const segment = isCollaborationInvocation(rawSegment) ? stripQuotedSpans(rawSegment) : rawSegment;
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

/**
 * Every write destination a shell segment could touch: redirects, tee,
 * simple mutation verbs, sed -i, transfers, dd, and network tool outputs.
 * Anchored tamper scanning runs this against live config surfaces instead
 * of pattern-matching path segments anywhere in the command text. Callers
 * handle collaboration segments themselves (quoted arguments are data).
 */
export function mutationDestinationsIn(segment: string): string[] {
	const destinations: string[] = [];
	for (const mutation of redirectMutationsIn(segment)) {
		if (mutation.target) destinations.push(mutation.target);
	}
	for (const target of teeTargetsIn(segment)) {
		destinations.push(target);
	}
	for (const mutation of simpleFilesystemMutations(segment)) {
		if (mutation.target) destinations.push(mutation.target);
	}
	const transfer = filesystemTransferInfo(segment);
	if (transfer?.destination) destinations.push(transfer.destination);
	const fallback = shellMutationIn(segment.trim());
	if (fallback?.target) destinations.push(fallback.target);
	return destinations;
}
