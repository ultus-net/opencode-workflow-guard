type RunResult = { changes: number | bigint };
type Statement = {
	run(...params: unknown[]): RunResult;
	all(...params: unknown[]): unknown[];
	get(...params: unknown[]): unknown;
};

export interface SqliteDatabase {
	exec(sql: string): unknown;
	prepare(sql: string): Statement;
	close(): void;
}

type DatabaseConstructor = new (path: string) => SqliteDatabase;
const sqliteModuleName = "Bun" in globalThis ? "bun:sqlite" : "node:sqlite";
const sqliteModule = await import(sqliteModuleName) as { Database?: DatabaseConstructor; DatabaseSync?: DatabaseConstructor };

const DatabaseImpl = sqliteModule.Database ?? sqliteModule.DatabaseSync;
if (!DatabaseImpl) throw new Error(`SQLite database implementation unavailable from ${sqliteModuleName}`);
export const Database: DatabaseConstructor = DatabaseImpl;
