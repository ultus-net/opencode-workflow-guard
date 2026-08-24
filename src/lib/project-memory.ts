import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import type { ProjectMemoryInput, ProjectMemoryKind, ProjectMemoryRecord, ProjectMemorySource } from "./types.ts";

const KINDS = new Set<ProjectMemoryKind>(["fact", "decision", "constraint", "lesson"]);
const SOURCES = new Set<ProjectMemorySource>(["user", "file", "git", "tool", "agent", "portable"]);

export interface ProjectMemoryStore {
	db: DatabaseSync;
	projectId: string;
	close(): void;
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
	const result = spawnSync("git", ["-C", root, "diff", "--quiet", memory.commit, "--", ...memory.paths], { encoding: "utf8" });
	if (result.status !== 0) return false;
	const untracked = spawnSync("git", ["-C", root, "ls-files", "--others", "--exclude-standard", "--", ...memory.paths], { encoding: "utf8" });
	return untracked.status === 0 && !untracked.stdout.trim();
}

export function openProjectMemory(projectId: string, directory = getProjectMemoryDir()): ProjectMemoryStore {
	if (!projectId || projectId.length > 200) throw new Error("Invalid project memory identity.");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const db = new DatabaseSync(join(directory, `${projectId.replace(/[^a-zA-Z0-9._-]/g, "_")}.sqlite`));
	db.exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA busy_timeout = 2000;
		CREATE TABLE IF NOT EXISTS memories (
			id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL,
			source TEXT NOT NULL, created_at INTEGER NOT NULL, session_id TEXT, commit_sha TEXT,
			paths TEXT NOT NULL, supersedes TEXT, status TEXT NOT NULL DEFAULT 'current'
		);
		CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, content);
	`);
	return { db, projectId, close: () => db.close() };
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
		if (input.supersedes) store.db.prepare("UPDATE memories SET status = 'superseded' WHERE id = ? AND project_id = ?").run(input.supersedes, store.projectId);
		store.db.prepare("INSERT INTO memories VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'current')").run(
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
			recordProjectMemory(store, { kind: parsed.kind as ProjectMemoryKind, content: parsed.content, source: "portable", paths: Array.isArray(parsed.paths) ? parsed.paths : [], commit: parsed.commit, supersedes: parsed.supersedes }, parsed.id);
			imported++;
		} catch {}
	}
	return imported;
}
