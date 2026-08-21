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

const BADGE = "🛡️ [Workflow Guard: Active]";

export const WorkflowGuardTui: TuiPlugin = async (api) => {
	api.slots.register({
		order: 1,
		slots: {
			home_prompt_right() {
				const theme = api.theme.current;
				return text({ fg: theme.success }, [BADGE]);
			},
			session_prompt_right() {
				const theme = api.theme.current;
				return text({ fg: theme.success }, [BADGE]);
			},
		},
	});
};

export default {
	id: "workflow-guard-ui",
	tui: WorkflowGuardTui,
} satisfies TuiPluginModule;
