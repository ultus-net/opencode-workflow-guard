import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ShellMutation } from "../lib/types.ts";
import type { ShellSegmentPlan } from "../lib/shell.ts";
import {
	getWorkspaceRoot,
	recordMutation,
} from "../lib/state.ts";
import { prepareRedirectResidue, planShellSegments, shellWords, unwrapShellCommand } from "../lib/shell.ts";
import { isCollaborationInvocation, isProtectedPath, PROTECTED_PATH_REASON } from "./tamper.ts";
import { isSecretPath, secretIn } from "./secrets.ts";
import { isGitTreeWriteText, branchGuardReason, onProtectedBranch, parseGitInvocation } from "./git.ts";
import { isSameGitRepo } from "../lib/project-config.ts";
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

/**
 * A mutation/redirect target whose expansion is indeterminate (it contains an
 * unresolvable `$VARIABLE` reference): the boundary treats such destinations
 * as outside the workspace, and block messages attribute that cause instead
 * of the generic escape message.
 */
export function hasUnresolvableVariable(targetPath: string): boolean {
	return expandShellTargetPath(targetPath) === null;
}

/**
 * The OpenCode harness designates this directory as the agents' scratch
 * space ("pre-created and approved for external access"), but the workspace
 * boundary is workspace-absolute and does not cover it. Targets under it get
 * a cause-attributed block message so agents stop treating the block as a
 * guard bug and write scratch as untracked files inside the workspace
 * instead. Message-only: the boundary decision itself is unchanged.
 */
export const OPENCODE_SCRATCH_DIR = "/tmp/opencode";

export function isEnvironmentScratchTarget(targetPath: string, root: string): boolean {
	const expanded = expandShellTargetPath(targetPath);
	if (expanded === null) return false;
	const resolved = resolve(root, expanded);
	return resolved === OPENCODE_SCRATCH_DIR || resolved.startsWith(OPENCODE_SCRATCH_DIR + "/");
}

export function isPathOutsideWorkspace(targetPath: string, root: string): boolean {
	if (!targetPath) return false;
	const expanded = expandShellTargetPath(targetPath);
	if (expanded === null) return true;
	const resolved = resolve(root, expanded);
	const normalizedRoot = root.endsWith("/") ? root : root + "/";
	// A path is outside only when BOTH the lexical resolution and the
	// canonical resolution are outside. The lexical verdict is therefore
	// held instead of returned early: symlink aliases of the workspace
	// itself (e.g. /home -> /var/home) resolve lexically outside but
	// canonically inside, and must be accepted, while the canonical checks
	// below keep blocking symlinks inside the workspace that point outside.
	// When canonicalization is indeterminate (no existing ancestor), the
	// lexical verdict stands (fail-closed).
	const lexicallyOutside = resolved !== root && !resolved.startsWith(normalizedRoot);
	// The boundary is resolved against the workspace THIS call declares (the
	// `root` argument), never against a process-global latched root: concurrent
	// loops share one guard process, and a latched root must not redefine
	// another session's boundary. Symlink-awareness is preserved (ancestor
	// walk below) by canonicalizing the declared root itself.
	let realRootVal = root;
	try {
		realRootVal = realpathSync(root);
	} catch {}
	let canonicallyInside = false;
	try {
		const real = realpathSync(resolved);
		const realRoot = realRootVal.endsWith("/") ? realRootVal : realRootVal + "/";
		if (real !== realRootVal && !real.startsWith(realRoot)) {
			return true;
		}
		canonicallyInside = true;
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
				canonicallyInside = true;
				break;
			} catch {}
		}
	}
	// Relocated lexical verdict: reached only when canonicalization did not
	// find the path outside, so a lexically-outside path that canonicalized
	// inside (a symlink alias of the workspace) is no longer blocked here.
	return lexicallyOutside && !canonicallyInside;
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

const SIMPLE_MUTATION_COMMANDS = new Set(["touch", "mkdir", "rm", "unlink", "rmdir", "truncate", "chmod", "chown", "chgrp"]);
const TRANSFER_COMMANDS = new Set(["cp", "mv", "ln", "rsync", "install", "cpio", "scp"]);

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

// Remove single- and double-quoted spans from a shell segment. Used to
// analyze the residue of collaboration invocations: quoted arguments are
// command data and can never be shell redirects, while unquoted redirects
// keep receiving full validation. NOTE: unlike shell.ts's
// prepareRedirectResidue, this strips EVERY span including redirect
// targets and glued concatenations - only use it for collaboration
// segments where all quoted content is command data.
function stripQuotedSpans(segment: string): string {
	return segment.replace(/'[^'\n]*'/g, " ").replace(/"[^"\n]*"/g, " ");
}

/**
 * A segment that changes a tree this session may not judge: a mutation or git
 * write whose directory could not be resolved (`cd $DIR && git commit`) or
 * whose directory is a foreign repository (`cd /other-repo && rm -rf dist`).
 *
 * Relative targets in such a segment would be validated against the session's
 * own checkout while the command changes another tree. That is the defect a
 * shell-level `cd` used to hide, so it is refused rather than judged.
 */
export function foreignSegmentMutationReason(
	segments: ShellSegmentPlan[],
	workspaceRoot: string,
): string | undefined {
	for (const { segment, root } of segments) {
		const mutation = detectShellMutation(segment);
		const gitWrite = isGitTreeWrite(segment, root ?? workspaceRoot);
		if (!mutation && !gitWrite) continue;
		if (root === undefined) {
			return `Blocked: the command changes directory to a target that cannot be determined without executing shell expansion, then runs a mutation (${mutation?.what ?? "git write"}). Indeterminate destinations are treated as outside the workspace root (${workspaceRoot}). Use a literal directory inside the workspace.`;
		}
		if (!isPathOutsideWorkspace(root, workspaceRoot) || isSameGitRepo(root, workspaceRoot)) continue;
		return `Blocked: the command changes into '${root}' and mutates it (${mutation?.what ?? "git write"}), but that directory is outside workspace root (${workspaceRoot}) and is not a linked worktree of this repository. Relative targets there cannot be validated against the tree the command would actually change. Run the command from inside the workspace instead.`;
	}
	return undefined;
}

function isGitTreeWrite(segment: string, baseDir: string): boolean {
	const invocation = parseGitInvocation(segment.trim(), baseDir);
	if (!invocation) return false;
	return isGitTreeWriteText(`git ${invocation.rest}`);
}

/**
 * The working directory an inline interpreter payload names for the commands it
 * runs.
 *
 * `execSync('git commit', {cwd: '<dir>'})` carries the tree directly instead of
 * changing directory first, so the payload walk alone cannot see it. The match
 * is anchored to a spawn-family call or `process.chdir`, because a bare `cwd:`
 * key in an unrelated object literal does not choose a working directory.
 *
 * A named directory that is not a literal (`{cwd: process.env.OTHER}`) is
 * reported as indeterminate rather than ignored, matching the shell rule that
 * an unresolvable destination fails closed for a mutation.
 */
export type PayloadWorkingRoot =
	| { status: "none" }
	| { status: "resolved"; root: string }
	| { status: "indeterminate"; raw: string };

// Only a call site that actually spawns a process names a working directory.
// `execSync`, `spawn`, and friends are unambiguous. A bare `exec` is guarded by
// its preceding token so `regex.exec(str, {cwd: …})` is not a spawn, while
// `child_process.exec(...)` still is. A bare `cwd:` key in an unrelated object
// literal names no working directory at all.
const SPAWN_CALLEE = String.raw`(?:(?:child_process|cp)\.)?(?:execSync|execFileSync|spawnSync|execFile|spawn|fork)|(?:child_process|cp)\.exec|(?<![.\w$])exec`;
const PROCESS_CHDIR = /\bprocess\s*\.\s*chdir\s*\(\s*([^)]+?)\s*\)/;

/**
 * The argument text of every spawn-family call, found with a balanced scan.
 *
 * A flat `[^)]*` stopped at the first closing paren, so
 * `execSync(require('path').join('a','b'), {cwd: '/other'})` matched nothing and
 * its foreign `cwd` went unchecked.
 */
function spawnCallArguments(payload: string): string[] {
	const spans: string[] = [];
	const callee = new RegExp(String.raw`(?:${SPAWN_CALLEE})\s*\(`, "g");
	for (let match = callee.exec(payload); match; match = callee.exec(payload)) {
		let depth = 0;
		let quote: string | undefined;
		const start = match.index + match[0].length - 1;
		for (let i = start; i < payload.length; i += 1) {
			const char = payload[i]!;
			if (quote) {
				if (char === quote && payload[i - 1] !== "\\") quote = undefined;
				continue;
			}
			if (char === "'" || char === '"' || char === "`") {
				quote = char;
				continue;
			}
			if (char === "(") depth += 1;
			else if (char === ")") {
				depth -= 1;
				if (depth === 0) {
					spans.push(payload.slice(start + 1, i));
					break;
				}
			}
		}
		callee.lastIndex = Math.max(callee.lastIndex, start + 1);
	}
	return spans;
}

/**
 * The `cwd` of the call's own options object, ignoring a nested one.
 *
 * The argument text is split at top-level commas, and only an argument that is
 * itself an object literal contributes. Without that, `execSync(fn({cwd: '<a>'}),
 * {cwd: '<b>'})` read the nested object's key first and reported a workspace
 * directory for a call that actually ran in `<b>`.
 */
function callOwnCwd(args: string): string | undefined {
	let depth = 0;
	let quote: string | undefined;
	const topLevel: string[] = [];
	let current = "";
	for (let i = 0; i < args.length; i += 1) {
		const char = args[i]!;
		if (quote) {
			if (char === quote && args[i - 1] !== "\\") quote = undefined;
			current += char;
			continue;
		}
		if (char === "'" || char === '"' || char === "`") {
			quote = char;
			current += char;
			continue;
		}
		if (char === "{" || char === "[" || char === "(") depth += 1;
		else if (char === "}" || char === "]" || char === ")") depth -= 1;
		if (char === "," && depth === 0) {
			topLevel.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	topLevel.push(current);
	for (const argument of topLevel) {
		const trimmed = argument.trim();
		if (!trimmed.startsWith("{")) continue;
		const match = /\bcwd\s*:\s*([^,}]+)/.exec(trimmed);
		if (match?.[1]) return match[1].trim();
	}
	return undefined;
}

export function payloadWorkingRoot(payload: string): PayloadWorkingRoot {
	const cwdValues = spawnCallArguments(payload)
		.map(callOwnCwd)
		.filter((value): value is string => value !== undefined);
	const chdir = PROCESS_CHDIR.exec(payload)?.[1]?.trim();
	if (chdir) cwdValues.push(chdir);
	// Every call's directory has to agree. Two different trees, or one that is
	// not a literal, means the payload's real directory is not determinable, and
	// a mutation then fails closed rather than trusting the first one found.
	const roots = new Set<string>();
	for (const raw of cwdValues) {
		const literal = /^(["'`])([^"'`]*)\1$/.exec(raw);
		if (!literal?.[2]) return { status: "indeterminate", raw };
		roots.add(literal[2]);
	}
	if (roots.size === 0) return { status: "none" };
	if (roots.size > 1) return { status: "indeterminate", raw: [...roots].join(", ") };
	return { status: "resolved", root: [...roots][0]! };
}

function payloadMutates(payload: string): boolean {
	if (detectShellMutation(payload)) return true;
	return isGitTreeWriteText(payload);
}

/**
 * A segment-level git invocation whose repository is outside the workspace.
 *
 * The dispatcher applies this check to top-level commands. A payload was never
 * routed through it, so `bash -c 'git -C <other> commit'` reached a foreign
 * repository: the `-C` form carries no `cd`, and `isGitTreeWriteText` reads the
 * `git <verb>` text without resolving the flag.
 */
function foreignGitRepositoryIn(segment: string, baseDir: string, workspaceRoot: string): string | undefined {
	for (const raw of segment.split(/[\n|;&]+/)) {
		const invocation = parseGitInvocation(raw.trim(), baseDir);
		if (!invocation) continue;
		if (!isGitTreeWriteText(`git ${invocation.rest}`)) continue;
		const repoDir = invocation.repoDir;
		const foreign = hasUnresolvableVariable(repoDir)
			|| (isPathOutsideWorkspace(repoDir, workspaceRoot) && !isSameGitRepo(repoDir, workspaceRoot));
		if (foreign) return repoDir;
	}
	return undefined;
}

/**
 * The tree a nested interpreter payload changes, when that tree is one this
 * session may not judge.
 *
 * A payload never reaches the top-level segment walk: `bash -c 'cd <other> &&
 * git commit'` is one shell word to the outer shell, so its nested `cd` and
 * mutation were invisible. `extractPayloads` and `writesIn` are injected so
 * this policy does not import the interpreter scanner back.
 */
export function nestedPayloadMutationReason(
	extractPayloads: (segment: string) => string[],
	writesIn: (payload: string) => string[],
	command: string,
	baseDir: string,
	workspaceRoot: string,
	depth = 0,
): string | undefined {
	// Nesting deeper than this is not modelled. A launcher chain that deep is
	// refused rather than skipped, so the cap cannot become a way through.
	if (depth > 8) {
		return `Blocked: inline interpreter scripts are nested deeper than the ${8} levels this check models, so the tree they mutate cannot be determined. Run the command from a single script file inside the workspace instead.`;
	}
	for (const { segment, root } of planShellSegments(command, baseDir, (s) => {
		// `eval` runs in the current shell, so its body's `cd` moves later
		// segments. Only an `eval` body counts here; another launcher's payload
		// runs in a child process and cannot move this shell.
		return /\beval\b/.test(s) ? extractPayloads(s)[0] : undefined;
	})) {
		const payloads = extractPayloads(segment);
		if (payloads.length === 0) continue;
		// A launcher whose directory is indeterminate must not be assumed to be
		// the workspace root: `cd $DIR && node -e "writeFileSync('x')"` would then
		// read as a workspace write. The payload's own relative targets cannot be
		// validated against a tree this walk could not resolve, so a mutation
		// fails closed, matching the shell rule for the same shape.
		const launcherRoot = root;
		if (launcherRoot === undefined) {
			const mutates = payloads.some((payload) => writesIn(payload).length > 0 || payloadMutates(payload));
			if (mutates) {
				return `Blocked: the command changes directory to a target that cannot be determined without executing shell expansion, then runs an inline interpreter script that mutates. Indeterminate destinations are treated as outside the workspace root (${workspaceRoot}). Use a literal directory inside the workspace.`;
			}
			continue;
		}
		for (const payload of payloads) {
			const foreignRepo = foreignGitRepositoryIn(payload, launcherRoot, workspaceRoot);
			if (foreignRepo) {
				return `Blocked: the inline interpreter script runs a git write against '${foreignRepo}', outside workspace root (${workspaceRoot}) and not a linked worktree of this repository. Run the command from inside the workspace instead.`;
			}
			const nested = foreignSegmentMutationReason(planShellSegments(payload, launcherRoot), workspaceRoot);
			if (nested) return nested;
			// A payload can launch another interpreter: `bash -c "bash -c 'cd
			// <other> && git commit'"` only extracts its own quoted body. Re-plan
			// each payload until the nesting bottoms out.
			const inner = nestedPayloadMutationReason(extractPayloads, writesIn, payload, launcherRoot, workspaceRoot, depth + 1);
			if (inner) return inner;
			const declared = payloadWorkingRoot(payload);
			if (declared.status === "none") continue;
			if (writesIn(payload).length === 0 && !payloadMutates(payload)) continue;
			if (declared.status === "indeterminate") {
				return `Blocked: the inline interpreter script runs a mutating command in a working directory that cannot be determined without executing the script (${declared.raw}). Indeterminate destinations are treated as outside the workspace root (${workspaceRoot}). Use a literal directory inside the workspace.`;
			}
			const targetRoot = resolve(launcherRoot, declared.root);
			if (!isPathOutsideWorkspace(targetRoot, workspaceRoot) || isSameGitRepo(targetRoot, workspaceRoot)) continue;
			return `Blocked: the inline interpreter script runs a mutating command in '${targetRoot}', outside workspace root (${workspaceRoot}) and not a linked worktree of this repository. Relative targets there cannot be validated against the tree the command would actually change. Run the command from inside the workspace instead.`;
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

export async function guardShellMutation(
	command: string,
	sessionID: string | undefined,
	record = true,
	shellRoot?: string,
	evalBody?: (segment: string) => string | undefined,
): Promise<string | undefined> {
	// Judge the tree the command RUNS in. A linked worktree of this repository
	// is a legitimate workdir, and its branch or relative targets are not the
	// session checkout's: validating against that checkout blocked a mutation
	// in a feature worktree as if it happened on the primary `main`.
	const workspaceRoot = getWorkspaceRoot();
	const root = shellRoot ?? workspaceRoot;
	const plan = planShellSegments(command, root, evalBody);
	// The foreign-tree gate runs here too, so this function is safe when called
	// on its own: an indeterminate or foreign `cd` is refused instead of silently
	// falling back to judging relative targets against the wrong tree.
	const foreignReason = foreignSegmentMutationReason(plan, workspaceRoot);
	if (foreignReason) return foreignReason;
	let hasMutation = false;
	for (const { segment, root: segmentRoot } of plan) {
		// `cd` earlier in the command moves this segment, so its relative targets
		// resolve against the tree it actually changes. An indeterminate `cd` was
		// already refused above.
		const runRoot = segmentRoot ?? root;
		// Both trees are this workspace: the checkout the command runs in and the
		// session's own checkout. Absolute paths into either are legitimate, so a
		// target is outside only when it leaves both.
		const outsideWorkspace = (target: string): boolean =>
			isPathOutsideWorkspace(target, runRoot) && isPathOutsideWorkspace(target, workspaceRoot);
		// Same residue analysis as detectShellMutation: quoted arguments of
		// gh/glab/az PR/issue commands are command data, not shell redirects,
		// while unquoted redirects still get full validation below.
		const cleanSegment = isCollaborationInvocation(segment) ? stripQuotedSpans(segment) : segment;
		const secretSource = secretSourceInFilesystemCommand(cleanSegment);
		if (secretSource) {
			return `Blocked: shell command would copy, move, or link sensitive file '${secretSource}' under a non-secret name.`;
		}
		// mv mutates its SOURCES too (they are removed from their origin), so
		// sources must respect the same boundaries as mutation targets: no
		// moving files in from outside the workspace, no moving protected
		// (settings/plugin) files to innocuous names.
		const transfer = filesystemTransferInfo(cleanSegment);
		if (transfer && shellWords(unwrapShellCommand(cleanSegment))[0] === "mv") {
			for (const source of transfer.sources) {
				if (isProtectedPath(source)) {
					return PROTECTED_PATH_REASON;
				}
				if (outsideWorkspace(source)) {
					if (hasUnresolvableVariable(source)) {
						return `Blocked: mv source '${source}' contains an unresolvable variable reference; indeterminate destinations are treated as outside the workspace root (${workspaceRoot}). Use a literal workspace-relative path.`;
					}
					return `Blocked: mv would remove source '${source}' from outside the workspace root (${workspaceRoot}). File mutations must stay within the workspace.`;
				}
			}
		}
		const simpleMutations = simpleFilesystemMutations(cleanSegment);
		const teeTargets = teeTargetsIn(cleanSegment);
		const teeMutations: ShellMutation[] = teeTargets.map((target) => ({
			kind: "command" as const,
			target,
			what: `tee to '${target}'`,
		}));
		const redirectMutations = redirectMutationsIn(cleanSegment.trim());
		const mutations = [...simpleMutations, ...teeMutations, ...redirectMutations];
		if (mutations.length === 0) {
			const fallbackMutation = shellMutationIn(cleanSegment.trim());
			if (fallbackMutation) mutations.push(fallbackMutation);
		}
		for (const mutation of mutations) {
			hasMutation = true;
			const secret = secretIn(cleanSegment);
			if (secret) {
				return `Blocked: shell file mutation payload appears to contain a ${secret}. Secrets must not be written to disk from agent commands.`;
			}
			const target = mutation.target ?? "";
			if (target && isProtectedPath(target)) {
				return PROTECTED_PATH_REASON;
			}
			if (target && outsideWorkspace(target)) {
				// The workspace boundary has no override: a write outside the
				// workspace is out of bounds even with WORKFLOW_GUARD_ALLOW_LIVE
				// (that override covers live-system commands, not the boundary).
				if (hasUnresolvableVariable(target)) {
					return `Blocked: shell mutation '${mutation.what}' targets '${target}', which contains an unresolvable variable reference; indeterminate destinations are treated as outside the workspace root (${workspaceRoot}). Use a literal workspace-relative path.`;
				}
				if (isEnvironmentScratchTarget(target, runRoot)) {
					return `Blocked: shell mutation '${mutation.what}' targets '${target}' under ${OPENCODE_SCRATCH_DIR}, the environment scratch directory the workspace boundary does not cover; write scratch as an untracked file inside the workspace root (${workspaceRoot}) instead (for example .tmp-notes.md).`;
				}
				return `Blocked: shell mutation '${mutation.what}' targets a path outside the workspace root (${workspaceRoot}). All changes must stay within the workspace.`;
			}
			if (onProtectedBranch(runRoot)) {
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
