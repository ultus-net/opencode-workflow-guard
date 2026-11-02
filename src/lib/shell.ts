import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
}

export function extractCommands(input: unknown): string[] {
	if (typeof input === "string") {
		return [input];
	}
	const record = asRecord(input);
	if (!record) {
		return [];
	}
	const commands: string[] = [];
	if (typeof record.command === "string") commands.push(record.command);
	if (Array.isArray(record.commands)) {
		for (const c of record.commands) {
			if (typeof c === "string") commands.push(c);
		}
	}
	return commands;
}

export function normalize(cmd: string): string {
	return cmd.replace(/\s+/g, " ");
}

export function dynamicShellSyntaxIn(command: string): string | undefined {
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (let i = 0; i < command.length; i += 1) {
		const char = command[i]!;
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (char === "'") {
			if (!quote) quote = "'";
			else if (quote === "'") quote = undefined;
			continue;
		}
		if (char === '"') {
			if (!quote) quote = '"';
			else if (quote === '"') quote = undefined;
			continue;
		}
		if (quote === "'") continue;
		if (char === "`" || (char === "$" && command[i + 1] === "(") || (!quote && (char === "<" || char === ">") && command[i + 1] === "(")) {
			return "dynamic command/process substitution";
		}
		if (char === "$" && /^(?:IFS\b|\{IFS(?:\}|[:\[]))/.test(command.slice(i + 1))) return "dynamic IFS expansion";
		if (!quote && (char === "\r" || /[\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u.test(char))) {
			return "ambiguous shell whitespace";
		}
	}
	if (quote || escaped) return "malformed shell quoting";
	return undefined;
}

export function decodeShellEscapes(text: string): string {
	return text
		// ANSI-C quoting wrapper: $'...' -> ...
		.replace(/\$'([^']*)'/g, "$1")
		// Hex escapes: \xHH
		.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
		// Unicode escapes: \uHHHH
		.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
		// Octal escapes: \0OO or \OOO (e.g. \162 -> 'r')
		.replace(/\\([0-3][0-7]{2})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

// Reduce a shell segment to the syntax that actually executes: redirect
// targets are honored whether quoted or not (a quoted redirect target is
// still a real file), while SELF-CONTAINED quoted spans preceded by
// whitespace are command data and can never be shell redirects or
// operators. Quote spans glued to bare text are shell concatenation inside
// a single word (e.g. open''code.json) and are kept for the normalizer to
// flatten. A quoted span at segment start is NOT stripped: it can be a
// quoted command word ("opencode" auth) and must stay visible to verb
// patterns.
export function prepareRedirectResidue(segment: string): string {
	const withTargets = segment
		.replace(/(>>?)\s*'([^']*)'/g, "$1 $2")
		.replace(/(>>?)\s*"([^"]*)"/g, '$1 $2');
	return withTargets
		.replace(/\s'[^']*'(?=$|[\s)>;&|])/g, " ")
		.replace(/\s"[^"]*"(?=$|[\s)>;&|])/g, " ");
}

export function shellWords(command: string): string[] {
	const words: string[] = [];
	let word = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let started = false;
	for (const char of command) {
		if (escaped) {
			word += char;
			escaped = false;
			started = true;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaped = true;
			started = true;
			continue;
		}
		if (char === "'" || char === '"') {
			if (!quote) quote = char;
			else if (quote === char) quote = undefined;
			else word += char;
			started = true;
			continue;
		}
		if (!quote && /\s/.test(char)) {
			if (started) words.push(word);
			word = "";
			started = false;
			continue;
		}
		word += char;
		started = true;
	}
	if (escaped) word += "\\";
	if (started) words.push(word);
	return words;
}

function envSplitWords(value: string): string[] {
	const words: string[] = [];
	let word = "";
	let quote: "'" | '"' | undefined;
	let started = false;
	const push = () => {
		if (started) words.push(word);
		word = "";
		started = false;
	};
	for (let i = 0; i < value.length; i += 1) {
		const char = value[i]!;
		if (char === "'" || char === '"') {
			if (!quote) quote = char;
			else if (quote === char) quote = undefined;
			else word += char;
			started = true;
			continue;
		}
		if (char === "\\" && i + 1 < value.length) {
			const next = value[++i]!;
			if (quote === "'" && next !== "'" && next !== "\\") {
				word += `\\${next}`;
				started = true;
				continue;
			}
			if (next === "c" && !quote) break;
			if (next === "_" && quote !== "'") {
				if (quote === '"') {
					word += " ";
					started = true;
				} else push();
				continue;
			}
			const escapes: Record<string, string> = { f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "#": "#", "$": "$", '"': '"', "'": "'", "\\": "\\" };
			word += escapes[next] ?? next;
			started = true;
			continue;
		}
		if (!quote && /[\s\f\v]/.test(char)) {
			push();
			continue;
		}
		if (!quote && char === "#" && !started) break;
		if (char === "$" && quote !== "'" && value[i + 1] === "{") {
			const end = value.indexOf("}", i + 2);
			if (end >= 0) {
				const name = value.slice(i + 2, end);
				word += process.env[name] ?? "";
				started = true;
				i = end;
				continue;
			}
		}
		word += char;
		started = true;
	}
	push();
	return words;
}

export function splitShellSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: "'" | '"' | "ansi" | undefined;
	let escaped = false;
	for (let i = 0; i < command.length; i += 1) {
		const char = command[i]!;
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (!quote && char === "$" && command[i + 1] === "'") {
			current += "$'";
			quote = "ansi";
			i += 1;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			current += char;
			escaped = true;
			continue;
		}
		if (quote === "ansi" && char === "'") {
			quote = undefined;
			current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			if (!quote) quote = char;
			else if (quote === char) quote = undefined;
			current += char;
			continue;
		}
		if (!quote && /[\n|;&]/.test(char)) {
			if (current.trim()) segments.push(current.trim());
			current = "";
			continue;
		}
		current += char;
	}
	if (current.trim()) segments.push(current.trim());
	return segments;
}

function unwrapShellWordsImpl(command: string): { words: string[]; changesCwd: boolean; cwdTarget?: string; assignments: string[] } {
	let cleanCmd = decodeShellEscapes(command.trim());
	// Strip outer grouping parentheses/braces if present e.g. ( git commit ) or { git commit; }
	while (
		(cleanCmd.startsWith("(") && cleanCmd.endsWith(")")) ||
		(cleanCmd.startsWith("{") && cleanCmd.endsWith("}"))
	) {
		cleanCmd = cleanCmd.slice(1, -1).trim();
		if (cleanCmd.endsWith(";")) cleanCmd = cleanCmd.slice(0, -1).trim();
	}

	const words = shellWords(cleanCmd);
	let i = 0;
	let changesCwd = false;
	// Directory a wrapper (`env -C`, `sudo -D`) runs its command in. Recorded
	// so a caller can judge a nested command in the tree it actually runs in
	// instead of the shell's initial workdir.
	let cwdTarget: string | undefined;
	// Environment assignments consumed while unwrapping wrappers. They apply to
	// the command that follows, so callers must not read them out of the command
	// arguments instead: `git commit -m GIT_DIR=/repo` is message text, not an
	// assignment, and treating it as one would claim a repository that the
	// invocation never named.
	const assignments: string[] = [];
	while (i < words.length) {
		const rawWord = words[i]!;
		const word = rawWord.replace(/^[\({]+/, "").replace(/[\)};]+$/, "");
		if (!word) {
			i++;
			continue;
		}

		if (word === "command") {
			i++;
			while (i < words.length && words[i] === "-p") i++;
			if (words[i] === "--") i++;
			continue;
		}
		if (word === "exec") {
			i++;
			while (i < words.length && words[i]!.startsWith("-")) {
				const option = words[i++]!;
				if (option === "--") break;
				if (option === "-a" && i < words.length) i++;
			}
			continue;
		}
		if (word === "nohup") {
			i++;
			continue;
		}
		if (word === "nice") {
			i++;
			if (i < words.length && (words[i] === "-n" || words[i]?.startsWith("-n"))) {
				if (words[i] === "-n") i += 2;
				else i++;
			}
			continue;
		}
		if (word === "timeout") {
			i++;
			while (i < words.length && words[i]!.startsWith("-")) {
				const opt = words[i++]!;
				if ((opt === "-k" || opt === "-s" || opt === "--signal" || opt === "--kill-after") && i < words.length) {
					i++;
				}
			}
			if (i < words.length && /^\d+[smhd]?$/.test(words[i]!)) {
				i++;
			}
			continue;
		}
		if (word === "stdbuf") {
			i++;
			while (i < words.length && words[i]!.startsWith("-")) {
				const opt = words[i++]!;
				if ((opt === "-i" || opt === "-o" || opt === "-e") && i < words.length) {
					i++;
				}
			}
			continue;
		}
		if (word === "time") {
			i++;
			while (i < words.length && words[i]!.startsWith("-")) {
				i++;
			}
			continue;
		}
		if (word === "sudo" || word === "doas") {
			i++;
			const valueOptions = new Set([
				"-u",
				"--user",
				"-g",
				"--group",
				"-h",
				"--host",
				"-p",
				"--prompt",
				"-C",
				"--close-from",
				"-R",
				"--chroot",
				"-D",
				"--chdir",
			]);
			while (i < words.length && words[i]!.startsWith("-")) {
				const option = words[i++]!;
				if (option === "-D" || (option.startsWith("-D") && option !== "-D") || option === "--chdir" || option.startsWith("--chdir=")) {
					changesCwd = true;
					// The target is the next word unless it was attached (-Ddir).
					if (option === "-D" || option === "--chdir") cwdTarget = words[i];
					else cwdTarget = option.replace(/^-D|^--chdir=/, "");
				}
				if (valueOptions.has(option) && i < words.length) i++;
			}
			continue;
		}
		if (word === "env") {
			i++;
			const valueOptions = new Set([
				"-u",
				"--unset",
				"--argv0",
				"-C",
				"--chdir",
				"-S",
				"--split-string",
			]);
			while (i < words.length) {
				const w = words[i]!;
				if (w === "--") {
					i++;
					break;
				}
				if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
					assignments.push(w);
					i++;
					continue;
				}
				let splitValue: string | undefined;
				let consumed = 0;
				const clustered = /^-[iv0]*([SC])(.*)$/.exec(w);
				if (clustered?.[1] === "C") {
					changesCwd = true;
					i++;
					if (clustered[2]) cwdTarget = clustered[2];
					else if (i < words.length) cwdTarget = words[i++];
					continue;
				}
				if (clustered?.[1] === "S") {
					if (clustered[2]) splitValue = clustered[2];
					else if (i + 1 < words.length) {
						splitValue = words[i + 1]!;
						consumed = 1;
					}
				}
				else if (w.startsWith("-S") && w !== "-S") splitValue = w.slice(2);
				else if (w.startsWith("--split-string=")) splitValue = w.slice("--split-string=".length);
				else if ((w === "-S" || w === "--split-string") && i + 1 < words.length) {
					splitValue = words[i + 1]!;
					consumed = 1;
				}
				if (splitValue !== undefined) {
					words.splice(i, consumed + 1, ...envSplitWords(splitValue));
					continue;
				}
				const clusteredValue = /^-[iv0]*([ua])(.*)$/.exec(w);
				if (clusteredValue) {
					i++;
					if (!clusteredValue[2] && i < words.length) i++;
					continue;
				}
				if (w.startsWith("-C") && w !== "-C") {
					changesCwd = true;
					cwdTarget = w.slice(2);
					i++;
					continue;
				}
				if (!w.startsWith("-")) break;
				i++;
				if (w === "-C" || w === "--chdir" || w.startsWith("--chdir=")) {
					changesCwd = true;
					if (w === "--chdir") cwdTarget = words[i];
					else if (w.startsWith("--chdir=")) cwdTarget = w.slice("--chdir=".length);
					else cwdTarget = words[i];
				}
				if (valueOptions.has(w) && i < words.length) i++;
			}
			continue;
		}
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
			assignments.push(word);
			i++;
			continue;
		}
		break;
	}
	return { words: words
		.slice(i)
		.map((w) => w.replace(/^[\({]+/, "").replace(/[\)};]+$/, ""))
		.filter(Boolean), changesCwd, cwdTarget, assignments };
}

export function unwrapShellWords(command: string): string[] {
	return unwrapShellWordsImpl(command).words;
}

/**
 * The directory a wrapper (`env -C`, `sudo -D`) runs its command in, if it
 * names one. The target is left unexpanded: the caller knows the directory it
 * is relative to.
 */
export function shellWrapperCwd(command: string): string | undefined {
	return unwrapShellWordsImpl(command).cwdTarget;
}

/**
 * One shell segment and the directory it runs in.
 *
 * `root` is `undefined` when the walk cannot determine it: an unresolvable
 * `cd` target (`cd $DIR`, `cd -`), a `pushd` that swaps the directory stack,
 * or a `popd` with no tracked push. Callers treat that as indeterminate
 * instead of assuming the session's checkout, because that assumption is how a
 * `cd` into another tree used to hide a mutation from the boundary policy.
 */
export interface ShellSegmentPlan {
	segment: string;
	root: string | undefined;
}

const CWD_WORDS = new Set(["cd", "pushd", "popd"]);

/** Expands only the directory forms a shell expands deterministically. */
function expandCwdTarget(target: string): string | undefined {
	const home = process.env.HOME || homedir();
	if (target === "~") return home;
	if (target.startsWith("~/")) return join(home, target.slice(2));
	// `cd ~user` resolves to that user's home, never to a literal `~user`
	// directory. Reading it as a relative path put a `cd ~csh` walk inside the
	// workspace while the shell reached the real home.
	const named = /^~([^/\s]+)(?:\/|$)/.exec(target);
	if (named) {
		try {
			return named[1] === userInfo().username ? home : join("/home", named[1]!);
		} catch {
			return undefined;
		}
	}
	if (/^\$(?:HOME|\{HOME\})(?:$|[/\\])/.test(target)) {
		return target.replace(/^\$(?:HOME|\{HOME\})/, home);
	}
	if (target.includes("$")) return undefined;
	return target;
}

/** Words that carry no directory of their own; a control-flow body follows them. */
const TRANSPARENT_PREFIX = new Set([
	"builtin",
	"command",
	"then",
	"else",
	"elif",
	"do",
	"if",
	"while",
	"until",
	"for",
	"!",
	"time",
]);

/**
 * A `pushd` operand that rotates or only pushes the stack.
 *
 * `pushd +N`/`-N` swaps entries, and `-n` pushes without changing directory.
 * The walk tracks a single saved directory, so it cannot model either. Both are
 * reported as an unchecked change, which fails closed for a mutation.
 */
function pushdRotation(operand: string): boolean {
	return /^[+-]\d+$/.test(operand) || operand === "-n" || /^-n./.test(operand);
}

function cwdChangeIn(segment: string): { word: string; target?: string; unmodeled?: boolean } | undefined {
	const words = unwrapShellWords(segment);
	let i = 0;
	// `case x in a) cd /other;; esac` runs the `cd` in the current shell. The
	// pattern is one word after `in`, and the command follows it.
	if (words[0] === "case") {
		const inIndex = words.indexOf("in");
		i = inIndex >= 0 ? inIndex + 2 : words.length;
	}
	while (i < words.length) {
		const word = words[i]!;
		if (TRANSPARENT_PREFIX.has(word)) {
			i += 1;
			continue;
		}
		if (CWD_WORDS.has(word)) break;
		// A case pattern closes with `)`, and the command after it runs here.
		if (word.endsWith(")") || word === "}") {
			i += 1;
			continue;
		}
		return undefined;
	}
	const word = words[i];
	if (!word || !CWD_WORDS.has(word)) return undefined;
	if (word === "popd") return { word };
	let target: string | undefined;
	let unmodeled = false;
	for (let j = i + 1; j < words.length; j += 1) {
		const candidate = words[j]!;
		if (candidate === "--") continue;
		if (word === "pushd" && pushdRotation(candidate)) {
			unmodeled = true;
			continue;
		}
		// `cd -` moves to OLDPWD, which this walk does not track.
		if (candidate === "-") return { word, target: undefined };
		if (candidate.startsWith("-")) continue;
		target = candidate;
		break;
	}
	if (unmodeled) return { word, target: undefined };
	if (target !== undefined) return { word, target };
	// A bare `cd` moves to $HOME, a known directory. A bare `pushd` swaps the
	// top two entries of the directory stack, which is not tracked here.
	return { word, target: word === "cd" ? "~" : undefined };
}

/**
 * Unquoted parenthesis counts in a segment.
 *
 * `splitShellSegments` splits on `&&`/`;`/`|` but not on grouping, so a
 * subshell arrives as segments that still carry its parens. A `cd` inside one
 * must not move the directory of the segments after the subshell closes.
 */
function groupParensIn(segment: string): { opens: number; closes: number } {
	let opens = 0;
	let closes = 0;
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (const char of segment) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (char === "'" || char === '"') {
			if (!quote) quote = char;
			else if (quote === char) quote = undefined;
			continue;
		}
		if (quote) continue;
		if (char === "(") opens += 1;
		else if (char === ")") closes += 1;
	}
	return { opens, closes };
}

/**
 * Walk a multi-segment command and resolve the directory each segment runs in.
 *
 * Later segments run in the directory an earlier `cd`/`pushd` selected, and a
 * wrapper `-C`/`-D` moves only its own command. Judging every segment against
 * the shell's initial `workdir` let `cd <other-tree> && git commit` be checked
 * as if it happened in the session's own checkout.
 *
 * A `cd` inside a grouping subshell is scoped to it, so the segments after the
 * closing paren keep the outer directory. Without that, `( cd /other && ls )
 * && rm -rf dist` would read the removal as happening in `/other`.
 */
export function planShellSegments(command: string, baseDir: string | undefined): ShellSegmentPlan[] {
	const plan: ShellSegmentPlan[] = [];
	let cwd = baseDir;
	const dirStack: Array<string | undefined> = [];
	// Each open grouping paren saves the outer directory and the outer stack.
	// A `pushd` inside `( … )` must not leave an entry a later outer `popd`
	// consumes: bash discards the subshell's stack with it.
	const groupStack: Array<{ cwd: string | undefined; dirStack: Array<string | undefined> }> = [];
	for (const segment of splitShellSegments(command)) {
		const { opens, closes } = groupParensIn(segment);
		for (let i = 0; i < opens; i += 1) groupStack.push({ cwd, dirStack: [...dirStack] });
		const wrapperCwd = shellWrapperCwd(segment);
		let root = cwd;
		if (wrapperCwd !== undefined) {
			const expanded = expandCwdTarget(wrapperCwd);
			root = expanded === undefined || cwd === undefined ? undefined : resolve(cwd, expanded);
		}
		plan.push({ segment, root });
		const change = cwdChangeIn(segment);
		if (change) {
			if (change.word === "popd") {
				cwd = dirStack.pop();
			} else {
				if (change.word === "pushd") dirStack.push(cwd);
				const expanded = change.target === undefined ? undefined : expandCwdTarget(change.target);
				cwd = cwd === undefined || expanded === undefined ? undefined : resolve(cwd, expanded);
			}
		}
		for (let i = 0; i < closes; i += 1) {
			const outer = groupStack.pop();
			if (outer) {
				cwd = outer.cwd;
				dirStack.length = 0;
				dirStack.push(...outer.dirStack);
			}
		}
	}
	return plan;
}

/** Environment assignments that precede the command word, after unwrapping. */
export function shellPrefixAssignments(command: string): string[] {
	return unwrapShellWordsImpl(command).assignments;
}

export function shellWrappersChangeCwd(command: string): boolean {
	return unwrapShellWordsImpl(command).changesCwd;
}

export function unwrapShellCommand(command: string): string {
	return unwrapShellWords(command).join(" ");
}
