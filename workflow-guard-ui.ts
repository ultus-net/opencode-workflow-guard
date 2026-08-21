import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";

export const WorkflowGuardTui: TuiPlugin = async (api) => {
	// Registers persistent status indicator in the prompt box next to the model indicator
	try {
		api.slots?.register?.({
			order: 1,
			slots: {
				session_prompt_right() {
					const theme = () => api.theme.current;
					return {
						type: "text",
						props: {
							fg: theme().success,
							children: "🛡️ [Workflow Guard: Active]",
						},
					} as any;
				},
			},
		});
	} catch {}
};

export default {
	id: "workflow-guard-ui",
	tui: WorkflowGuardTui,
} satisfies TuiPluginModule;
