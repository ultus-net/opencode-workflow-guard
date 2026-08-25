import { appendFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
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

/**
 * Reads recent audit entries from the end of the JSONL audit log with a bounded
 * buffer window to prevent memory spikes on long-lived installations.
 */
export function getRecentAuditEntries(limit = 10): AuditEntry[] {
	try {
		if (!existsSync(AUDIT_FILE)) return [];
		const stat = statSync(AUDIT_FILE);
		if (stat.size === 0) return [];

		const maxBytesToRead = Math.min(stat.size, 65_536);
		const buffer = Buffer.alloc(maxBytesToRead);
		const fd = openSync(AUDIT_FILE, "r");
		try {
			readSync(fd, buffer, 0, maxBytesToRead, stat.size - maxBytesToRead);
		} finally {
			closeSync(fd);
		}

		const text = buffer.toString("utf8");
		const lines = text.trim().split("\n");
		const completeLines = maxBytesToRead < stat.size ? lines.slice(1) : lines;

		const entries: AuditEntry[] = [];
		for (let i = completeLines.length - 1; i >= 0 && entries.length < limit; i--) {
			const line = completeLines[i]?.trim();
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
	context: { sessionID?: string; callID?: string } | undefined,
	reason: string | undefined,
	evidence?: AuditEntry["evidence"],
): void {
	audit({
		ts: new Date().toISOString(),
		sessionID: context?.sessionID,
		callID: context?.callID,
		tool,
		decision: reason ? "block" : "allow",
		phase: "decision",
		reason,
		input: summarizeInput(input),
		evidence,
	});
}

export function summarizeInput(input: unknown): unknown {
	const record = asRecord(input);
	if (!record) return typeof input === "string" ? summarizeSensitiveText(input) : input;
	if (typeof record.response === "string") {
		return {
			sessionID: record.sessionID,
			permissionID: record.permissionID,
			response: record.response,
		};
	}
	if (typeof record.command === "string") return { command: summarizeSensitiveText(record.command) };
	if (typeof record.filePath === "string") return { filePath: record.filePath };
	if (typeof record.path === "string") return { path: record.path };
	if (typeof record.patchText === "string") return { patchText: summarizeSensitiveText(record.patchText) };
	return { keys: Object.keys(record) };
}

function summarizeSensitiveText(value: string): { bytes: number; sha256: string } {
	return {
		bytes: Buffer.byteLength(value, "utf8"),
		sha256: createHash("sha256").update(value).digest("hex"),
	};
}
