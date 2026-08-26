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

function unwrapShellWordsImpl(command: string): { words: string[]; changesCwd: boolean } {
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
				if (option === "-D" || (option.startsWith("-D") && option !== "-D") || option === "--chdir" || option.startsWith("--chdir=")) changesCwd = true;
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
					i++;
					continue;
				}
				let splitValue: string | undefined;
				let consumed = 0;
				const clustered = /^-[iv0]*([SC])(.*)$/.exec(w);
				if (clustered?.[1] === "C") {
					changesCwd = true;
					i++;
					if (!clustered[2] && i < words.length) i++;
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
					i++;
					continue;
				}
				if (!w.startsWith("-")) break;
				i++;
				if (w === "-C" || w === "--chdir" || w.startsWith("--chdir=")) changesCwd = true;
				if (valueOptions.has(w) && i < words.length) i++;
			}
			continue;
		}
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
			i++;
			continue;
		}
		break;
	}
	return { words: words
		.slice(i)
		.map((w) => w.replace(/^[\({]+/, "").replace(/[\)};]+$/, ""))
		.filter(Boolean), changesCwd };
}

export function unwrapShellWords(command: string): string[] {
	return unwrapShellWordsImpl(command).words;
}

export function shellWrappersChangeCwd(command: string): boolean {
	return unwrapShellWordsImpl(command).changesCwd;
}

export function unwrapShellCommand(command: string): string {
	return unwrapShellWords(command).join(" ");
}
