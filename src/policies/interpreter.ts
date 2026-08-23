import { isSecretPath } from "./secrets.ts";
import { isPathOutsideWorkspace } from "./boundary.ts";

export function extractInterpreterPayload(segment: string): string[] {
	const payloads: string[] = [];
	const inlineMatch = segment.match(
		/\b(?:python3?|node|perl|ruby|osascript|bash|sh|zsh|dash|ksh)\s+(?:-[a-zA-Z]*[ce]\s+)(?:"([^"]*)"|'([^']*)')/i,
	);
	if (inlineMatch?.[1] || inlineMatch?.[2]) {
		payloads.push(inlineMatch[1] ?? inlineMatch[2] ?? "");
	}
	const psMatch = segment.match(
		/\b(?:powershell|pwsh)\s+(?:-[a-zA-Z]*enc[a-zA-Z]*\s+)([A-Za-z0-9+/=]+)/i,
	);
	if (psMatch?.[1]) {
		try {
			const buf = Buffer.from(psMatch[1], "base64");
			payloads.push(buf.toString("utf8"), buf.toString("utf16le"));
		} catch {}
	}
	const b64PipeMatch = segment.match(
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

const FUNCTION_TARGET_PATTERNS: RegExp[] = [
	/\b(?:writeFileSync|writeFile|appendFile|appendFileSync|createWriteStream|unlink|unlinkSync|rmSync|rmdirSync|mkdirSync|renameSync|copyFileSync|cpSync|truncateSync)\s*\(\s*["']([^"']+)["']/g,
	/\b(?:open|os\.remove|os\.unlink|os\.rmdir|os\.mkdir|os\.makedirs|os\.rename|shutil\.rmtree|shutil\.copy|shutil\.copy2|shutil\.move|Path)\s*\(\s*["']([^"']+)["']/g,
	/[>]{1,2}\s*["']?([^\s;&"'|)]+)/g,
];

/**
 * Detects workspace boundary escapes (writes/redirects to paths outside the
 * workspace root) initiated from inline interpreter payloads. Extracts destination
 * file arguments from file-writing APIs and shell redirects.
 */
export function outsideWritePathInPayload(payload: string, root: string): string | undefined {
	const candidates = new Set<string>();

	for (const pattern of FUNCTION_TARGET_PATTERNS) {
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
