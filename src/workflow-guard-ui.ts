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

const BADGE_ACTIVE = "[Workflow Guard: Active]";
let lastBlockedReason: string | undefined;
const sessionBlockedReasons = new Map<string, string>();
const badgeNodes = new Map<string, unknown>();

export function readProjectOption(root: string, option: "recoveryCheckpoints" | "projectMemory" | "learning"): boolean {
	const path = projectConfigPath(root);
	if (!existsSync(path)) return option === "projectMemory";
	const errors: ParseError[] = [];
	const config = parse(readFileSync(path, "utf8"), errors, { allowTrailingComma: true });
	if (errors.length > 0) throw new Error(`Invalid Workflow Guard project config: ${path}`);
	return option === "projectMemory" ? config?.projectMemory !== false : config?.[option] === true;
}

function writeProjectOption(root: string, option: "recoveryCheckpoints" | "projectMemory" | "learning", enabled: boolean): string {
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

export function setLastBlockedReasonForTesting(reason: string | undefined): void {
	lastBlockedReason = reason;
	if (reason === undefined) sessionBlockedReasons.clear();
}

export function getLastBlockedReason(): string | undefined {
	return lastBlockedReason;
}

export function formatBadge(sessionID?: string): { text: string; isBlocked: boolean } {
	const reason = sessionID ? sessionBlockedReasons.get(sessionID) : lastBlockedReason;
	if (!reason) {
		return { text: BADGE_ACTIVE, isBlocked: false };
	}
	const cleanReason = reason.replace(/^\[workflow-guard\]\s*/, "").replace(/^Blocked:\s*/, "");
	const shortReason = cleanReason.length > 30 ? cleanReason.slice(0, 27) + "..." : cleanReason;
	return { text: `[Workflow Guard: Blocked: ${shortReason}]`, isBlocked: true };
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
				api.ui.dialog.replace(() => api.ui.DialogSelect({
					title: "Workflow Guard Project Options",
					current: undefined,
					options: [
						{ title: `Recovery checkpoints: ${recovery ? "On" : "Off"}`, value: "recoveryCheckpoints", description: "Toggle durable pre-run Git checkpoints" },
						{ title: `Project memory: ${memory ? "On" : "Off"}`, value: "projectMemory", description: "Toggle durable local project memory" },
						{ title: `Learner mode: ${learning ? "On" : "Off"}`, value: "learning", description: "Toggle evidence-based learning tools" },
					],
					onSelect: (option) => {
						const key = option.value as "recoveryCheckpoints" | "projectMemory" | "learning";
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

	try {
		api.event?.on?.("tui.toast.show" as any, (e: any) => {
			const title = e?.properties?.title ?? e?.title;
			const msg = e?.properties?.message ?? e?.message;
			if (title === "Workflow Guard Blocked" && typeof msg === "string") {
				lastBlockedReason = msg;
				const route = api.route.current;
				const sessionID =
					route.name === "session" && typeof route.params?.sessionID === "string"
						? route.params.sessionID
						: undefined;
				if (sessionID) sessionBlockedReasons.set(sessionID, msg);
				const key = sessionID ?? "home";
				const node = badgeNodes.get(key);
				if (node) {
					const badge = formatBadge(sessionID);
					setProp(node as any, "content", badge.text);
					setProp(node as any, "fg", badge.isBlocked ? api.theme.current.warning : api.theme.current.success);
				}
			}
		});
	} catch {}

	api.slots.register({
		order: 1,
		slots: {
			home_prompt_right() {
				const theme = api.theme.current;
				const badge = formatBadge();
				const node = text({ fg: badge.isBlocked ? theme.warning : theme.success }, [badge.text]);
				badgeNodes.set("home", node);
				return node;
			},
			session_prompt_right() {
				const theme = api.theme.current;
				const route = api.route.current;
				const sessionID =
					route.name === "session" && typeof route.params?.sessionID === "string"
						? route.params.sessionID
						: undefined;
				const badge = formatBadge(sessionID);
				const node = text({ fg: badge.isBlocked ? theme.warning : theme.success }, [badge.text]);
				if (sessionID) badgeNodes.set(sessionID, node);
				return node;
			},
		},
	});
};

export default {
	id: "workflow-guard-ui",
	tui: WorkflowGuardTui,
} satisfies TuiPluginModule;
