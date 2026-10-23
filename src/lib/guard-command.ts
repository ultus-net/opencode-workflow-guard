/**
 * Server-side `/guard-status` command for OpenCode 2.
 *
 * Before this, the only way to read guard state from inside a session was the
 * separately installed TUI companion, or knowing the `guard_status` tool name.
 * `ctx.command.transform` registers a command that runs in every V2 client.
 *
 * The command computes the report from the guard's own `guard_status` tool and
 * delivers it as a synthetic message. Two deliberate choices:
 *
 * - The report is not relayed through the model. `guard_status` is
 *   authoritative state; asking a model to restate it would introduce a
 *   paraphrase step between the operator and the evidence.
 * - Delivery uses `session.synthetic`, so the command costs no model turn.
 *   Synthetic messages do not run the `session.prompt` hook, so this cannot
 *   churn recovery checkpoints.
 */

import type { Plugin } from "@opencode/plugin";
import { audit } from "./audit.ts";
import { runWithRuntimeState } from "./state.ts";

/** The command id. Prefixed so it cannot shadow a user command by accident. */
export const GUARD_STATUS_COMMAND = "guard-status";

export interface GuardStatusCommandDeps {
	/** Produces the same JSON report as the `guard_status` tool. */
	runStatus: (sessionID: string) => Promise<string>;
	effectiveRoot: string;
	client: unknown;
}

interface CommandInvocation {
	readonly sessionID: string;
}

/**
 * Register the command. Registration is additive: a collision with an existing
 * command id is the host's to resolve, and the `guard-` prefix keeps that from
 * being accidental.
 */
export async function registerGuardStatusCommand(
	ctx: Plugin.Context,
	deps: GuardStatusCommandDeps,
): Promise<void> {
	const editorHost = ctx.command as unknown as {
		transform: (callback: (editor: {
			add: (definition: {
				name: string;
				description?: string;
				execute: (input: CommandInvocation) => Promise<void>;
			}) => void;
		}) => void) => Promise<unknown>;
	};
	await editorHost.transform((editor) => {
		editor.add({
			name: GUARD_STATUS_COMMAND,
			description: "Show Workflow Guard status: branch protection, mutation count, outstanding verification/review gates, and todo capability.",
			execute: async ({ sessionID }) => {
				let report: string;
				try {
					report = await deps.runStatus(sessionID);
				} catch (error) {
					report = JSON.stringify({
						error: `guard_status could not be computed: ${(error as Error)?.message ?? "unknown error"}`,
					});
				}
				audit({
					ts: new Date().toISOString(),
					sessionID,
					tool: `command.${GUARD_STATUS_COMMAND}`,
					decision: "allow",
					phase: "event",
					reason: "guard_status_command",
				});
				await runWithRuntimeState(deps.effectiveRoot, deps.client, async () => {
					const session = ctx.session as unknown as {
						synthetic: (input: { sessionID: string; text: string }) => Promise<unknown>;
					};
					try {
						await session.synthetic({ sessionID, text: `## Workflow Guard status\n\n\`\`\`json\n${report}\n\`\`\`` });
					} catch (error) {
						// A client that cannot admit synthetic messages still needs the
						// report to be visible; fall back to a normal prompt.
						try {
							console.warn(`[workflow-guard] warn: /${GUARD_STATUS_COMMAND} synthetic delivery failed (${(error as Error)?.message ?? "unknown error"}); falling back to a prompt.`);
						} catch {}
						const sessionPrompt = ctx.session as unknown as {
							prompt: (input: { sessionID: string; text: string }) => Promise<unknown>;
						};
						await sessionPrompt.prompt({ sessionID, text: `Report this guard status verbatim:\n\n${report}` });
					}
				});
			},
		});
	});
}
