import { spawnSync } from "node:child_process";
import { isDocumentationRequired } from "../lib/state.ts";

export { isDocumentationRequired };

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
			if (
				files.some(
					(f) =>
						/\.md$/i.test(f) ||
						f.startsWith("docs/") ||
						f.toLowerCase() === "readme.md",
				)
			) {
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
			return files.some(
				(f) =>
					/\.md$/i.test(f) ||
					f.startsWith("docs/") ||
					f.toLowerCase() === "readme.md",
			);
		}
		return false;
	} catch {
		return false;
	}
}
