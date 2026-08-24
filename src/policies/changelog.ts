import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getWorkspaceRoot } from "../lib/state.ts";
import { splitShellSegments, unwrapShellCommand } from "../lib/utils.ts";

export const CHANGELOG_SECTION_RE = /^\s*(?:#{1,6}\s*)?changelog\s*(?::|$)/im;

export function hasPrCreateInvocation(command: string): boolean {
	return splitShellSegments(command)
		.some((seg) => {
			const trimmed = unwrapShellCommand(seg);
			return (
				/^gh\b[^|;&]*\bpr\s+create\b/.test(trimmed) ||
				/^az\b[^|;&]*\brepos\s+pr\s+create\b/.test(trimmed)
			);
		});
}

// Accepts either a CHANGELOG file modification or a .changeset/*.md file.
const CHANGELOG_OR_CHANGESET_RE = /(?:changelog|\.changeset\/[^/]+\.md$)/i;

export function branchHasChangelogChange(root: string): boolean {
	try {
		const baseCandidates = ["origin/HEAD", "origin/main", "origin/master"];
		for (const base of baseCandidates) {
			const mergeBase = spawnSync(
				"git",
				["merge-base", "HEAD", base],
				{ cwd: root, encoding: "utf8", timeout: 10_000 },
			);
			if (mergeBase.status !== 0 || !mergeBase.stdout.trim()) continue;
			const diff = spawnSync(
				"git",
				["diff", "--name-only", `${mergeBase.stdout.trim()}...HEAD`],
				{ cwd: root, encoding: "utf8", timeout: 10_000 },
			);
			if (diff.status !== 0) continue;
			if (diff.stdout.split("\n").some((f) => CHANGELOG_OR_CHANGESET_RE.test(f))) {
				return true;
			}
		}
		const last = spawnSync("git", ["diff", "--name-only", "HEAD~1"], {
			cwd: root,
			encoding: "utf8",
			timeout: 10_000,
		});
		return (
			last.status === 0 &&
			last.stdout.split("\n").some((f) => CHANGELOG_OR_CHANGESET_RE.test(f))
		);
	} catch {
		return false;
	}
}

export function prBodyIncludesChangelog(command: string): boolean {
	const bodyMatch = command.match(
		/(?:--body|--description|-d|-b)(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s|;&]+))/,
	);
	const body = bodyMatch?.[1] ?? bodyMatch?.[2] ?? bodyMatch?.[3] ?? "";
	if (CHANGELOG_SECTION_RE.test(body)) {
		return true;
	}
	const bodyFileMatch = command.match(
		/(?:--body-file|--description-file|-F)(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s|;&]+))/,
	);
	const bodyFile =
		bodyFileMatch?.[1] ?? bodyFileMatch?.[2] ?? bodyFileMatch?.[3];
	if (bodyFile) {
		try {
			return CHANGELOG_SECTION_RE.test(
				readFileSync(resolve(getWorkspaceRoot(), bodyFile), "utf8"),
			);
		} catch {
			return false;
		}
	}
	return false;
}

export function checkLockfileSync(root: string): { isOutOfSync: boolean; manifest?: string; lockfile?: string; reason?: string } {
	try {
		let modifiedFiles: string[] = [];
		const baseCandidates = ["origin/HEAD", "origin/main", "origin/master", "main", "master"];
		for (const base of baseCandidates) {
			const mergeBase = spawnSync("git", ["merge-base", "HEAD", base], { cwd: root, encoding: "utf8", timeout: 10_000 });
			if (mergeBase.status !== 0 || !mergeBase.stdout.trim()) continue;
			const diff = spawnSync("git", ["diff", "--name-only", `${mergeBase.stdout.trim()}...HEAD`], { cwd: root, encoding: "utf8", timeout: 10_000 });
			if (diff.status === 0 && diff.stdout.trim()) {
				modifiedFiles = diff.stdout.split("\n").map((f) => f.trim()).filter(Boolean);
				break;
			}
		}
		const headDiff = spawnSync("git", ["diff", "--name-only", "HEAD"], { cwd: root, encoding: "utf8", timeout: 10_000 });
		if (headDiff.status === 0 && headDiff.stdout.trim()) {
			const uncommitted = headDiff.stdout.split("\n").map((f) => f.trim()).filter(Boolean);
			modifiedFiles = Array.from(new Set([...modifiedFiles, ...uncommitted]));
		}
		const untracked = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8", timeout: 10_000 });
		if (untracked.status === 0 && untracked.stdout.trim()) {
			const files = untracked.stdout.split("\n").map((l) => l.slice(3).trim()).filter(Boolean);
			modifiedFiles = Array.from(new Set([...modifiedFiles, ...files]));
		}

		const manifestToLockfiles: Array<{ manifest: RegExp; lockfiles: RegExp; name: string }> = [
			{
				manifest: /(?:^|\/)package\.json$/,
				lockfiles: /(?:^|\/)(?:package-lock\.json|bun\.lock|bun\.lockb|pnpm-lock\.yaml|yarn\.lock)$/,
				name: "package.json",
			},
			{
				manifest: /(?:^|\/)Cargo\.toml$/,
				lockfiles: /(?:^|\/)Cargo\.lock$/,
				name: "Cargo.toml",
			},
			{
				manifest: /(?:^|\/)go\.mod$/,
				lockfiles: /(?:^|\/)go\.sum$/,
				name: "go.mod",
			},
		];

		for (const item of manifestToLockfiles) {
			const hasManifest = modifiedFiles.some((f) => item.manifest.test(f));
			if (hasManifest) {
				const hasLockfile = modifiedFiles.some((f) => item.lockfiles.test(f));
				if (!hasLockfile) {
					return {
						isOutOfSync: true,
						manifest: item.name,
						reason: `Package manifest '${item.name}' was modified without updating its corresponding lockfile. Run the package manager install/lock command before opening a PR.`,
					};
				}
			}
		}
	} catch {}
	return { isOutOfSync: false };
}
