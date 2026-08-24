import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { getWorkspaceRoot } from "../lib/state.ts";
import { shellWords, unwrapShellCommand } from "../lib/utils.ts";

export const SAFE_ENV_FIXTURE_RE =
	/\.env\.(example|sample|template|dist|schema)(\.[\w-]+)*$/i;

export interface SecretPattern {
	re: RegExp;
	what: string;
}

export const SECRET_PATTERNS: SecretPattern[] = [
	{ re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, what: "private key material" },
	{ re: /\bAKIA[0-9A-Z]{16}\b/, what: "AWS access key ID" },
	{ re: /\bASIA[0-9A-Z]{16}\b/, what: "AWS temporary session credential" },
	{ re: /\bghp_[A-Za-z0-9]{36}\b/, what: "GitHub personal access token" },
	{ re: /\bgithub_pat_[A-Za-z0-9_]{82}\b/, what: "GitHub fine-grained PAT" },
	{ re: /\bgho_[A-Za-z0-9]{36}\b/, what: "GitHub OAuth token" },
	{ re: /\bghu_[A-Za-z0-9]{36}\b/, what: "GitHub user-to-server token" },
	{ re: /\bghs_[A-Za-z0-9]{36}\b/, what: "GitHub server-to-server token" },
	{ re: /\bghr_[A-Za-z0-9]{36}\b/, what: "GitHub refresh token" },
	{ re: /\bsk-[A-Za-z0-9]{20,}\b/, what: "OpenAI-style API key" },
	{ re: /\bog-[A-Za-z0-9]{20,}\b/, what: "OpenCode/legacy API key" },
	{ re: /\bAIza[0-9A-Za-z_-]{35}\b/, what: "Google API key" },
	{ re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, what: "Slack token (xox family)" },
	{ re: /(?:^|\s)(?:AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)\s*=\s*\S+/, what: "AWS credential assignment" },
	{ re: /(?:^|\s)(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENAI_KEY)\s*=\s*\S+/, what: "LLM API key assignment" },
];

export function secretIn(content: string): string | undefined {
	for (const { re, what } of SECRET_PATTERNS) {
		if (re.test(content)) return what;
	}
	return undefined;
}

export function isSecretPath(targetPath: string): boolean {
	if (!targetPath) return false;
	const root = getWorkspaceRoot();
	const resolved = resolve(root, targetPath);
	const matches = (path: string): boolean => {
		const base = basename(path).toLowerCase();
		const full = path.toLowerCase();

		// Safe fixtures
		if (SAFE_ENV_FIXTURE_RE.test(base)) {
			return false;
		}

		// .env files (e.g. .env, .env.local, .env.prod, .env.secret)
		if (/^\.env(?:\.|$)/i.test(base)) {
			return true;
		}

		// SSH & TLS key material
		if (
			/^(id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.|$)/i.test(base) ||
			/\.(pem|key|pkcs12|pfx|p12)$/i.test(base)
		) {
			return true;
		}

		// Cloud / cluster / service account credentials
		if (
			/kubeconfig/i.test(base) ||
			full.includes("/.kube/config") ||
			/^(service[-_]?account|client[-_]?secret).*\.json$/i.test(base) ||
			/credentials\.json$/i.test(base) ||
			full.includes("/.aws/credentials") ||
			full.includes("/.docker/config.json") ||
			base === ".netrc" ||
			base === ".git-credentials"
		) {
			return true;
		}

		return false;
	};

	if (matches(resolved)) return true;
	try {
		return matches(realpathSync(resolved));
	} catch {
		return false;
	}
}

/**
 * Returns true specifically for environment variable files (.env, .env.local,
 * etc.) that can safely present their schema (masked keys) to agents without
 * exposing secret values.
 */
export function isEnvFilePath(targetPath: string): boolean {
	if (!targetPath) return false;
	const base = basename(targetPath).toLowerCase();
	if (SAFE_ENV_FIXTURE_RE.test(base)) return false;
	return /^\.env(?:\.|$)/i.test(base);
}

/**
 * Parses a raw .env file and returns a sanitized schema mask where variable
 * names and comment structures are preserved, but sensitive values (including
 * multiline secret continuations) are redacted to '********'.
 */
export function generateMaskedEnvSchema(content: string): string {
	const lines = content.split("\n");
	let inMultilineQuote: string | null = null;

	return lines
		.map((line) => {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) {
				inMultilineQuote = null;
				return line;
			}

			if (inMultilineQuote) {
				if (trimmed.endsWith(inMultilineQuote) || trimmed.includes(inMultilineQuote)) {
					inMultilineQuote = null;
				}
				return "********";
			}

			const eqIdx = line.indexOf("=");
			if (eqIdx === -1) {
				return "********";
			}

			const key = line.slice(0, eqIdx);
			const val = line.slice(eqIdx + 1).trim();

			if (
				(val.startsWith('"') && !val.slice(1).includes('"')) ||
				(val.startsWith("'") && !val.slice(1).includes("'"))
			) {
				inMultilineQuote = val[0]!;
			}

			return `${key}=********`;
		})
		.join("\n");
}

export const SECRET_READ_COMMAND_RE =
	/(?:^|\s)(?:cat|head|tail|less|more|grep|awk|sed|od|hexdump|strings|base64|xxd|nl|sort|uniq|view|nano|vim?)\s+[^|;&]*?(?:["']?)([\w\/.~-]*\.(?:pem|key|pfx|p12)|[\w\/.~-]*\.env(?:\.[\w-]+)*|[\w\/.~-]*id_(?:rsa|dsa|ecdsa|ed25519)[\w.-]*|[\w\/.~-]*kubeconfig[\w.-]*|[\w\/.~-]*(?:service[-_]?account|credentials|client[-_]?secret)[\w.-]*\.json)(?:["']?)/i;
export const SIMPLE_FILE_READ_COMMAND_RE =
	/(?:^|\s)(?:cat|head|tail|less|more|od|hexdump|strings|base64|xxd|nl|view|nano|vim?)\s+(?:-\S+\s+)*["']?([^\s|;&"']+)/i;

export function secretFileReadIn(segment: string): string | undefined {
	const match = segment.match(SECRET_READ_COMMAND_RE);
	if (match?.[1] && isSecretPath(match[1])) {
		return match[1];
	}
	const simpleMatch = segment.match(SIMPLE_FILE_READ_COMMAND_RE);
	if (simpleMatch?.[1] && isSecretPath(simpleMatch[1])) return simpleMatch[1];
	const words = shellWords(unwrapShellCommand(segment));
	if (["cat", "head", "tail", "less", "more", "od", "hexdump", "strings", "base64", "xxd", "nl", "view", "nano", "vim"].includes(words[0] ?? "")) {
		for (const operand of words.slice(1).filter((word) => !word.startsWith("-"))) {
			if (isSecretPath(operand)) return operand;
		}
	}
	if (words[0] === "dd") {
		for (const word of words.slice(1)) {
			if (word.startsWith("if=") && isSecretPath(word.slice(3))) return word.slice(3);
		}
	}
	return undefined;
}
