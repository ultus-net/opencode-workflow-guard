import { getSdkClient } from "./state.ts";

export function asRecord(value: unknown): Record<string, unknown> | undefined {
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

export function decodeShellEscapes(text: string): string {
	return text
		// ANSI-C quoting wrapper: $'...' -> ...
		.replace(/\$'([^']*)'/g, "$1")
		// Hex escapes: \xHH
		.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
		// Unicode escapes: \uHHHH
		.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
		// Octal escapes: \0OO or \OOO (e.g. \162 -> 'r')
		.replace(/\\([0-3][0-7]{2})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
		// Single character escapes: \c -> c (e.g. \r\m -> rm)
		.replace(/\\(.)/g, "$1");
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

export function splitShellSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (const char of command) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			current += char;
			escaped = true;
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

export function unwrapShellWords(command: string): string[] {
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
	while (i < words.length) {
		const rawWord = words[i]!;
		const word = rawWord.replace(/^[\({]+/, "").replace(/[\)};]+$/, "");
		if (!word) {
			i++;
			continue;
		}

		if (word === "command" || word === "exec" || word === "eval" || word === "nohup") {
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
				if (valueOptions.has(option) && i < words.length) i++;
			}
			continue;
		}
		if (word === "env") {
			i++;
			const valueOptions = new Set([
				"-u",
				"--unset",
				"-C",
				"--chdir",
				"-S",
				"--split-string",
			]);
			while (i < words.length) {
				const w = words[i]!;
				if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
					i++;
					continue;
				}
				if (!w.startsWith("-")) break;
				i++;
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
	return words
		.slice(i)
		.map((w) => w.replace(/^[\({]+/, "").replace(/[\)};]+$/, ""))
		.filter(Boolean);
}

export function unwrapShellCommand(command: string): string {
	return unwrapShellWords(command).join(" ");
}

export const SENSITIVE_ENV_KEYS = [
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"OPENAI_KEY",
	"KUBECONFIG",
	"NPM_TOKEN",
	"DOCKER_AUTH",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GCLOUD_AUTH",
	"AZURE_CREDENTIALS",
	"SLACK_TOKEN",
];
export const SENSITIVE_ENV_RE =
	/^(AWS_|KUBE|OPENAI|ANTHROPIC|GOOGLE_|GCP_|AZURE_|SLACK_|NPM_|DOCKER_|KUBECONFIG)/;

export function getCleanEnv(): Record<string, string> {
	const env: Record<string, string> = { ...(process.env as Record<string, string>) };
	for (const key of SENSITIVE_ENV_KEYS) {
		delete env[key];
	}
	for (const key of Object.keys(env)) {
		if (SENSITIVE_ENV_RE.test(key)) {
			delete env[key];
		}
	}
	return env;
}

export async function showBlockToast(message: string): Promise<void> {
	try {
		const client = getSdkClient();
		await client?.tui?.showToast?.({
			body: {
				title: "Workflow Guard Blocked",
				message: message.slice(0, 180),
				variant: "warning",
			},
		});
	} catch {}
}
