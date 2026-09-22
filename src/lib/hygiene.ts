import { spawnSync } from "node:child_process";
import { checkBranchBaseIsUpToDate, currentGitBranch } from "../policies/git.ts";
import { getCleanGitEnv } from "./worktree.ts";

const MERGED_BASES = ["origin/main", "origin/master", "main", "master"];
const MAX_LISTED_BRANCHES = 10;

export interface GitHygieneSnapshot {
	/** Local branches fully merged into the mainline, capped for bounded output. */
	mergedLocalBranches: string[];
	/** True count of merged local branches (the list above may be capped). */
	mergedLocalBranchCount: number;
	/** Worktree admin entries whose directory is missing (clearable via cleanupGitWorktree or git worktree prune). */
	prunableWorktreeCount: number;
	/** Commits the current branch's base line is ahead by, when a remote base exists. */
	baseBehind?: number;
	baseRef?: string;
}

function gitOut(args: string[], root: string): string | undefined {
	const res = spawnSync("git", args, {
		cwd: root,
		encoding: "utf8",
		timeout: 10_000,
		env: getCleanGitEnv(),
	});
	if (res.status !== 0) return undefined;
	return res.stdout;
}

/**
 * Read-only accumulation snapshot for guard_status: local branches already
 * merged into the mainline, prunable worktree admin entries, and how far the
 * current branch's base line is ahead. Hygiene itself stays manual — the
 * guard reports, it never prunes or deletes branches on its own.
 */
export function gitHygieneSnapshot(root: string): GitHygieneSnapshot | undefined {
	const current = currentGitBranch(root);
	if (current === undefined) {
		// Not a git repository (or git unavailable): no hygiene snapshot.
		return undefined;
	}
	const snapshot: GitHygieneSnapshot = { mergedLocalBranches: [], mergedLocalBranchCount: 0, prunableWorktreeCount: 0 };
	for (const base of MERGED_BASES) {
		const out = gitOut(["branch", "--merged", base, "--format=%(refname:short)"], root);
		if (out === undefined) continue;
		const branches = out
			.split("\n")
			.map((line) => line.trim())
			.filter((name) => name.length > 0 && name !== base && name !== current)
			.sort();
		snapshot.mergedLocalBranchCount = branches.length;
		snapshot.mergedLocalBranches = branches.slice(0, MAX_LISTED_BRANCHES);
		break;
	}
	const worktreeOut = gitOut(["worktree", "list", "--porcelain"], root);
	if (worktreeOut !== undefined) {
		snapshot.prunableWorktreeCount = worktreeOut.split("\n").filter((line) => line.startsWith("prunable")).length;
	}
	const behind = checkBranchBaseIsUpToDate(root);
	if (behind.isBehind) {
		snapshot.baseBehind = behind.count;
		snapshot.baseRef = behind.baseRef;
	}
	return snapshot;
}
