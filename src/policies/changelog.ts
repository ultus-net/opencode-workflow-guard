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
