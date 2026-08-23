import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AuditEntry } from "./types.ts";
import { asRecord } from "./utils.ts";

const AUDIT_DIR = join(
	process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
	"opencode",
	"workflow-guard",
);
const AUDIT_FILE = join(AUDIT_DIR, "workflow-guard.jsonl");

export function getAuditFilePath(): string {
	return AUDIT_FILE;
}

export function getRecentAuditEntries(limit = 10): AuditEntry[] {
	try {
		if (!existsSync(AUDIT_FILE)) return [];
		const lines = readFileSync(AUDIT_FILE, "utf8").trim().split("\n");
		const entries: AuditEntry[] = [];
		for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
			const line = lines[i]?.trim();
			if (line) {
				try {
					entries.push(JSON.parse(line));
				} catch {}
			}
		}
		return entries;
	} catch {
		return [];
	}
}

export function audit(entry: AuditEntry): void {
	try {
		mkdirSync(AUDIT_DIR, { recursive: true });
		appendFileSync(AUDIT_FILE, JSON.stringify(entry) + "\n", "utf8");
	} catch {
		// Logging must never break the guard.
	}
}

export function logDecision(
	tool: string,
	input: unknown,
	context: { sessionID?: string } | undefined,
	reason: string | undefined,
	evidence?: AuditEntry["evidence"],
): void {
	audit({
		ts: new Date().toISOString(),
		sessionID: context?.sessionID,
		tool,
		decision: reason ? "block" : "allow",
		reason,
		input: summarizeInput(input),
		evidence,
	});
}

export function summarizeInput(input: unknown): unknown {
	const record = asRecord(input);
	if (!record) return typeof input === "string" ? input.slice(0, 200) : input;
	if (typeof record.response === "string") {
		return {
			sessionID: record.sessionID,
			permissionID: record.permissionID,
			response: record.response,
		};
	}
	if (typeof record.command === "string") return { command: record.command.slice(0, 200) };
	if (typeof record.filePath === "string") return { filePath: record.filePath };
	if (typeof record.path === "string") return { path: record.path };
	if (typeof record.patchText === "string") return { patchText: record.patchText.slice(0, 200) };
	return { keys: Object.keys(record) };
}
