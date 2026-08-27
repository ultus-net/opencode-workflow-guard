import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
import type { JSX } from "@opentui/solid";
import { createElement, insert, setProp } from "@opentui/solid";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { projectConfigPath } from "./lib/project-config.ts";
import { canonicalPath } from "./policies/file-claims.ts";

type Child = JSX.Element | string | number | null | undefined | false;

function element(
	tag: string,
	props: Record<string, unknown>,
	children: Child[] = [],
) {
	const node = createElement(tag);
	for (const [key, value] of Object.entries(props)) {
		if (value !== undefined) setProp(node, key, value);
	}
	for (const child of children) {
		if (child === null || child === undefined || child === false) continue;
		insert(node, child);
	}
	return node as unknown as JSX.Element;
}

function text(props: Record<string, unknown>, children: Child[]) {
	return element("text", props, children);
}

const BADGE_ACTIVE = "Workflow Guard 🛡️";

type ProjectToggle = "recoveryCheckpoints" | "projectMemory" | "learning" | "titleSettleWorkaround";

export function readProjectOption(root: string, option: ProjectToggle): boolean {
	const path = projectConfigPath(root);
	if (!existsSync(path)) return option === "projectMemory";
	const errors: ParseError[] = [];
	const config = parse(readFileSync(path, "utf8"), errors, { allowTrailingComma: true });
	if (errors.length > 0) throw new Error(`Invalid Workflow Guard project config: ${path}`);
	return option === "projectMemory" ? config?.projectMemory !== false : config?.[option] === true;
}

function writeProjectOption(root: string, option: ProjectToggle, enabled: boolean): string {
	const path = projectConfigPath(root);
	const raw = existsSync(path) ? readFileSync(path, "utf8") : "{}\n";
	const errors: ParseError[] = [];
	parse(raw, errors, { allowTrailingComma: true });
	if (errors.length > 0) throw new Error(`Invalid Workflow Guard project config: ${path}`);
	const realRoot = canonicalPath(root);
	const realPath = canonicalPath(path);
	const rel = relative(realRoot, realPath);
	if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
		throw new Error(`Refusing to write Workflow Guard config outside project: ${path}`);
	}
	const next = applyEdits(raw, modify(raw, [option], enabled, {
		formattingOptions: { insertSpaces: true, tabSize: 2 },
	}));
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, next.endsWith("\n") ? next : next + "\n");
	return path;
}

export function readRecoveryCheckpointsOption(root: string): boolean {
	return readProjectOption(root, "recoveryCheckpoints");
}

export function writeRecoveryCheckpointsOption(root: string, enabled: boolean): string {
	return writeProjectOption(root, "recoveryCheckpoints", enabled);
}

export function formatBadge(): { text: string; isBlocked: boolean } {
	return { text: BADGE_ACTIVE, isBlocked: false };
}

export const WorkflowGuardTui: TuiPlugin = async (api) => {
	api.keymap.registerLayer({
		commands: [{
			name: "workflow-guard.project-options",
			title: "Workflow Guard: Project Options",
			category: "Workflow Guard",
			namespace: "palette",
			slashName: "guard-options",
			run() {
				const root = api.state.path.worktree || api.state.path.directory;
				const recovery = readProjectOption(root, "recoveryCheckpoints");
				const memory = readProjectOption(root, "projectMemory");
				const learning = readProjectOption(root, "learning");
				const titleSettle = readProjectOption(root, "titleSettleWorkaround");
				api.ui.dialog.replace(() => api.ui.DialogSelect({
					title: "Workflow Guard Project Options",
					current: undefined,
					options: [
						{ title: `Recovery checkpoints: ${recovery ? "On" : "Off"}`, value: "recoveryCheckpoints", description: "Toggle durable pre-run Git checkpoints" },
						{ title: `Project memory: ${memory ? "On" : "Off"}`, value: "projectMemory", description: "Toggle durable local project memory" },
						{ title: `Learner mode: ${learning ? "On" : "Off"}`, value: "learning", description: "Toggle evidence-based learning tools" },
						{ title: `Title settle workaround: ${titleSettle ? "On" : "Off"}`, value: "titleSettleWorkaround", description: "Delay automatic continuation while OpenCode generates a session title" },
					],
					onSelect: (option) => {
						const key = option.value as ProjectToggle;
						const enabled = !readProjectOption(root, key);
						const path = writeProjectOption(root, key, enabled);
						api.ui.dialog.clear();
						api.ui.toast({ variant: "success", title: "Workflow Guard", message: `Saved ${key} ${enabled ? "on" : "off"} in ${path}. Restart OpenCode to apply.` });
					},
				}));
			},
		}],
		bindings: [],
	});

	api.slots.register({
		order: 1,
		slots: {
			home_prompt_right() {
				const theme = api.theme.current;
				const badge = formatBadge();
				return text({ fg: theme.success }, [badge.text]);
			},
			session_prompt_right() {
				const theme = api.theme.current;
				const badge = formatBadge();
				return text({ fg: theme.success }, [badge.text]);
			},
		},
	});
};

export default {
	id: "workflow-guard-ui",
	tui: WorkflowGuardTui,
} satisfies TuiPluginModule;
