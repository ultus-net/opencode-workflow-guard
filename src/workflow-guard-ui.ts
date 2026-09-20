/**
 * Workflow Guard TUI companion plugin for OpenCode V2 (CLI plugin API).
 *
 * - Registers the `/guard-options` palette + slash command to toggle project options.
 * - Renders the Workflow Guard badge in the home and prompt footer status slots.
 *
 * The V1 entrypoint (`WorkflowGuardTui`) remains for OpenCode 1.x TUI clients.
 */

import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { Plugin, usePlugin } from "@opencode/plugin/tui";
import type { JSX } from "@opentui/solid";
import { createElement, insert, setProp, RendererContext } from "@opentui/solid";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { homedir } from "node:os";
import { getOwner, useContext } from "solid-js";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { projectConfigPath } from "./lib/project-config.ts";
import { canonicalPath } from "./policies/file-claims.ts";

// ── V2 render diagnostics (bounded; never throws) ────────────────────────────
// Slot renders run inside the TUI provider tree, but recurring failures have
// been observed in long-running sessions after plugin versions were swapped
// (opencode 2.0.10, "No renderer found" from @opentui/solid createElement).
// Instead of rethrowing — which makes the host error boundary toast on every
// retry for a cosmetic badge — a failing slot renders null, and failures are
// logged with owner/renderer context to a state file, bounded to the first
// DIAG_MAX_FAILURES_PER_SLOT failures per slot between successes. The next
// render attempt retries naturally, and a later success is logged again.
const DIAG_DIR = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "opencode");
const DIAG_LOG = join(DIAG_DIR, "workflow-guard-ui.log");
const DIAG_MAX_FAILURES_PER_SLOT = 3;
const DIAG_MAX_LOG_BYTES = 2_000_000;

function diag(line: string): void {
	try {
		mkdirSync(DIAG_DIR, { recursive: true });
		if (existsSync(DIAG_LOG) && statSync(DIAG_LOG).size > DIAG_MAX_LOG_BYTES) {
			writeFileSync(DIAG_LOG, "", { mode: 0o600 });
		}
		appendFileSync(DIAG_LOG, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
	} catch {
		// diagnostics must never crash the plugin
	}
}

try {
	diag(`module load: ${import.meta.url}; @opentui/solid -> ${import.meta.resolve("@opentui/solid")}; solid-js -> ${import.meta.resolve("solid-js")}`);
} catch (error) {
	diag(`module load: ${import.meta.url}; resolve probe failed: ${error}`);
}

const diagOkSlots = new Set<string>();
const diagFailureCount = new Map<string, number>();

function diagRender(slot: string): void {
	try {
		const owner = getOwner() as { context?: Record<string, unknown> | null } | null;
		const contextKeys = owner ? (owner.context ? Object.keys(owner.context).join(",") : "null") : "no-owner";
		const renderer = useContext(RendererContext);
		let plugin = "ok";
		try {
			usePlugin();
		} catch (error) {
			plugin = `FAILED: ${error}`;
		}
		if (!diagOkSlots.has(slot)) {
			diagOkSlots.add(slot);
			diag(`render ${slot} ok; owner=${owner ? "present" : "null"}; contextKeys=[${contextKeys}]; rendererContext=${renderer ? "found" : "MISSING"}; usePlugin=${plugin}`);
		}
	} catch (error) {
		diag(`render ${slot} probe FAILED: ${error instanceof Error ? `${error.message}\n${error.stack}` : String(error)}`);
	}
}

function diagFailure(slot: string, error: unknown): void {
	const count = (diagFailureCount.get(slot) ?? 0) + 1;
	diagFailureCount.set(slot, count);
	if (count > DIAG_MAX_FAILURES_PER_SLOT) {
		if (count === DIAG_MAX_FAILURES_PER_SLOT + 1) {
			diag(`render ${slot} still failing after ${DIAG_MAX_FAILURES_PER_SLOT} logged failures; further failures are suppressed until a render succeeds`);
		}
		return;
	}
	const lines = [
		`render ${slot} FAILED (${count}/${DIAG_MAX_FAILURES_PER_SLOT}): ${error instanceof Error ? error.message : String(error)}`,
		`  stack: ${error instanceof Error ? error.stack : "(none)"}`,
	];
	try {
		const owner = getOwner() as { context?: Record<string, unknown> | null } | null;
		lines.push(`  owner=${owner ? "present" : "null"}; contextKeys=[${owner ? (owner.context ? Object.keys(owner.context).join(",") : "null") : "none"}]`);
	} catch (probeError) {
		lines.push(`  owner probe failed: ${probeError}`);
	}
	try {
		lines.push(`  useContext(RendererContext): ${useContext(RendererContext) ? "found" : "MISSING"}`);
	} catch (probeError) {
		lines.push(`  renderer probe failed: ${probeError}`);
	}
	try {
		usePlugin();
		lines.push(`  usePlugin: ok`);
	} catch (probeError) {
		lines.push(`  usePlugin: FAILED ${probeError}`);
	}
	diag(lines.join("\n"));
}
// ── end render diagnostics ───────────────────────────────────────────────────

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

type ProjectToggle = "recoveryCheckpoints" | "projectMemory" | "learning" | "titleSettleWorkaround" | "ralphMode";

export function readProjectOption(root: string, option: ProjectToggle): boolean {
	const path = projectConfigPath(root);
	const enabledByDefault = option === "projectMemory" || option === "titleSettleWorkaround";
	if (!existsSync(path)) return enabledByDefault;
	const errors: ParseError[] = [];
	const config = parse(readFileSync(path, "utf8"), errors, { allowTrailingComma: true });
	if (errors.length > 0) throw new Error(`Invalid Workflow Guard project config: ${path}`);
	return enabledByDefault ? config?.[option] !== false : config?.[option] === true;
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

// ── V2 CLI plugin ─────────────────────────────────────────────────────────────

type TuiContext = Plugin.Context;

const TOGGLE_OPTIONS: Array<{ key: ProjectToggle; label: string; description: string }> = [
	{ key: "recoveryCheckpoints", label: "Recovery checkpoints", description: "Toggle durable pre-run Git checkpoints" },
	{ key: "projectMemory", label: "Project memory", description: "Toggle durable local project memory" },
	{ key: "learning", label: "Learner mode", description: "Toggle evidence-based learning tools" },
	{ key: "titleSettleWorkaround", label: "Title settle workaround", description: "Delay automatic continuation while OpenCode generates a session title" },
	{ key: "ralphMode", label: "Ralph mode", description: "Opt into bounded autonomous continuation of already-owned todos" },
];

export const WorkflowGuardTuiV2 = (ctx: TuiContext) => {
	diag(`setup: app=${ctx.app?.version ?? "?"}; location=${ctx.location?.directory ?? "?"}`);

	const badge = () => {
		const formatted = formatBadge();
		return text({ fg: ctx.theme.text.feedback.success.base }, [formatted.text]);
	};

	const optionsRoot = () => ctx.location?.directory || process.cwd();

	// `ctx.keymap.layer` creates a layer owned by the calling component and only
	// resolves inside the TUI's provider render tree; plugin setup() runs as a
	// plain async call outside it. Slot renders execute in a reactive scope under
	// the provider, so the layer is registered from an app-slot claim instead.
	// The guard keeps repeated renders from stacking duplicate layers; layers and
	// slot claims are disposed automatically on unload.
	let keymapLayerRegistered = false;
	ctx.ui.slot({
		append: "app",
		render: () => {
			if (!keymapLayerRegistered) {
				keymapLayerRegistered = true;
				ctx.keymap.layer(() => ({
					commands: [{
						id: "workflow-guard.project-options",
						title: "Workflow Guard: Project Options",
						description: "Toggle Workflow Guard project options (recovery checkpoints, project memory, learning, title settle, ralph mode)",
						group: "Workflow Guard",
						palette: true,
						slash: { name: "guard-options" },
						async run() {
							const root = optionsRoot();
							for (;;) {
								const current = new Map(TOGGLE_OPTIONS.map((option) => [option.key, readProjectOption(root, option.key)]));
								const choice = await ctx.ui.dialog.select<ProjectToggle>({
									title: "Workflow Guard Project Options",
									options: TOGGLE_OPTIONS.map((option) => ({
										title: `${option.label}: ${current.get(option.key) ? "On" : "Off"}`,
										value: option.key,
										description: option.description,
									})),
								});
								if (!choice) break;
								try {
									const enabled = !readProjectOption(root, choice);
									const path = writeProjectOption(root, choice, enabled);
									ctx.ui.toast.show({
										variant: "success",
										title: "Workflow Guard",
										message: `Saved ${choice} ${enabled ? "on" : "off"} in ${path}. Restart OpenCode to apply.`,
									});
								} catch (error) {
									ctx.ui.toast.show({
										variant: "error",
										title: "Workflow Guard",
										message: error instanceof Error ? error.message : String(error),
									});
									break;
								}
							}
						},
					}],
					bindings: [],
				}));
			}
			return null;
		},
	});

	const registerBadgeSlot = (slot: NonNullable<Parameters<TuiContext["ui"]["slot"]>[0]["append"]>) => {
		ctx.ui.slot({
			append: slot,
			render: () => {
				try {
					const element = badge();
					if (!diagOkSlots.has(slot)) {
						diagOkSlots.add(slot);
						diagFailureCount.delete(slot);
						diag(`render ${slot} ok`);
					}
					return element;
				} catch (error) {
					diagOkSlots.delete(slot);
					diagFailure(slot, error);
					return null;
				}
			},
		});
	};
	registerBadgeSlot("home.footer.status");
	registerBadgeSlot("prompt.footer.status");
	diagRender("probe-after-setup");

	return () => {
		// Slot claims and keymap layers are disposed automatically on unload.
	};
};

// ── V1 TUI plugin ─────────────────────────────────────────────────────────────

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
				const toggle = (key: ProjectToggle) => {
					const enabled = !readProjectOption(root, key);
					const path = writeProjectOption(root, key, enabled);
					api.ui.dialog.clear();
					api.ui.toast({ variant: "success", title: "Workflow Guard", message: `Saved ${key} ${enabled ? "on" : "off"} in ${path}. Restart OpenCode to apply.` });
				};
				api.ui.dialog.replace(() => api.ui.DialogSelect({
					title: "Workflow Guard Project Options",
					current: undefined,
					options: TOGGLE_OPTIONS.map((option) => ({
						title: `${option.label}: ${readProjectOption(root, option.key) ? "On" : "Off"}`,
						value: option.key,
						description: option.description,
						onSelect: () => toggle(option.key),
					})),
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

// Default export supports BOTH generations: V1 TUI clients call tui(), V2 reads setup().
export default {
	...Plugin.define({
		id: "workflow-guard-ui",
		setup: WorkflowGuardTuiV2,
	}),
	tui: WorkflowGuardTui,
} as const satisfies TuiPluginModule;
