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

export function shellWords(command: string): string[] {
	return (command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map((word) =>
		word.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2"),
	);
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
	const words = shellWords(command.trim());
	let i = 0;
	while (i < words.length) {
		if (words[i] === "command") {
			i++;
			continue;
		}
		if (words[i] === "sudo") {
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
		if (words[i] === "env") {
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
				const word = words[i]!;
				if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
					i++;
					continue;
				}
				if (!word.startsWith("-")) break;
				i++;
				if (valueOptions.has(word) && i < words.length) i++;
			}
			continue;
		}
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) {
			i++;
			continue;
		}
		break;
	}
	return words.slice(i);
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
	/^(AWS_|KUBE|OPENAI|ANTHROPIC|GH_TOKEN|GITHUB_TOKEN|GOOGLE_|GCP_|AZURE_|SLACK_|NPM_|DOCKER_|KUBECONFIG)/;

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
