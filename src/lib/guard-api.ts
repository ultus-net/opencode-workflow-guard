/**
 * Shared guard entry surface, host-agnostic.
 *
 * These three helpers used to live in `workflow-guard.ts`, the V1 entrypoint.
 * `lib/v2-plugin.ts` imported them from there, which created an import cycle:
 * `workflow-guard.ts` imports `WorkflowGuardV2` from `lib/v2-plugin.ts`, so the
 * cycle dragged the whole V1 file, `@opencode-ai/plugin`, and its
 * `@opencode-ai/sdk` subtree into a V2 host.
 *
 * They live here so both entrypoints import a leaf module instead. This is a
 * pure move: behavior, audit fields, and return values are unchanged.
 * `workflow-guard.ts` keeps re-exporting them, because the test harness imports
 * that public surface.
 */

import { guardToolCallImpl } from "./guard-dispatcher.ts";
import { getSdkClient, runWithRuntimeState, lastMutationTimestamp, lastVerify } from "./state.ts";
import { logDecision } from "./audit.ts";
import { extractRecordTargetPath } from "./utils.ts";
import type { PolicyDecision } from "./types.ts";
import { EDIT_TOOL_NAMES } from "../policies/todo.ts";

/**
 * Public guard entry point. Audits every decision (block or allow) to a
 * durable JSONL file before returning.
 */
export async function guardToolDecision(
	toolName: string,
	input: unknown,
	context?: { sessionID?: string; callID?: string; worktree?: string; directory?: string; agent?: string },
): Promise<PolicyDecision> {
	const customRoot = context?.worktree || context?.directory;
	const runImpl = () => guardToolCallImpl(toolName, input, context);
	return customRoot
		? await runWithRuntimeState(customRoot, getSdkClient(), runImpl)
		: await runImpl();
}

/** Convenience wrapper: the block reason, or `undefined` when allowed. */
export async function guardToolCall(
	toolName: string,
	input: unknown,
	context?: { sessionID?: string; callID?: string; worktree?: string; directory?: string; agent?: string },
): Promise<string | undefined> {
	const decision = await guardToolDecision(toolName, input, context);
	const allowLive = process.env.WORKFLOW_GUARD_ALLOW_LIVE === "1";
	const isMutation = EDIT_TOOL_NAMES.has(toolName);
	const targetPath = extractRecordTargetPath(input);
	logDecision(toolName, input, context, decision, {
		mutation: isMutation,
		targetPath,
		allowLive,
		verification: lastVerify
			? {
					command: lastVerify.command,
					passed: lastVerify.passed,
					fresh: lastVerify.timestamp >= lastMutationTimestamp,
					durationMs: lastVerify.durationMs,
				}
			: undefined,
	});
	return decision.status === "allowed" ? undefined : decision.message;
}

/**
 * Build the bounded compaction context from the operational state plus the
 * priority blocks, capping the total at `maxChars` (default 8,000).
 */
export function buildCompactionContext(operationalState: string, priorityBlocks: string[], maxChars = 8_000): string {
	if (!Number.isFinite(maxChars) || maxChars < 0 || !Number.isInteger(maxChars)) {
		throw new RangeError("maxChars must be a non-negative finite integer");
	}
	const truncate = (value: string, limit: number): string => {
		let end = Math.min(value.length, limit);
		if (end > 0 && end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end -= 1;
		return value.slice(0, end);
	};
	let context = truncate(operationalState, maxChars);
	for (const block of priorityBlocks) {
		const remaining = maxChars - context.length - 2;
		if (remaining <= 0) break;
		context += `\n\n${truncate(block, remaining)}`;
	}
	return context;
}
