import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";

export const WorkflowGuardTui: TuiPlugin = async (api) => {
	// Registers persistent status indicator in the bottom toolbar (left-aligned)
	try {
		api.slots?.register?.({
			order: 1,
			slots: {
				app_bottom() {
					const theme = () => api.theme.current;
					return {
						type: "box",
						props: {
							paddingLeft: 1,
							paddingRight: 1,
							flexDirection: "row",
							justifyContent: "flex-start",
							children: [
								{
									type: "text",
									props: {
										fg: theme().success,
										children: "🛡️ [Workflow Guard: Active]",
									},
								},
							],
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
