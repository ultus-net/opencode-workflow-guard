/**
 * V2 permission seat: `ctx.permission.hook("evaluate")`.
 *
 * Two enforcement seats, deliberately complementary:
 *
 * - `evaluate` sees the host's normalized permission check (an `action` plus
 *   its `resources`) before anything runs, so a denial there means the tool
 *   never starts. It does NOT see raw tool input, so tool-lifecycle work
 *   (todo transitions, stale-write observations, post-edit snapshots) stays in
 *   `execute.before`.
 * - `execute.before` sees the raw arguments and aborts with a specific
 *   remediation message, but only after the permission layer has allowed.
 *
 * The seat can only tighten. An explicit configured `deny` is final: the host
 * never invokes the hook for it (it resolves deny first and only calls the hook
 * when the configured effect is allow/ask). A hook denial is therefore always a
 * response to something the host would otherwise permit.
 *
 * An `abstain` is the one case where the seat does not tighten. The simulated
 * core reports `needs_approval` when it cannot decide without the remote
 * GitHub/Azure PR probe, which simulation skips on purpose. The host's
 * configured effect then stays untouched and `execute.before` runs the real
 * check, probe included.
 *
 * Every decision here is a simulation of the policy core: `simulate: true`
 * skips mutation accounting, file claims, verification runs, and durable audit
 * writes, because the same call is evaluated for real in `execute.before`.
 */

import { guardToolCallImpl } from "./guard-dispatcher.ts";
import { getSessionBoundWorkspace, runWithRuntimeState } from "./state.ts";
import { mcpMutationTool } from "../policies/mcp.ts";
import type { PolicyDecision } from "./types.ts";

/** The subset of the host's permission evaluation this seat reads. */
export interface PermissionSeatEvent {
	readonly sessionID: string;
	readonly agent?: string;
	readonly action: string;
	readonly resources: readonly string[];
	readonly effect: "allow" | "deny" | "ask";
}

export interface PermissionSeatDeps {
	workspaceRoot: string;
	client: unknown;
}

export interface PermissionSeatResult {
	/**
	 * The effect the seat leaves in place. `abstain` is an explicit third
	 * state: the simulated policy core could not decide, so the host's
	 * configured effect stays untouched and `execute.before` enforces.
	 */
	effect: "allow" | "deny" | "abstain";
	/** Set when the seat denied, and kept on an abstention for the audit row. */
	decision?: PolicyDecision;
	/** The guard tool the action was mapped onto, for attribution. */
	mappedTool?: string;
}

const EDIT_ACTIONS = new Set(["edit", "write", "patch", "apply_patch"]);

/**
 * Map one simulated policy decision onto the seat's effect.
 *
 * Only `needs_approval` abstains. That status means the simulated core could
 * not decide, because `simulate: true` deliberately skips the remote GitHub or
 * Azure PR probe. Collapsing it into `deny` would miscategorise an abstention
 * as a finding and block every non-protected `git push`. Deferring it leaves
 * the host's configured effect untouched, and `execute.before` runs the real
 * check with the probe. Every other non-allowed status stays a denial.
 */
function seatVerdict(decision: PolicyDecision, mappedTool: string): PermissionSeatResult | undefined {
	if (decision.status === "allowed") return undefined;
	return {
		effect: decision.status === "needs_approval" ? "abstain" : "deny",
		decision: { ...decision, message: `[workflow-guard permission.evaluate] ${decision.message}` },
		mappedTool,
	};
}

function mappedToolFor(action: string): { tool: string; input: (resource: string) => unknown } | undefined {
	if (action === "shell" || action === "bash") {
		return { tool: "bash", input: (resource) => ({ command: resource }) };
	}
	if (action === "read" || action === "read_file") {
		return { tool: "read", input: (resource) => ({ filePath: resource }) };
	}
	if (EDIT_ACTIONS.has(action)) {
		// `edit` is the canonical mutation tool name: it carries the tamper,
		// secret, boundary, protected-branch, and todo checks.
		return { tool: "edit", input: (resource) => ({ filePath: resource }) };
	}
	return undefined;
}

/**
 * Evaluate one host permission request. Returns the effect to leave in place.
 *
 * Unmapped actions (`external_directory`, `glob`, `grep`, `webfetch`,
 * `websearch`, `question`, `subagent`, ...) stay with the host: config policy
 * and the user prompt are the right seats for them, and the guard's shell,
 * file, and MCP checks have nothing to add. The hook still journals them.
 */
export async function evaluatePermissionSeat(
	event: PermissionSeatEvent,
	deps: PermissionSeatDeps,
): Promise<PermissionSeatResult> {
	if (event.effect === "deny") return { effect: "deny" };
	const resources = event.resources.filter((resource): resource is string => typeof resource === "string" && resource.length > 0);
	if (resources.length === 0) return { effect: "allow" };
	const workspaceRoot = getSessionBoundWorkspace(event.sessionID) || deps.workspaceRoot;
	const context = { sessionID: event.sessionID, agent: event.agent, worktree: workspaceRoot, simulate: true };
	const decide = (tool: string, input: unknown): Promise<PolicyDecision> =>
		runWithRuntimeState(workspaceRoot, deps.client, () => guardToolCallImpl(tool, input, context));

	const mapping = mappedToolFor(event.action);
	if (mapping) {
		for (const resource of resources) {
			const decision = await decide(mapping.tool, mapping.input(resource));
			const verdict = seatVerdict(decision, mapping.tool);
			if (verdict) return verdict;
		}
		return { effect: "allow", mappedTool: mapping.tool };
	}

	// `<server>_<tool>` MCP actions: only the guarded live-system servers are
	// mapped (GitHub/Azure DevOps), matching the execute.before MCP policy.
	for (const resource of resources) {
		if (!mcpMutationTool(event.action) && !mcpMutationTool(resource)) continue;
		const decision = await decide(event.action, {});
		return seatVerdict(decision, event.action) ?? { effect: "allow", mappedTool: event.action };
	}
	return { effect: "allow" };
}
