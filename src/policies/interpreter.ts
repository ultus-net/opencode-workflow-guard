import { isSecretPath } from "./secrets.ts";
import { isPathOutsideWorkspace } from "./boundary.ts";
import { heredocBodyIsCode, heredocRanges, maskDataHeredocBodies } from "../lib/shell.ts";

// `eval` runs its argument as shell text, so its payload is scanned like an
// inline interpreter body. It is the one launcher with no option word, so the
// quoted body follows the command directly.
const LAUNCHER_RE = /\b(?:python3?|node|perl|ruby|osascript|bash|sh|zsh|dash|ksh)\s+(?:-[a-zA-Z]*[ce])\s*|\beval\s+/i;

/**
 * The quoted shell word that follows an inline interpreter launcher.
 *
 * A shell word is one argument however many quoted spans it concatenates, so
 * `'bash -c '\''cd /other && rm -rf x'\'''` is a single payload. Stopping at
 * the first closing quote truncated that word to `bash -c `, and the nested
 * command escaped the payload scan entirely.
 */
function inlinePayloadWord(segment: string, start: number): string | undefined {
	let out = "";
	let i = start;
	while (i < segment.length) {
		const char = segment[i]!;
		if (char === "'") {
			i += 1;
			let closed = false;
			while (i < segment.length) {
				const inner = segment[i]!;
				// `'\''` is the idiom for a literal quote inside a single-quoted
				// span: the span closes, an escaped quote follows, a new span opens.
				if (inner === "'" && segment[i + 1] === "\\" && segment[i + 2] === "'" && segment[i + 3] === "'") {
					out += "'";
					i += 4;
					continue;
				}
				if (inner === "'") {
					closed = true;
					i += 1;
					break;
				}
				out += inner;
				i += 1;
			}
			if (!closed) return undefined;
			continue;
		}
		if (char === '"') {
			i += 1;
			let closed = false;
			while (i < segment.length) {
				const inner = segment[i]!;
				if (inner === "\\" && segment[i + 1] !== undefined) {
					out += segment[i + 1];
					i += 2;
					continue;
				}
				if (inner === '"') {
					closed = true;
					i += 1;
					break;
				}
				out += inner;
				i += 1;
			}
			if (!closed) return undefined;
			continue;
		}
		// Unquoted text ends the word at whitespace or a shell operator.
		if (/\s/.test(char) || "|&;()<>".includes(char)) break;
		if (char === "\\" && segment[i + 1] !== undefined) {
			out += segment[i + 1];
			i += 2;
			continue;
		}
		out += char;
		i += 1;
	}
	return out === "" ? undefined : out;
}

export function extractInterpreterPayload(segment: string): string[] {
	const payloads: string[] = [];
	// A heredoc body is prose unless the command reading it executes it, so the
	// launcher scan runs on the masked text instead of reading documentation as
	// code (`bash -c 'cd /other && rm -rf x'` quoted inside a `cat` body).
	const masked = maskDataHeredocBodies(segment);
	const launcher = LAUNCHER_RE.exec(masked);
	if (launcher) {
		const payload = inlinePayloadWord(segment, (launcher.index ?? 0) + launcher[0].length);
		if (payload !== undefined) payloads.push(payload);
	}
	// A heredoc body is code when the command that reads it executes it. An
	// unterminated body still runs, so it is scanned to end of input. The
	// terminator's own newline is not part of the body.
	for (const range of heredocRanges(segment)) {
		if (!heredocBodyIsCode(segment, range.start)) continue;
		const body = segment.slice(range.bodyStart, range.bodyEnd).replace(/\n$/, "");
		if (body !== "") payloads.push(body);
	}
	const psMatch = masked.match(
		/\b(?:powershell|pwsh)\s+(?:-[a-zA-Z]*enc[a-zA-Z]*\s+)([A-Za-z0-9+/=]+)/i,
	);
	if (psMatch?.[1]) {
		try {
			const buf = Buffer.from(psMatch[1], "base64");
			payloads.push(buf.toString("utf8"), buf.toString("utf16le"));
		} catch {}
	}
	const b64PipeMatch = masked.match(
		/echo\s+["']?([A-Za-z0-9+/=]{4,})["']?\s*\|\s*base64\s+(?:-[a-zA-Z]*d[a-zA-Z]*|--decode)\s*\|\s*(?:bash|sh|zsh)/i,
	);
	if (b64PipeMatch?.[1]) {
		try {
			const buf = Buffer.from(b64PipeMatch[1], "base64");
			payloads.push(buf.toString("utf8"), buf.toString("utf16le"));
		} catch {}
	}
	return payloads;
}

const FILE_ACCESS_VERB_RE =
	/\b(?:open|cat|read|readFile|readFileSync|read_text|readTextFile|write|writeFile|writeFileSync|write_text|writeTextFile|source|slurp|appendFile|appendFileSync|createReadStream|createWriteStream|load|loads|exec|execSync|spawn|spawnSync)\b/i;

/**
 * Detects sensitive credential/secret file targets referenced inside inline
 * interpreter scripts or subshells.
 */
export function secretPathInPayload(payload: string): string | undefined {
	if (!FILE_ACCESS_VERB_RE.test(payload)) return undefined;
	const tokens = payload.match(/["'][^"']*["']|[^\s(){}[\];,|&<>]+/g) ?? [];
	for (const token of tokens) {
		const cleaned = token.replace(/^["']|["']$/g, "");
		if (cleaned && isSecretPath(cleaned)) {
			return cleaned;
		}
	}
	return undefined;
}

const WRITE_TARGET_PATTERNS: RegExp[] = [
	/\b(?:File|IO)\.(?:write|binwrite|delete|unlink|rename)\s*\(\s*["']([^"']+)["']/g,
	/\bFile\.open\s*\(\s*["']([^"']+)["']\s*,\s*["'][^"']*[wa+][^"']*["']/g,
	/\b(?:writeFileSync|writeFile|appendFile|appendFileSync|createWriteStream|unlink|unlinkSync|rmSync|rmdirSync|mkdirSync|renameSync|copyFileSync|cpSync|truncateSync)\s*\(\s*["']([^"']+)["']/g,
	/\b(?:renameSync|copyFileSync|cpSync)\s*\(\s*["'][^"']+["']\s*,\s*["']([^"']+)["']/g,
	/\b(?:os\.remove|os\.unlink|os\.rmdir|os\.mkdir|os\.makedirs|os\.rename|shutil\.rmtree|shutil\.copy|shutil\.copy2|shutil\.move)\s*\(\s*["']([^"']+)["']/g,
	/\b(?:os\.rename|shutil\.copy|shutil\.copy2|shutil\.move)\s*\(\s*["'][^"']+["']\s*,\s*["']([^"']+)["']/g,
	/\bopen\s*\(\s*["']([^"']+)["']\s*,\s*["'][^"']*[wax+][^"']*["']/g,
	/\bPath\s*\(\s*["']([^"']+)["']\s*\)\s*\.\s*(?:write_text|write_bytes|unlink|mkdir|touch|rename|replace)\s*\(/g,
	/\bPath\s*\(\s*["'][^"']+["']\s*\)\s*\.\s*(?:rename|replace)\s*\(\s*["']([^"']+)["']/g,
	/[>]{1,2}\s*["']?([^\s;&"'|)]+)/g,
];

/**
 * Detects workspace boundary escapes (writes/redirects to paths outside the
 * workspace root) initiated from inline interpreter payloads. Extracts destination
 * file arguments from file-writing APIs and shell redirects.
 */
export function outsideWritePathInPayload(payload: string, root: string): string | undefined {
	const candidates = new Set<string>();

	for (const pattern of WRITE_TARGET_PATTERNS) {
		const matches = payload.matchAll(pattern);
		for (const m of matches) {
			if (m[1]) candidates.add(m[1]);
		}
	}

	for (const candidate of candidates) {
		if (/^\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)$/.test(candidate)) continue;
		if (isPathOutsideWorkspace(candidate, root)) {
			return candidate;
		}
	}
	return undefined;
}

export function writePathsInPayload(payload: string): string[] {
	const candidates = new Set<string>();
	for (const pattern of WRITE_TARGET_PATTERNS) {
		for (const match of payload.matchAll(pattern)) {
			if (match[1]) candidates.add(match[1]);
		}
	}
	return [...candidates];
}
