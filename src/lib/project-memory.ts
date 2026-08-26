import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { Database, type SqliteDatabase } from "./sqlite.ts";
import type { ProjectMemoryInput, ProjectMemoryKind, ProjectMemoryRecord, ProjectMemorySource, ReviewFollowup, ReviewFollowupInput } from "./types.ts";

const KINDS = new Set<ProjectMemoryKind>(["fact", "decision", "constraint", "lesson"]);
const SOURCES = new Set<ProjectMemorySource>(["user", "file", "git", "tool", "agent", "portable"]);
const DAY_MS = 24 * 60 * 60 * 1000;
const OBSOLETE_RETENTION_MS = 90 * DAY_MS;
const MAINTENANCE_INTERVAL_MS = DAY_MS;
const STORAGE_LIMIT_BYTES = 100 * 1024 * 1024;
const STORAGE_TARGET_BYTES = 80 * 1024 * 1024;

export interface ProjectMemoryStore {
	db: SqliteDatabase;
	projectId: string;
	path: string;
	activeMarker?: string;
	close(): void;
}

interface MaintenanceOptions {
	force?: boolean;
	now?: number;
	storageLimitBytes?: number;
	storageTargetBytes?: number;
}

export function getProjectMemoryDir(): string {
	const base = process.env.XDG_DATA_HOME || join(process.env.HOME || process.cwd(), ".local", "share");
	return join(base, "opencode", "workflow-guard", "project-memory");
}

export function getProjectMemoryIdentity(root: string): string {
	const result = spawnSync("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" });
	const identity = result.status === 0 && result.stdout.trim() ? resolve(result.stdout.trim()) : resolve(root);
	return createHash("sha256").update(identity).digest("hex").slice(0, 24);
}

export function ensureProjectMemoryExcluded(root: string): boolean {
	const result = spawnSync("git", ["-C", root, "rev-parse", "--git-path", "info/exclude"], { encoding: "utf8" });
	if (result.status !== 0 || !result.stdout.trim()) return false;
	const path = resolve(root, result.stdout.trim());
	let current = "";
	try { current = readFileSync(path, "utf8"); } catch {}
	if (current.split("\n").some((line) => line.trim() === ".opencode/memory/")) return true;
	appendFileSync(path, `${current && !current.endsWith("\n") ? "\n" : ""}.opencode/memory/\n`);
	return true;
}

export function isProjectMemoryFresh(memory: ProjectMemoryRecord, root: string): boolean {
	if (!memory.commit || memory.paths.length === 0) return true;
	if (!/^[0-9a-f]{7,64}$/i.test(memory.commit)) return false;
	const result = spawnSync("git", ["-C", root, "diff", "--quiet", memory.commit, "--", ...memory.paths], { encoding: "utf8", timeout: 2_000 });
	if (result.status !== 0) return false;
	const untracked = spawnSync("git", ["-C", root, "ls-files", "--others", "--exclude-standard", "--", ...memory.paths], { encoding: "utf8", timeout: 2_000 });
	return untracked.status === 0 && !untracked.stdout.trim();
}

function execGit(root: string, args: string[]): Promise<{ status: number; stdout: string }> {
	return new Promise((resolve) => {
		execFile("git", ["-C", root, ...args], { encoding: "utf8", timeout: 2_000 }, (error, stdout) => {
			resolve({ status: error ? (typeof error.code === "number" ? error.code : -1) : 0, stdout });
		});
	});
}

export async function isProjectMemoryFreshAsync(memory: ProjectMemoryRecord, root: string): Promise<boolean> {
	if (!memory.commit || memory.paths.length === 0) return true;
	if (!/^[0-9a-f]{7,64}$/i.test(memory.commit)) return false;
	const [diff, untracked] = await Promise.all([
		execGit(root, ["diff", "--quiet", memory.commit, "--", ...memory.paths]),
		execGit(root, ["ls-files", "--others", "--exclude-standard", "--", ...memory.paths]),
	]);
	return diff.status === 0 && untracked.status === 0 && !untracked.stdout.trim();
}

export function openProjectMemory(projectId: string, directory = getProjectMemoryDir()): ProjectMemoryStore {
	if (!projectId || projectId.length > 200) throw new Error("Invalid project memory identity.");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const path = join(directory, `${projectId.replace(/[^a-zA-Z0-9._-]/g, "_")}.sqlite`);
	const activeMarker = `${path}.active.${process.pid}.${randomUUID()}`;
	const releaseLock = acquireDatabaseLock(directory);
	let db: SqliteDatabase | undefined;
	try {
		writeFileSync(activeMarker, "", { mode: 0o600 });
		db = new Database(path);
		db.exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA busy_timeout = 2000;
		CREATE TABLE IF NOT EXISTS memories (
			id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL,
			source TEXT NOT NULL, created_at INTEGER NOT NULL, session_id TEXT, commit_sha TEXT,
			paths TEXT NOT NULL, supersedes TEXT, status TEXT NOT NULL DEFAULT 'current', superseded_at INTEGER
		);
		CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, content);
		CREATE TABLE IF NOT EXISTS review_followups (
			id TEXT PRIMARY KEY, project_id TEXT NOT NULL, severity TEXT NOT NULL, summary TEXT NOT NULL,
			reviewer TEXT NOT NULL, created_at INTEGER NOT NULL, resolved_at INTEGER, session_id TEXT,
			commit_sha TEXT, paths TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open'
		);
		`);
		const memoryColumns = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
		if (!memoryColumns.some((column) => column.name === "superseded_at")) {
			db.exec("ALTER TABLE memories ADD COLUMN superseded_at INTEGER");
			db.exec("UPDATE memories SET superseded_at = created_at WHERE status = 'superseded'");
		}
	} catch (error) {
		try { db?.close(); } finally { rmSync(activeMarker, { force: true }); }
		throw error;
	} finally {
		releaseLock();
	}
	if (!db) throw new Error("Project memory database failed to initialize.");
	const store: ProjectMemoryStore = { db, projectId, path, activeMarker, close: () => { try { db.close(); } finally { rmSync(activeMarker, { force: true }); } } };
	try { maintainProjectMemoryStorage(store, directory); } catch {}
	return store;
}

function acquireDatabaseLock(directory: string): () => void {
	const lock = new Database(join(directory, ".coordination"));
	try {
		lock.exec("PRAGMA busy_timeout = 2000; BEGIN IMMEDIATE");
	} catch (error) {
		lock.close();
		throw error;
	}
	return () => { try { lock.exec("COMMIT"); } finally { lock.close(); } };
}

function databaseDiskUsage(path: string): number {
	let size = 0;
	for (const suffix of ["", "-wal", "-shm"]) try { size += statSync(path + suffix).size; } catch {}
	return size;
}

function databaseIsActive(path: string, directory: string): boolean {
	const prefix = `${path.slice(directory.length + 1)}.active.`;
	let active = false;
	for (const name of readdirSync(directory).filter((entry) => entry.startsWith(prefix))) {
		const pid = Number(name.slice(prefix.length).split(".", 1)[0]);
		if (!Number.isInteger(pid) || pid <= 0) { active = true; continue; }
		try { process.kill(pid, 0); active = true; } catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") rmSync(join(directory, name), { force: true });
			else active = true;
		}
	}
	return active;
}

export function maintainProjectMemoryStorage(store: ProjectMemoryStore, directory = getProjectMemoryDir(), options: MaintenanceOptions = {}): void {
	const now = options.now ?? Date.now();
	const maintenanceMarker = `${store.path}.maintenance`;
	const releaseMaintenanceLock = acquireDatabaseLock(directory);
	try {
		let lastMaintained = 0;
		try { lastMaintained = statSync(maintenanceMarker).mtimeMs; } catch {}
		if (!options.force && now - lastMaintained < MAINTENANCE_INTERVAL_MS) return;

		const cutoff = now - OBSOLETE_RETENTION_MS;
		store.db.exec("BEGIN IMMEDIATE");
		try {
			store.db.prepare("DELETE FROM memories_fts WHERE id IN (SELECT id FROM memories WHERE status = 'superseded' AND superseded_at < ?)").run(cutoff);
			store.db.prepare("DELETE FROM memories WHERE status = 'superseded' AND superseded_at < ?").run(cutoff);
			store.db.prepare("DELETE FROM review_followups WHERE status = 'resolved' AND resolved_at < ?").run(cutoff);
			store.db.exec("COMMIT");
		} catch (error) {
			store.db.exec("ROLLBACK");
			throw error;
		}
		store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		store.db.exec("PRAGMA optimize");
		store.db.exec("VACUUM");
		try { utimesSync(store.path, now / 1000, now / 1000); } catch {}
		writeFileSync(maintenanceMarker, "", { mode: 0o600 });
		try { utimesSync(maintenanceMarker, now / 1000, now / 1000); } catch {}
	} finally {
		releaseMaintenanceLock();
	}

	const limit = options.storageLimitBytes ?? STORAGE_LIMIT_BYTES;
	const target = Math.min(limit, options.storageTargetBytes ?? STORAGE_TARGET_BYTES);
	const candidates = readdirSync(directory)
		.filter((name) => name.endsWith(".sqlite"))
		.map((name) => join(directory, name))
		.filter((path) => path !== store.path)
		.flatMap((path) => { try { const stat = statSync(path); return [{ path, size: databaseDiskUsage(path), mtimeMs: stat.mtimeMs }]; } catch { return []; } });
	let total = candidates.reduce((sum, item) => sum + item.size, databaseDiskUsage(store.path));
	if (total <= limit) return;
	for (const candidate of candidates.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
		const releaseCandidateLock = acquireDatabaseLock(directory);
		try {
			if (databaseIsActive(candidate.path, directory)) continue;
			for (const suffix of ["", "-wal", "-shm", ".maintenance"]) rmSync(candidate.path + suffix, { force: true });
		} finally {
			releaseCandidateLock();
		}
		total -= candidate.size;
		if (total <= target) break;
	}
}

function followupRowToRecord(row: Record<string, unknown>): ReviewFollowup {
	return {
		id: String(row.id), projectId: String(row.project_id), severity: String(row.severity) as ReviewFollowup["severity"],
		summary: String(row.summary), reviewer: String(row.reviewer), createdAt: Number(row.created_at),
		resolvedAt: row.resolved_at ? Number(row.resolved_at) : undefined, sessionID: row.session_id ? String(row.session_id) : undefined,
		commit: row.commit_sha ? String(row.commit_sha) : undefined, paths: JSON.parse(String(row.paths)) as string[],
		status: String(row.status) as ReviewFollowup["status"],
	};
}

export function recordReviewFollowup(store: ProjectMemoryStore, input: ReviewFollowupInput, id: string = randomUUID()): ReviewFollowup {
	if (input.severity !== "P2" && input.severity !== "P3") throw new Error("Review follow-up severity must be P2 or P3.");
	if (!input.summary.trim() || input.summary.length > 4000) throw new Error("Review follow-up summary must be 1-4000 characters.");
	if (!input.reviewer.trim() || input.reviewer.length > 200) throw new Error("Invalid review follow-up reviewer.");
	if ((input.paths?.length ?? 0) > 20 || input.paths?.some((path) => !path || path.length > 500 || isAbsolute(path) || path.split(/[\\/]/).includes("..") || /[\0\r\n]/.test(path))) throw new Error("Invalid review follow-up paths.");
	if (input.sessionID && input.sessionID.length > 200) throw new Error("Invalid review follow-up session ID.");
	if (input.commit && !/^[0-9a-f]{7,64}$/i.test(input.commit)) throw new Error("Invalid review follow-up commit.");
	const createdAt = Date.now();
	store.db.prepare("INSERT INTO review_followups VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'open')").run(
		id, store.projectId, input.severity, input.summary.trim(), input.reviewer.trim(), createdAt,
		input.sessionID ?? null, input.commit ?? null, JSON.stringify(input.paths ?? []),
	);
	return { id, projectId: store.projectId, ...input, summary: input.summary.trim(), reviewer: input.reviewer.trim(), paths: input.paths ?? [], createdAt, status: "open" };
}

export function listReviewFollowups(store: ProjectMemoryStore, status: "open" | "resolved" = "open", limit = 50): ReviewFollowup[] {
	const rows = store.db.prepare("SELECT * FROM review_followups WHERE project_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?")
		.all(store.projectId, status, Math.max(1, Math.min(limit, 200))) as Record<string, unknown>[];
	return rows.map(followupRowToRecord);
}

export function resolveReviewFollowup(store: ProjectMemoryStore, id: string): boolean {
	if (!id || id.length > 200 || /[\0\r\n]/.test(id)) return false;
	const result = store.db.prepare("UPDATE review_followups SET status = 'resolved', resolved_at = ? WHERE id = ? AND project_id = ? AND status = 'open'")
		.run(Date.now(), id, store.projectId);
	return Number(result.changes) === 1;
}

function validateInput(input: ProjectMemoryInput): void {
	if (!KINDS.has(input.kind) || !SOURCES.has(input.source)) throw new Error("Invalid project memory kind or source.");
	if (!input.content.trim() || input.content.length > 4000) throw new Error("Project memory content must be 1-4000 characters.");
	if ((input.paths?.length ?? 0) > 20 || input.paths?.some((path) => !path || path.length > 500 || isAbsolute(path) || path.split(/[\\/]/).includes("..") || /[\0\r\n]/.test(path))) throw new Error("Invalid project memory paths.");
	if (input.sessionID && input.sessionID.length > 200) throw new Error("Invalid project memory session ID.");
	if (input.commit && !/^[0-9a-f]{7,64}$/i.test(input.commit)) throw new Error("Invalid project memory commit.");
	if (input.supersedes && (input.supersedes.length > 200 || /[\0\r\n]/.test(input.supersedes))) throw new Error("Invalid superseded project memory ID.");
}

function rowToRecord(row: Record<string, unknown>): ProjectMemoryRecord {
	return {
		id: String(row.id), projectId: String(row.project_id), kind: String(row.kind) as ProjectMemoryKind,
		content: String(row.content), source: String(row.source) as ProjectMemorySource, createdAt: Number(row.created_at),
		sessionID: row.session_id ? String(row.session_id) : undefined, commit: row.commit_sha ? String(row.commit_sha) : undefined,
		paths: JSON.parse(String(row.paths)) as string[], supersedes: row.supersedes ? String(row.supersedes) : undefined,
		status: String(row.status) as "current" | "superseded",
	};
}

export function recordProjectMemory(store: ProjectMemoryStore, input: ProjectMemoryInput, id: string = randomUUID()): ProjectMemoryRecord {
	validateInput(input);
	const createdAt = Date.now();
	store.db.exec("BEGIN IMMEDIATE");
	try {
		if (input.supersedes) store.db.prepare("UPDATE memories SET status = 'superseded', superseded_at = ? WHERE id = ? AND project_id = ?").run(createdAt, input.supersedes, store.projectId);
		store.db.prepare("INSERT INTO memories (id, project_id, kind, content, source, created_at, session_id, commit_sha, paths, supersedes, status, superseded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'current', NULL)").run(
			id, store.projectId, input.kind, input.content.trim(), input.source, createdAt,
			input.sessionID ?? null, input.commit ?? null, JSON.stringify(input.paths ?? []), input.supersedes ?? null,
		);
		store.db.prepare("INSERT INTO memories_fts(id, content) VALUES (?, ?)").run(id, input.content.trim());
		store.db.exec("COMMIT");
	} catch (error) {
		store.db.exec("ROLLBACK");
		throw error;
	}
	return { id, projectId: store.projectId, ...input, content: input.content.trim(), paths: input.paths ?? [], createdAt, status: "current" };
}

export function searchProjectMemory(store: ProjectMemoryStore, query: string, limit = 8): ProjectMemoryRecord[] {
	const terms = query.match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 12) ?? [];
	if (terms.length === 0) return [];
	const ftsQuery = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
	const rows = store.db.prepare(`
		SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.id
		WHERE memories_fts MATCH ? AND m.project_id = ? AND m.status = 'current'
		ORDER BY bm25(memories_fts), m.created_at DESC LIMIT ?
	`).all(ftsQuery, store.projectId, Math.max(1, Math.min(limit, 20))) as Record<string, unknown>[];
	return rows.map(rowToRecord);
}

export function getRecentProjectMemory(store: ProjectMemoryStore, limit = 8): ProjectMemoryRecord[] {
	const rows = store.db.prepare("SELECT * FROM memories WHERE project_id = ? AND status = 'current' ORDER BY created_at DESC LIMIT ?")
		.all(store.projectId, Math.max(1, Math.min(limit, 20))) as Record<string, unknown>[];
	return rows.map(rowToRecord);
}

export function exportProjectKnowledge(store: ProjectMemoryStore, ids: string[], path: string, rejectContent: (content: string) => boolean = () => false): number {
	const selected = ids.slice(0, 100).flatMap((id) => {
		const row = store.db.prepare("SELECT * FROM memories WHERE id = ? AND project_id = ? AND status = 'current'").get(id, store.projectId) as Record<string, unknown> | undefined;
		if (!row) return [];
		const record = rowToRecord(row);
		return rejectContent(record.content) ? [] : [record];
	});
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, selected.map((record) => JSON.stringify(record)).join("\n") + (selected.length ? "\n" : ""), { mode: 0o600 });
	renameSync(temporary, path);
	return selected.length;
}

export function importProjectKnowledge(store: ProjectMemoryStore, path: string, rejectContent: (content: string) => boolean = () => false): number {
	let text: string;
	try {
		if (statSync(path).size > 1_000_000) return 0;
		text = readFileSync(path, "utf8");
	} catch { return 0; }
	let imported = 0;
	for (const line of text.split("\n").filter(Boolean).slice(0, 1000)) {
		try {
			const parsed = JSON.parse(line) as Partial<ProjectMemoryRecord>;
			if (!parsed.id || typeof parsed.id !== "string" || parsed.id.length > 200 || /[\0\r\n]/.test(parsed.id) || typeof parsed.content !== "string" || rejectContent(parsed.content) || !KINDS.has(parsed.kind as ProjectMemoryKind)) continue;
			const exists = store.db.prepare("SELECT 1 FROM memories WHERE id = ? AND project_id = ?").get(parsed.id, store.projectId);
			if (exists) continue;
			const superseded = typeof parsed.supersedes === "string"
				? store.db.prepare("SELECT source FROM memories WHERE id = ? AND project_id = ?").get(parsed.supersedes, store.projectId) as { source?: string } | undefined
				: undefined;
			const supersedes = superseded?.source === "portable" ? parsed.supersedes : undefined;
			recordProjectMemory(store, { kind: parsed.kind as ProjectMemoryKind, content: parsed.content, source: "portable", paths: Array.isArray(parsed.paths) ? parsed.paths : [], commit: parsed.commit, supersedes }, parsed.id);
			imported++;
		} catch {}
	}
	return imported;
}
