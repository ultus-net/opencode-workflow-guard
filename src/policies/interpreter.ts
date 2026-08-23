export function extractInterpreterPayload(segment: string): string[] {
	const payloads: string[] = [];
	const inlineMatch = segment.match(
		/\b(?:python3?|node|perl|ruby|osascript)\s+(?:-[a-zA-Z]*[ce]\s+)(?:"([^"]*)"|'([^']*)')/i,
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
