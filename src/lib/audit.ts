import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AuditEntry, VerifyResult } from "./types.ts";
import { asRecord } from "./utils.ts";

const AUDIT_DIR = join(
	process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
	"opencode",
	"workflow-guard",
);
const AUDIT_FILE = join(AUDIT_DIR, "workflow-guard.jsonl");
const VERIFY_CACHE_FILE = join(AUDIT_DIR, "last-verify.json");

export function getAuditFilePath(): string {
	return AUDIT_FILE;
}

export function getVerifyCacheFilePath(): string {
	return VERIFY_CACHE_FILE;
}

/**
 * Persists passing verification evidence to disk so session restarts
 * or multi-agent handoffs retain valid verification state.
 */
export function persistVerifyCache(verifyData: NonNullable<VerifyResult>): void {
	try {
		mkdirSync(AUDIT_DIR, { recursive: true });
		writeFileSync(VERIFY_CACHE_FILE, JSON.stringify(verifyData, null, 2), "utf8");
	} catch {}
}

/**
 * Loads durable verification evidence from disk if present and fresh.
 */
export function loadVerifyCache(): VerifyResult | undefined {
	try {
		if (!existsSync(VERIFY_CACHE_FILE)) return undefined;
		const raw = readFileSync(VERIFY_CACHE_FILE, "utf8");
		const data = JSON.parse(raw);
		if (data && typeof data.command === "string" && typeof data.timestamp === "number") {
			return data;
		}
	} catch {}
	return undefined;
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
