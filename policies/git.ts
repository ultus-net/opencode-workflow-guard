import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { GitInvocation } from "../lib/types.ts";
import {
	getWorkspaceRoot,
	getProjectConfig,
} from "../lib/state.ts";
import {
	unwrapShellWords,
	splitShellSegments,
} from "../lib/utils.ts";

export const PROTECTED_BRANCHES = new Set(["main", "master"]);

export const PUSH_TO_MAIN_RE =
	/\bgit\s+push\b[^|;&]*(?:^|\s)\+?[\w./-]*:(?:main|master)(?![\w./-])|\bgit\s+push\b[^|;&]*(?:\s|\/)(?:main|master)(?![\w./-])/;

export const GIT_BRANCH_CREATE_RE =
	/\bgit\s+(?:checkout\s+-b|switch\s+(?:-c|--create))\b/;

const GIT_DIR_OPTION_TAKES_VALUE = new Set([
	"-C",
	"--git-dir",
	"--work-tree",
	"-c",
	"--config-env",
	"--namespace",
]);
const GIT_DIR_OPTION_PREFIXED =
	/^(--git-dir=|--work-tree=|--namespace=|-c\S|--config-env=)/;
const GIT_GLOBAL_BOOLEAN_OPTIONS = new Set([
	"--version",
	"--help",
	"--no-pager",
	"-p",
	"--paginate",
	"--bare",
	"--literal-pathspecs",
	"--glob-pathspecs",
	"--noglob-pathspecs",
	"--icase-pathspecs",
	"--no-optional-locks",
	"--exec-path",
]);

export function parseGitInvocation(command: string): GitInvocation | undefined {
	const root = getWorkspaceRoot();
	const tokens = unwrapShellWords(command);
	if (tokens[0] !== "git") return undefined;
	let i = 1;
	let repoDir = root;
	let sawDirOption = false;
	while (i < tokens.length) {
		const tok = tokens[i]!;
		if (GIT_DIR_OPTION_TAKES_VALUE.has(tok)) {
			const value = tokens[i + 1];
			if (value === undefined) return { repoDir, rest: "" };
			if (tok === "-C" || tok === "--git-dir") {
				repoDir = resolve(root, value);
				sawDirOption = true;
			}
			i += 2;
			continue;
		}
		if (GIT_DIR_OPTION_PREFIXED.test(tok)) {
			if (tok.startsWith("--git-dir=")) {
				repoDir = resolve(root, tok.slice("--git-dir=".length));
				sawDirOption = true;
			}
			i += 1;
			continue;
		}
		if (GIT_GLOBAL_BOOLEAN_OPTIONS.has(tok)) {
			i += 1;
			continue;
		}
		break;
	}
	if (!sawDirOption) repoDir = root;
	return { repoDir, rest: tokens.slice(i).join(" ") };
}

export function normalizeGitCommands(command: string): string {
	return splitShellSegments(command)
		.map((segment) => {
			const parsed = parseGitInvocation(segment);
			return parsed ? `git ${parsed.rest}` : segment;
		})
		.join(" ; ");
}

export const GIT_WRITE_RE =
	/\bgit\s+(commit|merge|rebase|cherry-pick|revert|stash\s+pop|apply|am|restore|reset|update-ref|filter-branch)\b|\bgit\s+branch\s+(?:[^|;&]*\s)?-[dDM]\b/;

export function currentGitBranch(root: string): string | undefined {
	const result = spawnSync("git", ["branch", "--show-current"], {
		cwd: root,
		encoding: "utf8",
		timeout: 10_000,
	});
	if (result.status === 0 && result.stdout.trim()) {
		return result.stdout.trim();
	}
	try {
		const head = readFileSync(resolve(root, ".git", "HEAD"), "utf8").trim();
		const match = head.match(/^ref:\s+refs\/heads\/(\S+)/);
		if (match) return match[1];
	} catch {}
	if (result.status === 0) return "";
	return undefined;
}

export function onProtectedBranch(root: string): boolean {
	const branch = currentGitBranch(root);
	if (!branch) return false;
	const cfg = getProjectConfig(root);
	const customBranches = Array.isArray(cfg.protectedBranches)
		? cfg.protectedBranches
		: [];
	const allProtected = new Set([...PROTECTED_BRANCHES, ...customBranches]);
	return allProtected.has(branch);
}

export function branchGuardReason(): string {
	return (
		"Blocked: the workspace is on a protected branch. " +
		"Create a feature branch first - e.g. " +
		"`git switch -c feat/description` - and make all changes there, " +
		"then open a PR. Direct changes on protected branches are not allowed."
	);
}

export function isBranchAlreadyMergedOrClosed(
	root: string,
	branch: string,
): { merged: boolean; reason?: string } {
	if (!branch || PROTECTED_BRANCHES.has(branch)) {
		return { merged: false };
	}

	for (const base of ["origin/HEAD", "origin/main", "origin/master", "main", "master"]) {
		const check = spawnSync("git", ["merge-base", "--is-ancestor", branch, base], {
			cwd: root,
			encoding: "utf8",
			timeout: 5_000,
		});
		if (check.status === 0) {
			const unmerged = spawnSync("git", ["rev-list", `${base}..${branch}`, "--count"], {
				cwd: root,
				encoding: "utf8",
				timeout: 5_000,
			});
			if (unmerged.status === 0 && unmerged.stdout.trim() === "0") {
				return {
					merged: true,
					reason: `Branch '${branch}' is already merged into '${base}'. Create a fresh feature branch for new changes.`,
				};
			}
		}
	}

	try {
		const ghRes = spawnSync(
			"gh",
			["pr", "list", "--head", branch, "--state", "all", "--json", "number,state,title", "--limit", "1"],
			{ cwd: root, encoding: "utf8", timeout: 8_000 },
		);
		if (ghRes.status === 0 && ghRes.stdout.trim()) {
			const prs = JSON.parse(ghRes.stdout.trim());
			if (Array.isArray(prs) && prs.length > 0) {
				const pr = prs[0];
				if (pr && (pr.state === "MERGED" || pr.state === "CLOSED")) {
					return {
						merged: true,
						reason: `Branch '${branch}' is associated with an already ${pr.state.toLowerCase()} GitHub PR (#${pr.number}: ${pr.title ?? ""}). Create a fresh feature branch for new changes.`,
					};
				}
			}
		}
	} catch {}

	try {
		const azRes = spawnSync(
			"az",
			["repos", "pr", "list", "--source-branch", branch, "--status", "all", "--query", "[0].{id:pullRequestId, status:status, title:title}", "-o", "json"],
			{ cwd: root, encoding: "utf8", timeout: 8_000 },
		);
		if (azRes.status === 0 && azRes.stdout.trim()) {
			const pr = JSON.parse(azRes.stdout.trim());
			if (pr && typeof pr === "object" && (pr.status === "completed" || pr.status === "abandoned")) {
				return {
					merged: true,
					reason: `Branch '${branch}' is associated with an already ${pr.status} Azure DevOps PR (#${pr.id}: ${pr.title ?? ""}). Create a fresh feature branch for new changes.`,
				};
			}
		}
	} catch {}

	return { merged: false };
}

export function checkMergeConflicts(root: string): {
	hasConflicts: boolean;
	baseBranch?: string;
	reason?: string;
} {
	const candidates = ["origin/HEAD", "origin/main", "origin/master", "main", "master"];
	for (const base of candidates) {
		const mergeBaseRes = spawnSync("git", ["merge-base", "HEAD", base], {
			cwd: root,
			encoding: "utf8",
			timeout: 5_000,
		});
		if (mergeBaseRes.status !== 0 || !mergeBaseRes.stdout.trim()) continue;
		const mergeBase = mergeBaseRes.stdout.trim();

		const treeRes = spawnSync("git", ["merge-tree", mergeBase, "HEAD", base], {
			cwd: root,
			encoding: "utf8",
			timeout: 10_000,
		});
		if (treeRes.status === 0 && treeRes.stdout.includes("<<<<<<<")) {
			return {
				hasConflicts: true,
				baseBranch: base,
				reason: `Branch has merge conflicts with base branch '${base}'. Rebase or merge '${base}' to resolve all conflicts before opening a PR or handing off.`,
			};
		}
	}
	return { hasConflicts: false };
}

export function checkBranchBaseIsUpToDate(root: string): {
	isBehind: boolean;
	count?: number;
	baseRef?: string;
	reason?: string;
} {
	for (const base of ["origin/HEAD", "origin/main", "origin/master"]) {
		const res = spawnSync("git", ["rev-list", `HEAD..${base}`, "--count"], {
			cwd: root,
			encoding: "utf8",
			timeout: 5_000,
		});
		if (res.status === 0 && res.stdout.trim()) {
			const count = parseInt(res.stdout.trim(), 10);
			if (!isNaN(count) && count > 0) {
				return {
					isBehind: true,
					count,
					baseRef: base,
					reason: `Local base branch is ${count} commit(s) behind remote (${base}). Run 'git pull' or 'git fetch' on main before creating a fresh feature branch to prevent upstream conflicts.`,
				};
			}
		}
	}
	return { isBehind: false };
}
