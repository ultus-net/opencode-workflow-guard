import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { getWorkspaceRoot } from "./state.ts";
import { isProtectedBranchName } from "../policies/git.ts";

export function getWorktreeStorageDir(root = getWorkspaceRoot()): string {
	const base =
		process.env.WORKFLOW_GUARD_WORKTREE_DIR ??
		join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode", "worktrees");
	return join(base, basename(root));
}

/**
 * Returns a copy of process.env with git context variables removed so spawned
 * git commands resolve the repository from their cwd alone. Without this, a
 * caller nested inside a git hook (which exports GIT_INDEX_FILE and friends)
 * would make `git worktree add` fail: the internal checkout of the new
 * worktree resolves the inherited relative GIT_INDEX_FILE against the new
 * worktree root, where `.git` is a file, not a directory.
 */
export function getCleanGitEnv(): Record<string, string> {
	const env: Record<string, string> = { ...(process.env as Record<string, string>) };
	for (const key of [
		"GIT_INDEX_FILE",
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_COMMON_DIR",
		"GIT_OBJECT_DIRECTORY",
		"GIT_ALTERNATE_OBJECT_DIRECTORIES",
		"GIT_PREFIX",
	]) {
		delete env[key];
	}
	return env;
}

/**
 * Validates a branch name using git itself (`git check-ref-format --branch`),
 * with fast local pre-filters for names that must never be passed as arguments
 * at all (a leading dash would be parsed as an option).
 */
export function isValidBranchName(name: string): boolean {
	if (!name || name.length > 255) return false;
	if (name.startsWith("-") || name.startsWith(".") || name.endsWith(".") || name.endsWith(".lock")) return false;
	if (name.includes("..") || name.includes("@{") || name.includes("//")) return false;
	const res = spawnSync("git", ["check-ref-format", "--branch", name], {
		encoding: "utf8",
		timeout: 5_000,
		env: getCleanGitEnv(),
	});
	return res.status === 0;
}

function localBranchExists(branch: string, root: string): boolean {
	const res = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
		cwd: root,
		encoding: "utf8",
		timeout: 5_000,
		env: getCleanGitEnv(),
	});
	return res.status === 0;
}

export function createGitWorktree(
	branch: string,
	baseBranch = "HEAD",
	root = getWorkspaceRoot(),
): { success: boolean; worktreePath?: string; error?: string } {
	if (!branch || !isValidBranchName(branch)) {
		return { success: false, error: `Invalid branch name '${branch}' for worktree creation.` };
	}
	if (isProtectedBranchName(branch, root)) {
		return { success: false, error: `Cannot create worktree on protected branch '${branch}'.` };
	}

	const storageBase = getWorktreeStorageDir(root);
	const targetPath = join(storageBase, branch.replace(/[/\\:]/g, "-"));

	try {
		mkdirSync(storageBase, { recursive: true });

		const exists = localBranchExists(branch, root);
		const gitArgs = exists
			? ["worktree", "add", targetPath, branch]
			: ["worktree", "add", "-b", branch, targetPath, baseBranch];

		const addRes = spawnSync("git", gitArgs, {
			cwd: root,
			env: getCleanGitEnv(),
			encoding: "utf8",
			timeout: 15_000,
		});
		if (addRes.status !== 0) {
			return { success: false, error: addRes.stderr.trim() || `git worktree add failed` };
		}

		// Symlink the parent's node_modules so tooling works without a fresh install.
		const nodeModulesSrc = join(root, "node_modules");
		const nodeModulesDest = join(targetPath, "node_modules");
		if (existsSync(nodeModulesSrc) && !existsSync(nodeModulesDest)) {
			try {
				symlinkSync(nodeModulesSrc, nodeModulesDest, "dir");
			} catch {}
		}

		return { success: true, worktreePath: targetPath };
	} catch (e: any) {
		return { success: false, error: e?.message ?? String(e) };
	}
}

function registeredWorktreePaths(root: string): string[] | undefined {
	const res = spawnSync("git", ["worktree", "list", "--porcelain"], {
		cwd: root,
		encoding: "utf8",
		timeout: 10_000,
		env: getCleanGitEnv(),
	});
	if (res.status !== 0) return undefined;
	return res.stdout
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length))
		.filter((path) => path.length > 0);
}

export function cleanupGitWorktree(
	worktreePath: string,
	root = getWorkspaceRoot(),
): { success: boolean; error?: string } {
	try {
		if (!existsSync(worktreePath)) {
			return { success: false, error: `Worktree path '${worktreePath}' does not exist.` };
		}

		// Ownership validation: the path must live under the configured worktree
		// storage directory AND be a registered worktree of this repository. This
		// refuses arbitrary directories, other repos' worktrees, and the primary
		// working tree - cleanup must never be an unrestricted delete primitive.
		const resolved = resolve(worktreePath);
		const storageBase = resolve(getWorktreeStorageDir(root));
		if (resolved !== storageBase && !resolved.startsWith(storageBase + sep)) {
			return {
				success: false,
				error: `Refusing to clean up '${worktreePath}': path is outside the worktree storage directory (${storageBase}).`,
			};
		}
		const registered = registeredWorktreePaths(root);
		if (!registered) {
			return { success: false, error: "Failed to list registered worktrees - aborting cleanup." };
		}
		const resolvedRegistered = registered.map((path) => resolve(path));
		if (!resolvedRegistered.includes(resolved)) {
			return {
				success: false,
				error: `Refusing to clean up '${worktreePath}': not a registered worktree of this repository.`,
			};
		}
		if (resolvedRegistered[0] === resolved) {
			return { success: false, error: "Refusing to remove the primary working tree." };
		}

		// Snapshot: stage and commit remaining changes. If the snapshot cannot be
		// established (hook failure, missing identity, lock error, timeout), abort -
		// never destroy uncommitted work.
		const addArgs = ["add", "-A", "--", "."];
		try {
			// Exclude the plugin-created node_modules symlink so repos that do not
			// ignore it never commit a machine-local link.
			if (lstatSync(join(resolved, "node_modules")).isSymbolicLink()) {
				addArgs.push(":(exclude)node_modules");
			}
		} catch {}
		const addRes = spawnSync("git", addArgs, {
			cwd: worktreePath,
			env: getCleanGitEnv(),
			encoding: "utf8",
			timeout: 5_000,
		});
		if (addRes.status !== 0) {
			return {
				success: false,
				error: `Snapshot failed (git add: ${(addRes.stderr ?? "").trim()}) - worktree left intact.`,
			};
		}
		const commitRes = spawnSync(
			"git",
			["commit", "-m", "chore(worktree): auto-snapshot before cleanup", "--allow-empty"],
			{ cwd: worktreePath, env: getCleanGitEnv(), encoding: "utf8", timeout: 5_000 },
		);
		if (commitRes.status !== 0) {
			return {
				success: false,
				error: `Snapshot failed (git commit: ${(commitRes.stderr ?? "").trim().split("\n").pop()?.trim() ?? "unknown error"}) - worktree left intact.`,
			};
		}

		const res = spawnSync("git", ["worktree", "remove", "--force", worktreePath], {
			cwd: root,
			env: getCleanGitEnv(),
			encoding: "utf8",
			timeout: 10_000,
		});
		if (res.status !== 0) {
			// A failed git removal is an error - never authorization for a raw
			// recursive delete of the directory.
			return { success: false, error: res.stderr.trim() || "git worktree remove failed." };
		}

		return { success: true };
	} catch (e: any) {
		return { success: false, error: e?.message ?? String(e) };
	}
}
