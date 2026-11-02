import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";

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
	// workspace while the shell reached the real home. Any other home base is
	// unknown to this walk, so it stays indeterminate rather than naming a
	// directory that does not exist.
	const named = /^~([^/\s]+)(?:\/|$)/.exec(target);
	if (named) {
		try {
			if (named[1] === userInfo().username) return home;
		} catch {
			return undefined;
		}
		const parent = dirname(home);
		return parent && named[1] ? join(parent, named[1]) : undefined;
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

function cwdChangeIn(segment: string, insideCase = false): { word: string; target?: string; unmodeled?: boolean } | undefined {
	const words = unwrapShellWords(segment);
	let i = 0;
	if (insideCase) {
		// `case x in a) cd /other;; esac` arrives as `a) cd /other`, and
		// `unwrapShellWords` has already stripped the pattern's closing paren.
		// The pattern word runs nothing, so the command after it is the body.
		while (i < words.length && !CWD_WORDS.has(words[i]!) && !TRANSPARENT_PREFIX.has(words[i]!) && words[i] !== "case") i += 1;
	}
	while (i < words.length) {
		const word = words[i]!;
		if (TRANSPARENT_PREFIX.has(word)) {
			i += 1;
			continue;
		}
		// `case` opens an arm wherever it appears, including after `then`, `do`,
		// or `else`: the pattern is one word after `in`, and the body follows the
		// pattern. Treating only a leading `case` as an arm hid `then case x in x)
		// cd <other>`, so the `cd` was never seen.
		if (word === "case") {
			const inIndex = words.indexOf("in", i);
			i = inIndex >= 0 ? inIndex + 2 : words.length;
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
	if (word === "popd") {
		// `popd +N`/`-N` rotate the stack instead of popping it, which this walk
		// does not model. A plain `popd` consumes the top entry.
		return words.slice(i + 1).some((operand) => pushdRotation(operand)) ? { word, unmodeled: true } : { word };
	}
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
	if (unmodeled) return { word, unmodeled: true };
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
 *
 * Inside a `case` body a pattern's own `)` is not a grouping close, so it is
 * not counted while a case construct is open.
 */
function groupParensIn(segment: string, insideCase = false): { opens: number; closes: number } {
	// Which characters sit outside quotes, so a `)` inside a string is never a
	// group or pattern terminator.
	const unquoted: boolean[] = [];
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (let i = 0; i < segment.length; i += 1) {
		const char = segment[i]!;
		let bare = false;
		if (escaped) escaped = false;
		else if (char === "\\" && quote !== "'") escaped = true;
		else if (char === "'" || char === '"') {
			if (!quote) quote = char;
			else if (quote === char) quote = undefined;
		} else if (!quote) bare = true;
		unquoted.push(bare);
	}
	// A `case` arm pattern ends with `)`, which closes no group. An arm can open
	// in this segment (`case x in x) …`) or arrive already open (`x) …`), so both
	// forms are recognised. Missing the in-segment form let a pattern's paren pop
	// a subshell frame, which then swallowed the real closing paren.
	const patternCloses = new Set<number>();
	const spelled = unquoted.map((bare, i) => (bare ? segment[i]! : " ")).join("");
	if (/[^\s]/.test(spelled)) {
		for (const head of spelled.matchAll(/\bcase\b[^;|&]*?\bin\b/g)) {
			let from = (head.index ?? 0) + head[0].length;
			while (from < spelled.length) {
				const close = spelled.indexOf(")", from);
				if (close < 0) break;
				patternCloses.add(close);
				const nextArm = spelled.indexOf(";;", close);
				if (nextArm < 0) break;
				from = nextArm + 2;
			}
		}
	}
	let opens = 0;
	let closes = 0;
	// At segment start, `esac )` carries a real group close, not an arm pattern.
	// Reading it as a pattern left the surrounding subshell open, so the segment
	// after it inherited the arm's directory instead of the outer one.
	const startsAtClose = /^\s*(?:esac|fi|done)\b/.test(segment);
	for (let i = 0; i < segment.length; i += 1) {
		if (!unquoted[i]) continue;
		const char = segment[i]!;
		if (char === "(") opens += 1;
		else if (char === ")") {
			if (patternCloses.has(i)) continue;
			// An arm pattern that was already open when this segment began ends
			// here. It closes no group.
			if (insideCase && !startsAtClose && closes + 1 > opens) continue;
			closes += 1;
		}
	}
	return { opens, closes };
}

/**
 * Which construct boundary a segment carries, if any.
 *
 * Only a keyword in command position counts: `echo done` and
 * `git commit -m "if"` carry no construct boundary.
 */
function constructKeywordIn(segment: string): "open" | "close" | "case-open" | "case-close" | undefined {
	const words = unwrapShellWords(segment);
	let i = 0;
	// Wrappers and negation can precede the keyword: `time if …`, `! case …`.
	while (i < words.length && (words[i] === "builtin" || words[i] === "command" || words[i] === "time" || words[i] === "!")) i += 1;
	// A body opener can precede a nested construct: `then case …`, `do case …`.
	// Without this the nested `case` opened no frame, so its `esac` popped the
	// enclosing `if`/`for` frame instead and the arm's `cd` was never recorded.
	// `if`/`while`/`until`/`for` stay out of this list, because they are the
	// openers this function reports.
	while (i < words.length && (words[i] === "then" || words[i] === "else" || words[i] === "do" || words[i] === "elif")) i += 1;
	const word = words[i];
	if (word === "if" || word === "while" || word === "until" || word === "for") return "open";
	if (word === "case") return "case-open";
	if (word === "esac") return "case-close";
	if (word === "fi" || word === "done") return "close";
	return undefined;
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
 *
 * A `cd` inside a conditional or loop body is NOT scoped: that body runs in the
 * current shell. Which body runs depends on a condition this walk cannot
 * evaluate, so a construct whose bodies change directory leaves the later
 * directory undetermined rather than letting the last body parsed win.
 */
export function planShellSegments(command: string, baseDir: string | undefined, evalBody?: (segment: string) => string | undefined): ShellSegmentPlan[] {
	const plan: ShellSegmentPlan[] = [];
	let cwd = baseDir;
	const dirStack: Array<string | undefined> = [];
	// Each open grouping paren saves the outer directory and the outer stack.
	// A `pushd` inside `( … )` must not leave an entry a later outer `popd`
	// consumes: bash discards the subshell's stack with it.
	const groupStack: Array<{ cwd: string | undefined; dirStack: Array<string | undefined> }> = [];
	// One frame per open `if`/`while`/`until`/`for`/`case`, recording whether any
	// body changed directory.
	const constructStack: Array<{ changed: boolean }> = [];
	let caseDepth = 0;
	for (const segment of splitShellSegments(command)) {
		const { opens, closes } = groupParensIn(segment, caseDepth > 0);
		for (let i = 0; i < opens; i += 1) groupStack.push({ cwd, dirStack: [...dirStack] });
		const wrapperCwd = shellWrapperCwd(segment);
		let root = cwd;
		if (wrapperCwd !== undefined) {
			const expanded = expandCwdTarget(wrapperCwd);
			root = expanded === undefined || cwd === undefined ? undefined : resolve(cwd, expanded);
		}
		plan.push({ segment, root });
		const keyword = constructKeywordIn(segment);
		if (keyword === "open") constructStack.push({ changed: false });
		if (keyword === "case-open") {
			constructStack.push({ changed: false });
			caseDepth += 1;
		}
		// `eval` runs its body in the current shell, so a `cd` inside it moves the
		// directory of later segments. The body is supplied by the caller because
		// extracting it lives in the interpreter policy, not here.
		const evaluated = evalBody?.(segment);
		const change = cwdChangeIn(segment, caseDepth > 0) ?? (evaluated === undefined ? undefined : cwdChangeIn(evaluated, caseDepth > 0));
		if (change) {
			for (const frame of constructStack) frame.changed = true;
			if (change.unmodeled) {
				cwd = undefined;
			} else if (change.word === "popd") {
				// `popd` with nothing to pop fails in bash and leaves the
				// directory alone, so it must not clear a tracked directory.
				cwd = dirStack.length > 0 ? dirStack.pop() : cwd;
			} else {
				if (change.word === "pushd") dirStack.push(cwd);
				const expanded = change.target === undefined ? undefined : expandCwdTarget(change.target);
				cwd = cwd === undefined || expanded === undefined ? undefined : resolve(cwd, expanded);
			}
		}
		if (keyword === "case-close") caseDepth = Math.max(0, caseDepth - 1);
		if (keyword === "close" || keyword === "case-close") {
			const frame = constructStack.pop();
			// A body that changed directory only sometimes leaves the later
			// directory dependent on a condition, which fails closed.
			if (frame?.changed) cwd = undefined;
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
