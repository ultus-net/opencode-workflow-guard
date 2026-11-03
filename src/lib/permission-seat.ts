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
import { GIT_BRANCH_CREATE_RE, GIT_WRITE_RE, PUSH_TO_MAIN_RE, parseGitInvocation } from "../policies/git.ts";
import { hasPrCreateInvocation } from "../policies/changelog.ts";
import { splitShellSegments } from "./shell.ts";
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
 * Commands whose verdict depends on WHICH checkout they run in.
 *
 * A bare `git push`, `git commit`, or branch creation is judged against the
 * repository the shell's working directory resolves to, and PR preflight is
 * judged against the branch the PR publishes. This seat sees normalized
 * `action`/`resources` only, never the tool's `workdir`, so for those commands
 * the repository is an assumption rather than a fact: the session-bound
 * checkout may be the primary tree while the command targets a linked
 * worktree. Deciding on the assumption denied legitimate pushes and PRs, so
 * the seat defers them to `execute.before`, which sees the raw arguments.
 *
 * Two cases stay decisive:
 *
 * - An explicit `-C`/`--git-dir`/`--work-tree`/`GIT_DIR` names the repository
 *   in the command text, so it is a fact the seat can judge.
 * - A push whose destination is an explicitly named protected branch is a
 *   finding in every checkout, so no `workdir` can change the verdict.
 */
function repositoryDependent(command: string): boolean {
	for (const segment of splitShellSegments(command)) {
		// PR creation names no repository at all: the checkout is cwd-derived,
		// and a `--head`/`--source-branch` may live in another worktree.
		if (hasPrCreateInvocation(segment)) return true;
		const parsed = parseGitInvocation(segment);
		if (!parsed) continue;
		const rest = `git ${parsed.rest}`;
		if (parsed.explicitRepoDir) continue;
		if (PUSH_TO_MAIN_RE.test(rest)) continue;
		const repositorySensitive =
			/\bgit\s+push\b/.test(rest) ||
			GIT_WRITE_RE.test(rest) ||
			GIT_BRANCH_CREATE_RE.test(rest);
		if (repositorySensitive) return true;
	}
	return false;
}

/**
 * Policies whose verdict is derived from the selected checkout.
 *
 * A block from one of these may be an artifact of judging the wrong tree: the
 * original defect was a push denied for the protected branch of the primary
 * checkout while the command targeted a linked feature worktree. A block from
 * any other policy (destructive, shell-safety, secrets, tamper, todo) is a
 * finding about the command text itself, so no working directory can change it.
 */
const CHECKOUT_DERIVED_POLICIES = new Set(["git", "pr-preflight"]);

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
		let deferred: PermissionSeatResult | undefined;
		for (const resource of resources) {
			// Where the command runs is part of the decision for some commands,
			// and this seat cannot see the tool's `workdir`. Both directions of a
			// checkout-derived verdict are then unreliable: a block may be the
			// protected branch of the wrong tree, and an allow may be a feature
			// checkout that hides a push to a protected destination. Defer those
			// to `execute.before`, which resolves the shell's workdir.
			const cwdDependent = mapping.tool === "bash" && repositoryDependent(resource);
			const decision = await decide(mapping.tool, mapping.input(resource));
			const verdict = seatVerdict(decision, mapping.tool);
			if (cwdDependent) {
				// A block from any OTHER policy is a finding about the command
				// text itself (`cat .env` or a destructive live command in the
				// same compound command), so no working directory can change it
				// and it keeps its denial. Everything else defers.
				if (verdict?.effect === "deny" && !CHECKOUT_DERIVED_POLICIES.has(decision.policy ?? "")) return verdict;
				deferred = {
					effect: "abstain",
					mappedTool: mapping.tool,
					decision: {
						status: "needs_approval",
						policy: decision.policy ?? "git",
						code: "repository_unidentified",
						message: "[workflow-guard permission.evaluate] Deferred: this command's verdict depends on the directory it runs in, which the permission seat cannot see. `execute.before` resolves the shell's workdir and enforces there.",
					},
				};
				continue;
			}
			if (verdict) return verdict;
		}
		return deferred ?? { effect: "allow", mappedTool: mapping.tool };
	}

	// `<server>_<tool>` MCP actions: only the guarded live-system servers are
	// mapped (GitHub/Azure DevOps), matching the execute.before MCP policy.
	// Cache the host action's mutability to avoid recomputing it on every iteration.
	const actionIsMutating = mcpMutationTool(event.action);
	for (const resource of resources) {
		if (!actionIsMutating && !mcpMutationTool(resource)) continue;
		const decision = await decide(event.action, {});
		return seatVerdict(decision, event.action) ?? { effect: "allow", mappedTool: event.action };
	}
	return { effect: "allow" };
}
