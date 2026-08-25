import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

const PRIMARY_TODO_NAMES = ["TODO.md", "todo.md"];
const FALLBACK_NAMES = [
	"ROADMAP.md", "roadmap.md",
	"PLAN.md", "plan.md",
	"TASKS.md", "tasks.md",
	"BACKLOG.md", "backlog.md",
];

export interface PlanningSource {
	path: string;
	content: string;
}

export function discoverPlanningSources(root: string): PlanningSource[] {
	let realRoot: string;
	try {
		realRoot = realpathSync(root);
	} catch {
		return [];
	}
	const isConfined = (path: string): boolean => {
		const rel = relative(realRoot, realpathSync(path));
		return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
	};
	const readSources = (paths: string[]): PlanningSource[] => paths.flatMap((path) => {
		try {
			// Planning discovery is read-only and must not become a symlink escape hatch.
			if (!lstatSync(path).isFile() || !isConfined(path)) return [];
			return [{ path: relative(root, path), content: readFileSync(path, "utf8").slice(0, 20_000) }];
		} catch {
			return [];
		}
	});

	const primary = readSources(PRIMARY_TODO_NAMES.map((name) => join(root, name)));
	if (primary.length > 0) return primary;

	const candidates = FALLBACK_NAMES.flatMap((name) => [join(root, name), join(root, "docs", name)]);
	const plansDir = join(root, "docs", "plans");
	try {
		if (!lstatSync(plansDir).isDirectory() || !isConfined(plansDir)) return readSources(candidates);
		for (const entry of readdirSync(plansDir, { withFileTypes: true })) {
			if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) candidates.push(join(plansDir, entry.name));
		}
	} catch {}
	return readSources(candidates);
}
