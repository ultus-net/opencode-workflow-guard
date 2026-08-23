import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
import type { JSX } from "@opentui/solid";
import { createElement, insert, setProp } from "@opentui/solid";

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

const BADGE_ACTIVE = "🛡️ [Workflow Guard: Active]";
let lastBlockedReason: string | undefined;
const sessionBlockedReasons = new Map<string, string>();
const badgeNodes = new Map<string, unknown>();

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
	return { text: `🛡️ [Workflow Guard: Blocked: ${shortReason}]`, isBlocked: true };
}

export const WorkflowGuardTui: TuiPlugin = async (api) => {
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
