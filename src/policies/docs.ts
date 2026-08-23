import { spawnSync } from "node:child_process";
import { isDocumentationRequired } from "../lib/state.ts";

export { isDocumentationRequired };

/**
 * True for user-facing documentation files: README.md (root or package
 * level) and anything under a docs/ directory. Deliberately excludes
 * arbitrary markdown (e.g. .changeset/*.md, CHANGELOG.md) so the
 * documentation gate cannot be satisfied by a changeset fragment.
 */
function isDocumentationFile(filePath: string): boolean {
	const lower = filePath.toLowerCase();
	if (lower === "readme.md" || lower.endsWith("/readme.md")) return true;
	if (lower === "docs" || lower.startsWith("docs/") || lower.includes("/docs/")) return true;
	return false;
}

export function branchHasDocumentationChange(root: string): boolean {
	try {
		const baseCandidates = ["origin/HEAD", "origin/main", "origin/master", "main", "master"];
		for (const base of baseCandidates) {
			const mergeBase = spawnSync("git", ["merge-base", "HEAD", base], {
				cwd: root,
				encoding: "utf8",
				timeout: 5_000,
			});
			if (mergeBase.status !== 0 || !mergeBase.stdout.trim()) continue;
			const diff = spawnSync(
				"git",
				["diff", "--name-only", `${mergeBase.stdout.trim()}...HEAD`],
				{ cwd: root, encoding: "utf8", timeout: 8_000 },
			);
			if (diff.status !== 0) continue;
			const files = diff.stdout.split("\n").filter(Boolean);
			if (files.some((f) => isDocumentationFile(f))) {
				return true;
			}
		}
		const last = spawnSync("git", ["diff", "--name-only", "HEAD~1"], {
			cwd: root,
			encoding: "utf8",
			timeout: 5_000,
		});
		if (last.status === 0) {
			const files = last.stdout.split("\n").filter(Boolean);
			return files.some((f) => isDocumentationFile(f));
		}
		return false;
	} catch {
		return false;
	}
}
