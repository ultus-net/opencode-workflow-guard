import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";

export const WorkflowGuardTui: TuiPlugin = async (api) => {
	// 1. Emits a welcome confirmation toast when starting OpenCode TUI
	try {
		api.ui?.toast?.({
			title: "Workflow Guard",
			message: "Active & protecting session",
			variant: "success",
		});
	} catch {}

	// 2. Registers status indicator in the sidebar footer slot
	try {
		api.slots?.register?.({
			order: 1,
			slots: {
				sidebar_footer() {
					const theme = () => api.theme.current;
					// Returns visual ascii indicator
					return {
						type: "box",
						props: {
							paddingTop: 1,
							flexDirection: "row",
							gap: 1,
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
	id: "workflow-guard",
	tui: WorkflowGuardTui,
} satisfies TuiPluginModule;
