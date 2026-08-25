import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getGitWorktreeFingerprint } from "./verify.ts";
import { getCleanGitEnv } from "./worktree.ts";

export interface RecoveryCheckpoint {
	sessionID: string;
	run: number;
	ref: string;
	kind: "commit" | "stash";
	createdAt: number;
	endFingerprint?: string;
	endAt?: number;
}

interface CheckpointStore {
	workspace: string;
	checkpoints: RecoveryCheckpoint[];
}

const MAX_RECOVERY_CHECKPOINTS = 100;

const gitIdentityEnv = {
	GIT_AUTHOR_NAME: "OpenCode Workflow Guard",
	GIT_AUTHOR_EMAIL: "workflow-guard@localhost",
	GIT_COMMITTER_NAME: "OpenCode Workflow Guard",
	GIT_COMMITTER_EMAIL: "workflow-guard@localhost",
};

function git(workspace: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
	if (gitForTesting) return gitForTesting(workspace, args, env);
	return execFileSync("git", ["-C", workspace, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...getCleanGitEnv(), ...gitIdentityEnv, ...env },
	}).trim();
}

let gitForTesting: ((workspace: string, args: string[], env?: NodeJS.ProcessEnv) => string) | undefined;

export function setCheckpointGitForTesting(runner?: typeof gitForTesting): void {
	gitForTesting = runner;
}

function gitDir(workspace: string): string {
	const value = git(workspace, ["rev-parse", "--path-format=absolute", "--git-dir"]);
	return resolve(workspace, value);
}

function metadataPath(workspace: string): string {
	return join(gitDir(workspace), "workflow-guard", "recovery-checkpoints.json");
}

function loadStore(workspace: string): CheckpointStore {
	const path = metadataPath(workspace);
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as CheckpointStore;
		if (value.workspace === resolve(workspace) && Array.isArray(value.checkpoints)) return value;
	} catch {}
	return { workspace: resolve(workspace), checkpoints: [] };
}

function saveStore(workspace: string, store: CheckpointStore): void {
	const path = metadataPath(workspace);
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temp, JSON.stringify(store, null, 2));
	renameSync(temp, path);
}

function withStoreLock<T>(workspace: string, action: () => T): T {
	const path = metadataPath(workspace);
	mkdirSync(dirname(path), { recursive: true });
	const lockPath = `${path}.lock`;
	let lock: number;
	try {
		lock = openSync(lockPath, "wx", 0o600);
	} catch {
		throw new Error("Recovery checkpoint metadata is busy; refusing an unsafe concurrent update.");
	}
	try {
		writeFileSync(lock, String(process.pid));
		return action();
	} finally {
		closeSync(lock);
		try { unlinkSync(lockPath); } catch {}
	}
}

function updateStore<T>(workspace: string, update: (store: CheckpointStore) => T): T {
	return withStoreLock(workspace, () => {
		const store = loadStore(workspace);
		const result = update(store);
		saveStore(workspace, store);
		return result;
	});
}

function pruneCheckpoints(workspace: string, store: CheckpointStore): void {
	if (store.checkpoints.length <= MAX_RECOVERY_CHECKPOINTS) return;
	const sorted = [...store.checkpoints].sort((a, b) => a.createdAt - b.createdAt);
	const remove = sorted.slice(0, sorted.length - MAX_RECOVERY_CHECKPOINTS);
	const removed = new Set(remove.map((entry) => `${entry.sessionID}\0${entry.run}`));
	for (const entry of remove) {
		try { git(workspace, ["update-ref", "-d", privateRef(entry.sessionID, entry.run)]); } catch {}
	}
	store.checkpoints = store.checkpoints.filter((entry) => !removed.has(`${entry.sessionID}\0${entry.run}`));
}

function recoveryBoundaryFingerprint(workspace: string): string | undefined {
	const worktree = getGitWorktreeFingerprint(workspace);
	if (!worktree) return undefined;
	try {
		return createHash("sha256").update(git(workspace, ["rev-parse", "HEAD"])).update("\0").update(worktree).digest("hex");
	} catch {
		return undefined;
	}
}

function privateRef(sessionID: string, run: number): string {
	const session = createHash("sha256").update(sessionID).digest("hex");
	return `refs/workflow-guard/checkpoints/${session}/${run}`;
}

function commitTree(workspace: string, tree: string, parents: string[], message: string): string {
	const args = ["commit-tree", tree];
	for (const parent of parents) args.push("-p", parent);
	args.push("-m", message);
	return git(workspace, args);
}

function captureUntracked(workspace: string): string | undefined {
	const paths = execFileSync("git", ["-C", workspace, "ls-files", "--others", "--exclude-standard", "-z"], {
		encoding: "buffer",
		stdio: ["ignore", "pipe", "pipe"],
		env: getCleanGitEnv(),
	});
	if (paths.length === 0) return undefined;
	const temp = mkdtempSync(join(tmpdir(), "workflow-guard-checkpoint-"));
	try {
		const index = join(temp, "index");
		const pathspec = join(temp, "paths");
		writeFileSync(pathspec, paths);
		const env = { GIT_INDEX_FILE: index };
		git(workspace, ["add", "--force", `--pathspec-from-file=${pathspec}`, "--pathspec-file-nul"], env);
		const tree = git(workspace, ["write-tree"], env);
		return commitTree(workspace, tree, [], "untracked files on workflow-guard checkpoint");
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}

export function createRecoveryCheckpoint(workspace: string, sessionID: string, run: number): RecoveryCheckpoint | undefined {
	try {
		const root = resolve(workspace);
		return withStoreLock(root, () => {
			const store = loadStore(root);
			const existing = store.checkpoints.find((entry) => entry.sessionID === sessionID && entry.run === run);
			if (existing) return existing;
			const head = git(root, ["rev-parse", "HEAD"]);
			const message = `workflow-guard checkpoint session=${sessionID} run=${run}`;
			const tracked = git(root, ["stash", "create", message]);
			const untracked = captureUntracked(root);
			let ref = tracked || head;
			let kind: RecoveryCheckpoint["kind"] = tracked ? "stash" : "commit";
			if (untracked) {
				let tree: string;
				let base: string;
				let indexParent: string;
				if (tracked) {
					tree = git(root, ["rev-parse", `${tracked}^{tree}`]);
					base = git(root, ["rev-parse", `${tracked}^1`]);
					indexParent = git(root, ["rev-parse", `${tracked}^2`]);
				} else {
					base = head;
					tree = git(root, ["rev-parse", `${head}^{tree}`]);
					indexParent = commitTree(root, tree, [head], `index on ${message}`);
				}
				ref = commitTree(root, tree, [base, indexParent, untracked], message);
				kind = "stash";
			}
			git(root, ["update-ref", privateRef(sessionID, run), ref]);
			const checkpoint: RecoveryCheckpoint = { sessionID, run, ref, kind, createdAt: Date.now() };
			store.checkpoints.push(checkpoint);
			pruneCheckpoints(root, store);
			saveStore(root, store);
			return checkpoint;
		});
	} catch {
		return undefined;
	}
}

export function finalizeRecoveryCheckpoint(workspace: string, sessionID: string, run: number): boolean {
	try {
		const endFingerprint = recoveryBoundaryFingerprint(workspace);
		if (!endFingerprint) return false;
		return updateStore(workspace, (store) => {
			const checkpoint = store.checkpoints.find((entry) => entry.sessionID === sessionID && entry.run === run);
			if (!checkpoint) return false;
			checkpoint.endFingerprint = endFingerprint;
			checkpoint.endAt = Date.now();
			return true;
		});
	} catch {
		return false;
	}
}

export function listRecoveryCheckpoints(workspace: string, sessionID: string): RecoveryCheckpoint[] {
	try {
		return loadStore(workspace).checkpoints.filter((entry) => entry.sessionID === sessionID);
	} catch {
		return [];
	}
}

export function nextRecoveryRun(workspace: string, sessionID: string): number {
	const runs = listRecoveryCheckpoints(workspace, sessionID).map((entry) => entry.run);
	return runs.length ? Math.max(...runs) + 1 : 1;
}

export function restoreRecoveryCheckpoint(
	workspace: string,
	sessionID: string,
	run: number,
): { ok: boolean; error?: string } {
	const root = resolve(workspace);
	try {
		return withStoreLock(root, () => {
			let transactionRef: string | undefined;
			let originalHead: string | undefined;
			try {
				const store = loadStore(root);
				const checkpoint = store.checkpoints.find((entry) => entry.sessionID === sessionID && entry.run === run);
				if (!checkpoint) return { ok: false, error: `No recovery checkpoint exists for run ${run}.` };
				if (!checkpoint.endFingerprint) return { ok: false, error: `Run ${run} has not reached an idle recovery boundary.` };
				if (recoveryBoundaryFingerprint(root) !== checkpoint.endFingerprint) {
					return { ok: false, error: "Workspace changed after this run reached its recovery boundary; refusing to overwrite intervening work." };
				}
				if (!checkpoint.endAt || store.checkpoints.some((entry) => entry.sessionID !== sessionID && (!entry.endAt || entry.endAt >= checkpoint.createdAt))) {
					return { ok: false, error: "Another session ran at or after this checkpoint; refusing cross-session recovery." };
				}
				git(root, ["cat-file", "-e", `${checkpoint.ref}^{commit}`]);
				originalHead = git(root, ["rev-parse", "HEAD"]);
				const transaction = `refs/workflow-guard/restore-transactions/${randomUUID()}`;
				const beforeStash = (() => { try { return git(root, ["rev-parse", "refs/stash"]); } catch { return ""; } })();
				git(root, ["stash", "push", "--include-untracked", "--message", "workflow-guard restore transaction"]);
				const afterStash = (() => { try { return git(root, ["rev-parse", "refs/stash"]); } catch { return ""; } })();
				if (afterStash && afterStash !== beforeStash) {
					git(root, ["update-ref", transaction, afterStash]);
					transactionRef = transaction;
					git(root, ["stash", "drop", "stash@{0}"]);
				}
				git(root, ["clean", "-fd"]);
				if (checkpoint.kind === "stash") {
					const base = git(root, ["rev-parse", `${checkpoint.ref}^1`]);
					git(root, ["reset", "--hard", base]);
					git(root, ["stash", "apply", "--index", checkpoint.ref]);
				} else {
					git(root, ["reset", "--hard", checkpoint.ref]);
				}
				if (transactionRef) git(root, ["update-ref", "-d", transactionRef]);
				return { ok: true };
			} catch (error) {
				let rollbackError: unknown;
				if (originalHead) {
					try {
						git(root, ["reset", "--hard", originalHead]);
						if (transactionRef) {
							git(root, ["clean", "-fd"]);
							git(root, ["stash", "apply", "--index", transactionRef]);
							try {
								if (git(root, ["rev-parse", "refs/stash"]) === git(root, ["rev-parse", transactionRef])) {
									git(root, ["stash", "drop", "stash@{0}"]);
								}
							} catch {}
							git(root, ["update-ref", "-d", transactionRef]);
						}
					} catch (error) {
						rollbackError = error;
					}
				}
				const primary = error instanceof Error ? error.message : String(error);
				const rollback = rollbackError instanceof Error ? rollbackError.message : rollbackError === undefined ? undefined : String(rollbackError);
				return { ok: false, error: rollback ? `${primary} Recovery rollback also failed: ${rollback}` : primary };
			}
		});
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
