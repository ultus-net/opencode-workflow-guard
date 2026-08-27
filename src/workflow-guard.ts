/**
 * Workflow Guard Plugin for OpenCode (hooks-only - no prompt rules)
 *
 * Deterministic enforcement via the tool.execute.before plugin hook.
 * Throwing from the hook blocks the tool call outright.
 *
 * Orchestrator: imports policy modules from ./policies/ and engine services
 * from ./lib/, and re-exports the public helper surface for tests.
 */

import { type Plugin, type PluginModule } from "@opencode-ai/plugin";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { join } from "node:path";
import { editTargets, runPostEditValidators, snapshotFile } from "./policies/post-edit-validation.ts";
import { claimFiles, releaseFileClaims } from "./policies/file-claims.ts";
import { beginReadObservation, clearReadFingerprints, recordSuccessfulRead, staleWriteReason } from "./policies/stale-write.ts";
import { ToolInvocationLifecycle } from "./lib/tool-lifecycle.ts";
import { ToolOutcomeTracker, type ToolOutcomePart } from "./lib/tool-outcomes.ts";
import { guardToolCallImpl, isReadOnlyRole } from "./lib/guard-dispatcher.ts";
import { createCustomTools } from "./lib/custom-tools.ts";
import type { TodoSdkClient } from "./lib/types.ts";
export { isReadOnlyRole } from "./lib/guard-dispatcher.ts";
export { extractReviewFollowups } from "./lib/custom-tools.ts";

// ── Types ────────────────────────────────────────────────────────────────────
export type {
	TodoItem,
	ProjectConfig,
	VerifyResult,
	ReviewResult,
	AuditEntry,
	GitInvocation,
	ShellMutation,
	LearnerProfile,
	LearningEvidence,
	LearningOpportunity,
} from "./lib/types.ts";
export type { TodoSdkClient };

// ── State & runtime context ──────────────────────────────────────────────────
import {
	setWorkspaceRoot,
	getWorkspaceRoot,
	setSdkClient,
	getSdkClient,
	runWithRuntimeState,
	lastMutationTimestamp,
	getLastMutationTimestamp,
	getMutationCount,
	getSessionMutationCount,
	lastVerify,
	getLastVerifyResult,
	recordMutation,
	recordVerifyResult,
	resetVerifyState,
	sessionMutationTimestamps,
	sessionVerifyResults,
	getProjectConfig,
	isReviewRequired,
	isDocumentationRequired,
	getSubagentMutationBudget,
	isLearningEnabled,
	isProjectMemoryEnabled,
	getLearningInterventionBudget,
	recordReviewResult,
	getLastReviewResult,
	resetReviewState,
	sessionReviews,
} from "./lib/state.ts";
import { loadProjectConfig, reloadProjectConfig, stripJsonComments } from "./lib/project-config.ts";

export {
	setWorkspaceRoot,
	getWorkspaceRoot,
	setSdkClient,
	getLastMutationTimestamp,
	getMutationCount,
	getLastVerifyResult,
	recordMutation,
	recordVerifyResult,
	resetVerifyState,
	loadProjectConfig,
	reloadProjectConfig,
	stripJsonComments,
	isReviewRequired,
	isDocumentationRequired,
	getSubagentMutationBudget,
	isLearningEnabled,
	getLearningInterventionBudget,
	recordReviewResult,
	getLastReviewResult,
	resetReviewState,
};

// ── Shared shell/env utilities ───────────────────────────────────────────────
import {
	extractRecordTargetPath,
	getCleanEnv,
	showBlockToast,
	isSensitiveEnvKey,
} from "./lib/utils.ts";
import { dynamicShellSyntaxIn } from "./lib/shell.ts";

export { getCleanEnv, dynamicShellSyntaxIn };

// ── Adaptive learning engine ─────────────────────────────────────────────────
export {
	createLearnerProfile,
	getLearnerProfilePath,
	loadLearnerProfile,
	recordLearningEvidence,
	saveLearnerProfile,
	selectLearningOpportunity,
	updateLearnerProfile,
} from "./lib/learning.ts";

// ── Project memory ───────────────────────────────────────────────────────────
export {
	getProjectMemoryDir,
	getProjectMemoryIdentity,
	ensureProjectMemoryExcluded,
	isProjectMemoryFresh,
	openProjectMemory,
	maintainProjectMemoryStorage,
	recordProjectMemory,
	searchProjectMemory,
	getRecentProjectMemory,
	recordReviewFollowup,
	listReviewFollowups,
	resolveReviewFollowup,
	exportProjectKnowledge,
	importProjectKnowledge,
} from "./lib/project-memory.ts";
import { ensureProjectMemoryExcluded, getProjectMemoryIdentity, getRecentProjectMemory, importProjectKnowledge, isProjectMemoryFreshAsync, listReviewFollowups, openProjectMemory } from "./lib/project-memory.ts";

// ── Audit & durable verification cache ───────────────────────────────────────
import {
	getAuditFilePath,
	getVerifyCacheFilePath,
	persistVerifyCache,
	loadVerifyCache,
	audit,
	logDecision,
	summarizeInput,
} from "./lib/audit.ts";

export { getAuditFilePath, getVerifyCacheFilePath, getVerifyHistoryFilePath, persistVerifyCache, loadVerifyCache, getRecentAuditEntries, getRecentVerifyHistory } from "./lib/audit.ts";
export { summarizeInput };

export function managedConfigDiagnostic(platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
	const directory = platform === "darwin"
		? "/Library/Application Support/opencode"
		: platform === "win32"
			? env.ProgramData ? join(env.ProgramData, "opencode") : undefined
			: platform === "linux" ? "/etc/opencode" : undefined;
	const detected = directory !== undefined && ["opencode.json", "opencode.jsonc"].some((name) => existsSync(join(directory, name)));
	return directory
		? `managed config ${detected ? "detected" : "not detected"} at ${directory}; plugin provenance is not verified by the OpenCode V1 API`
		: "managed config location is unknown on this platform; plugin provenance is not verified by the OpenCode V1 API";
}

// ── Verification engine ──────────────────────────────────────────────────────
import {
	detectVerifyCommand,
	runVerify,
	snipVerifyOutput,
	getCurrentGitCommitHash,
	getGitStatusSummary,
	getGitWorktreeFingerprint,
} from "./lib/verify.ts";

export {
	detectVerifyCommand,
	runVerify,
	snipVerifyOutput,
	getCurrentGitCommitHash,
	getGitStatusSummary,
	getGitWorktreeFingerprint,
};

// ── Secondary review rubric ──────────────────────────────────────────────────
import { buildReviewRubric } from "./lib/review.ts";
export { buildReviewRubric };

// ── Git worktree lifecycle ───────────────────────────────────────────────────
import {
	getWorktreeStorageDir,
	getCleanGitEnv,
	isValidBranchName,
	createGitWorktree,
	cleanupGitWorktree,
} from "./lib/worktree.ts";

export {
	getWorktreeStorageDir,
	getCleanGitEnv,
	isValidBranchName,
	createGitWorktree,
	cleanupGitWorktree,
};

// ── Policy modules ───────────────────────────────────────────────────────────
import {
	EDIT_TOOL_NAMES,
	validateTodoLifecycle,
	fetchSessionTodos,
	fetchParentSessionID,
	fetchParentSession,
	subagentMutationBudgetReason,
	effectiveTodos,
} from "./policies/todo.ts";
import {
	clearContinuationState,
	continueUnfinishedSession,
	isGeneratedContinuationMessage,
	recordUserMessage,
} from "./policies/continuation.ts";
import {
	createRecoveryCheckpoint,
	finalizeRecoveryCheckpoint,
	nextRecoveryRun,
} from "./lib/checkpoint.ts";
import { discoverPlanningSources } from "./policies/planning.ts";
export { discoverPlanningSources };

export { validateTodoLifecycle };

import {
	currentGitBranch,
	onProtectedBranch,
	isProtectedBranchName,
	isBranchAlreadyMergedOrClosed,
	checkMergeConflicts,
	checkBranchBaseIsUpToDate,
} from "./policies/git.ts";

export {
	isProtectedBranchName,
	isBranchAlreadyMergedOrClosed,
	checkMergeConflicts,
	checkBranchBaseIsUpToDate,
};

import {
	checkLockfileSync,
} from "./policies/changelog.ts";

export { checkLockfileSync };

import {
	isProtectedPath,
} from "./policies/tamper.ts";

export { isProtectedPath };

import { isSecretPath, secretIn, isEnvFilePath, generateMaskedEnvSchema } from "./policies/secrets.ts";

export { isSecretPath, isEnvFilePath, generateMaskedEnvSchema };

import {
	extractInterpreterPayload,
	secretPathInPayload,
	outsideWritePathInPayload,
} from "./policies/interpreter.ts";
export { extractInterpreterPayload, secretPathInPayload, outsideWritePathInPayload };

import { branchHasDocumentationChange } from "./policies/docs.ts";
export { branchHasDocumentationChange };

import {
	checkInteractiveTtyCommand,
	checkPackageHygiene,
	escapeAppleScriptString,
} from "./policies/shell-safety.ts";

import { checkCompletionClaims } from "./policies/completion.ts";

export { checkCompletionClaims };

export { sendDesktopNotification } from "./policies/shell-safety.ts";
export { checkInteractiveTtyCommand, checkPackageHygiene, escapeAppleScriptString };

function logObservation(client: unknown, message: string): void {
	try {
		void (client as TodoSdkClient | undefined)?.app?.log?.({
			body: { service: "workflow-guard", level: "info", message },
		});
	} catch {}
}

/**
 * Public guard entry point. Audits every decision (block or allow) to a
 * durable JSONL file before returning.
 */
export async function guardToolCall(
	toolName: string,
	input: unknown,
	context?: { sessionID?: string; callID?: string; worktree?: string; directory?: string; agent?: string },
): Promise<string | undefined> {
	const customRoot = context?.worktree || context?.directory;
	const runImpl = () => guardToolCallImpl(toolName, input, context);
	const reason = customRoot
		? await runWithRuntimeState(customRoot, getSdkClient(), runImpl)
		: await runImpl();
	const allowLive = process.env.WORKFLOW_GUARD_ALLOW_LIVE === "1";
	const isMutation = EDIT_TOOL_NAMES.has(toolName);
	const targetPath = extractRecordTargetPath(input);
	logDecision(toolName, input, context, reason, {
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
	return reason;
}

async function emitBlockFeedback(message: string): Promise<void> {
	await showBlockToast(message);
}

export const WorkflowGuard: Plugin = async (ctx) => {
	// Honor worktree if present (e.g. opencode worktrees or devcontainers)
	// so worktree plugins cannot punch through boundary gates. When the host
	// reports the filesystem root, use the SDK's actual project worktree instead.
	const hostRoot = ctx.worktree || ctx.directory || process.cwd();
	const hostIsFilesystemRoot = resolve(hostRoot) === resolve(hostRoot, "..");
	const effectiveRoot = hostIsFilesystemRoot && ctx.project?.worktree
		? ctx.project.worktree
		: hostRoot;
	setWorkspaceRoot(effectiveRoot);
	setSdkClient(ctx.client);
	reloadProjectConfig(effectiveRoot);
	const learningEnabled = isLearningEnabled(effectiveRoot);
	const projectMemoryEnabled = isProjectMemoryEnabled(effectiveRoot);
	const learningInterventions = new Map<string, number>();
	const portableMemoryPath = join(effectiveRoot, ".opencode", "memory", "project-memory.jsonl");
	let followupStore: ReturnType<typeof openProjectMemory> | undefined;
	let projectMemory: ReturnType<typeof openProjectMemory> | undefined;
	try {
		followupStore = openProjectMemory(getProjectMemoryIdentity(effectiveRoot));
	} catch {}
	try {
		if (!projectMemoryEnabled) throw new Error("Project memory disabled");
		projectMemory = openProjectMemory(getProjectMemoryIdentity(effectiveRoot));
		ensureProjectMemoryExcluded(effectiveRoot);
		importProjectKnowledge(projectMemory, portableMemoryPath, (content) => secretIn(content) !== undefined);
	} catch {
		try { projectMemory?.close(); } catch {}
		projectMemory = undefined;
	}

	try {
		await ctx.client.app.log({
			body: {
				service: "workflow-guard",
				level: "info",
				message: `Workflow Guard plugin initialized for ${effectiveRoot}; ${managedConfigDiagnostic()}`,
			},
		});
	} catch {}

	const toolLifecycle = new ToolInvocationLifecycle();
	const toolOutcomes = new ToolOutcomeTracker();

	return {
		tool: createCustomTools({ effectiveRoot, projectMemoryEnabled, learningEnabled, projectMemory, followupStore, portableMemoryPath, learningInterventions, client: ctx.client }),

		"tool.execute.before": async (input, output) => {
			const toolWorktree =
				(input as { worktree?: string })?.worktree ||
				(input as { directory?: string })?.directory ||
				(output as { worktree?: string })?.worktree ||
				(output as { directory?: string })?.directory ||
				effectiveRoot;
			const toolAgent =
				(input as { agent?: string })?.agent ||
				(output as { agent?: string })?.agent;
			return runWithRuntimeState(toolWorktree, ctx.client, async () => {
				const args =
					(output as { args?: unknown } | undefined)?.args ??
					(input as { args?: unknown }).args;
				const reason = await guardToolCall(input.tool, args, {
					sessionID: input.sessionID,
					callID: input.callID,
					worktree: toolWorktree,
					agent: toolAgent,
				});
				if (reason !== undefined) {
					await emitBlockFeedback(reason);
					throw new Error(`[workflow-guard] ${reason}`);
				}
				toolLifecycle.start(input.sessionID, input.callID);
				if (input.tool === "read") {
					const target = editTargets(args, toolWorktree)[0];
					if (target) {
						const observation = beginReadObservation(target);
						if (observation) toolLifecycle.setReadObservation(input.sessionID, input.callID, observation);
					}
				}
				if (EDIT_TOOL_NAMES.has(input.tool)) {
					const snapshots = editTargets(args, toolWorktree).map(snapshotFile);
					if (snapshots.length) toolLifecycle.setPostEditSnapshots(input.sessionID, input.callID, toolWorktree, snapshots);
				}
			});
		},

		"tool.execute.after": async (input, output) => {
			const startedAt = toolLifecycle.finish(input.sessionID, input.callID);
			const outcome = toolOutcomes.recordFallbackCompleted(input.sessionID, input.callID, input.tool, startedAt === undefined ? undefined : Date.now() - startedAt);
			if (outcome) {
				audit({
					ts: new Date().toISOString(),
					sessionID: outcome.sessionID,
					callID: outcome.callID,
					tool: outcome.tool,
					decision: "allow",
					phase: "outcome",
					durationMs: outcome.durationMs,
					reason: outcome.status,
				});
			}
			releaseFileClaims(input.sessionID, input.callID);
			if (input.tool === "read") {
				const observation = toolLifecycle.takeReadObservation(input.sessionID, input.callID);
				if (observation) recordSuccessfulRead(observation, input.sessionID);
			}
			const pending = toolLifecycle.takePostEditSnapshots(input.sessionID, input.callID);
			if (!pending) return;
			await runWithRuntimeState(pending.root, ctx.client, async () => {
				const reports = await Promise.all(pending.snapshots.map((before) => runPostEditValidators(pending.root, before)));
				const report = reports.filter((value): value is string => Boolean(value)).join("\n\n");
				if (report) output.output = `${output.output}\n\n${report}`;
			});
		},

		"experimental.session.compacting": async (input, output) => {
			try {
				const sessionID = (input as { sessionID?: string })?.sessionID;
				const parentID = sessionID ? await fetchParentSessionID(sessionID) : undefined;
				const todos = await effectiveTodos(sessionID);
				const active = todos?.filter((t) => {
					const s = String(t.status ?? "");
					return s === "pending" || s === "in_progress";
				});
				const branch = currentGitBranch(effectiveRoot) ?? "unknown";
				const isProtected = branch !== "unknown" && isProtectedBranchName(branch, effectiveRoot);
				const sessionMutationCount = sessionID ? getSessionMutationCount(sessionID) : 0;
				const lastV = sessionID
					? (sessionVerifyResults.get(sessionID) ?? (sessionMutationCount === 0 && parentID ? sessionVerifyResults.get(parentID) : undefined))
					: lastVerify;
				const lastR = sessionID
					? (sessionReviews.get(sessionID) ?? (sessionMutationCount === 0 && parentID ? sessionReviews.get(parentID) : undefined))
					: getLastReviewResult();
				const mutationCountVal = sessionID ? sessionMutationCount : getMutationCount();

				const contextBlocks: string[] = [];

				if (active && active.length > 0) {
					const lines = active.slice(0, 20).map(
						(t) =>
							`- [${String(t.status) === "in_progress" ? "IN PROGRESS" : "PENDING"}] ${String(t.content ?? "").slice(0, 300)}`,
					);
					if (active.length > 20) lines.push(`- ... ${active.length - 20} more active task(s) omitted`);
					const attribution = parentID
						? ` (Subagent session: ${sessionID}, Parent: ${parentID})`
						: sessionID
							? ` (Session: ${sessionID})`
							: "";
					contextBlocks.push(
						`## Active Tasks${attribution}\n` +
							lines.join("\n") +
							"\nComplete tasks efficiently - mark finished items as completed and address remaining ones.",
					);
				}

				const stateLines: string[] = [
					`## Operational Guard State`,
					`- Git Branch: ${branch}${isProtected ? " (PROTECTED BRANCH - edits/commits require feature branch)" : " (feature branch - edits allowed)"}`,
					`- Uncommitted Mutations: ${mutationCountVal} recorded in current session`,
				];
				if (lastV) {
					stateLines.push(
						`- Test Verification: ${lastV.passed ? "PASSED" : "FAILED"} (${lastV.command})${lastV.commitHash ? ` at commit ${lastV.commitHash.slice(0, 7)}` : ""}`,
					);
				}
				if (lastR) {
					stateLines.push(
						`- Secondary Review: ${lastR.passed ? "APPROVED" : "CHANGES REQUESTED"} by ${lastR.reviewer}`,
					);
				}
				let openFollowups: ReturnType<typeof listReviewFollowups> = [];
				try { openFollowups = followupStore ? listReviewFollowups(followupStore, "open", 8) : []; } catch {}
				if (openFollowups.length > 0) {
					stateLines.push(`- Open Review Follow-ups: ${openFollowups.length} local P2/P3 item(s)`);
					contextBlocks.push(`## Review Follow-ups\n${openFollowups.map((item) => `- [${item.severity}:${item.id.slice(0, 8)}] ${item.summary.slice(0, 300)}`).join("\n")}\nTreat these as durable technical debt: address relevant items when practical and resolve them explicitly after verification.`);
				}
				contextBlocks.push(stateLines.join("\n"));
				let projectKnowledge: ReturnType<typeof getRecentProjectMemory> = [];
				try {
					const candidates = (projectMemory ? getRecentProjectMemory(projectMemory, 8) : [])
						.filter((memory) => memory.source !== "portable");
					const freshness = await Promise.all(candidates.map((memory) => isProjectMemoryFreshAsync(memory, effectiveRoot)));
					projectKnowledge = candidates.filter((_, index) => freshness[index]);
				} catch {}
				if (projectKnowledge.length > 0) {
					const lines = projectKnowledge.map((memory) => `- [${memory.kind}:${memory.id.slice(0, 8)}] ${memory.content.slice(0, 300)}`);
					contextBlocks.push(`## Project Memory\n${lines.join("\n")}\nTreat these as historical project knowledge; verify against current repository state when relevant files have changed.`);
				}

				if (Array.isArray(output?.context)) {
					output.context.push(contextBlocks.join("\n\n"));
				}
			} catch {}
		},

		"shell.env": async (input, output) => {
			try {
				const env = (output as { env?: Record<string, string> }).env;
				if (env && typeof env === "object") {
					const scrubbed: string[] = [];
					for (const key of Object.keys(env)) {
						if (isSensitiveEnvKey(key) && env[key] !== "") {
							env[key] = "";
							scrubbed.push(key);
						}
					}
					if (scrubbed.length > 0) {
						try {
							await getSdkClient()?.app?.log?.({
								body: {
									service: "workflow-guard",
									level: "warn",
									message: `Scrubbed sensitive env vars: ${scrubbed.join(", ")}. Auth failures may be due to this.`,
								},
							});
						} catch {}
					}
				}
			} catch {}
		},

		"permission.ask": async (input, output) => {
			audit({
				ts: new Date().toISOString(),
				sessionID: input.sessionID,
				tool: "permission.ask",
				decision: output.status === "deny" ? "block" : "allow",
				input: {
					permissionID: input.id,
					type: input.type,
					pattern: input.pattern,
					status: output.status,
				},
			});
		},

		// Policy 24 (observability): claims-vs-evidence. When the assistant's final
		// text asserts completion or passing verification, compare the claim against
		// recorded verification evidence. A mismatch is journaled (not blocked) so
		// confident wrap-ups cannot silently contradict failing or stale state.
		"experimental.text.complete": async (input, output) => {
			try {
				const sessionID = input.sessionID;
				const text = typeof output.text === "string" ? output.text : "";
				const check = checkCompletionClaims(text, { sessionID });
				if (check.claimsCompletion && check.evidenceState && check.evidenceState !== "fresh-pass") {
					logObservation(ctx.client, `[workflow-guard] completion claim mismatch: ${check.reason}`);
					audit({
						ts: new Date().toISOString(),
						sessionID,
						tool: "experimental.text.complete",
						decision: "allow",
						reason: `Completion claim '${check.claim}' has ${check.evidenceState} verification evidence`,
						input: { claim: check.claim, evidenceState: check.evidenceState },
					});
				}
			} catch {}
		},

		// Keep tool descriptions honest: todowrite's description reflects lifecycle
		// and finalization gates so the model is not surprised by preventable blocks.
		"tool.definition": async (input, output) => {
			if (input.toolID !== "todowrite") return;
			const description = typeof output.description === "string" ? output.description : "";
			if (description.includes("verification evidence")) return;
			output.description =
				description +
				"\n\nWorkflow Guard lifecycle: each todowrite call replaces the complete task list. Preserve every pending/in_progress task in subsequent updates until you explicitly mark it completed or cancelled; do not omit active tasks when adding new work. Marking every task completed triggers the finalization gate - fresh verification evidence (test run) is required after the last mutation, and protected-branch/conflict checks apply.";
		},

		"chat.message": async (input) => {
			if (getProjectConfig(effectiveRoot).recoveryCheckpoints !== true) return;
			if (isGeneratedContinuationMessage(input.sessionID, input.messageID)) return;
			const parent = await runWithRuntimeState(effectiveRoot, ctx.client, () => fetchParentSession(input.sessionID));
			if (!parent.ok || parent.parentID) return;
			const run = nextRecoveryRun(effectiveRoot, input.sessionID);
			const checkpoint = createRecoveryCheckpoint(effectiveRoot, input.sessionID, run);
			if (checkpoint) toolLifecycle.setRecoveryRun(input.sessionID, run);
		},

		event: async ({
			event,
		}: { event: { type?: string; properties?: unknown } }) => {
			if (event?.type === "message.part.updated") {
				const outcome = toolOutcomes.record((event.properties as { part?: ToolOutcomePart })?.part ?? {});
				if (outcome) {
					audit({
						ts: new Date().toISOString(),
						sessionID: outcome.sessionID,
						callID: outcome.callID,
						tool: outcome.tool,
						decision: "allow",
						phase: "outcome",
						durationMs: outcome.durationMs,
						reason: outcome.status,
					});
					if (outcome.status === "error" && outcome.repeatedFailureCount === 3) {
						audit({
							ts: new Date().toISOString(),
							sessionID: outcome.sessionID,
							callID: outcome.callID,
							tool: outcome.tool,
							decision: "allow",
							phase: "event",
							reason: "repeated-equivalent-failure:3",
						});
						logObservation(ctx.client, `[workflow-guard] ${outcome.tool} failed equivalently 3 times in this session; change approach or inspect the underlying failure before retrying.`);
					}
				}
			}
			if (event?.type === "session.deleted") {
				const sessionID = (event.properties as { info?: { id?: unknown } })?.info?.id;
				if (typeof sessionID === "string") toolOutcomes.clearSession(sessionID);
			}
			if (event?.type === "session.idle") {
				const sessionID = (event.properties as { sessionID?: unknown })?.sessionID;
				if (typeof sessionID === "string") {
					releaseFileClaims(sessionID);
					clearReadFingerprints(sessionID);
					toolLifecycle.clearSession(sessionID);
					const recoveryRun = toolLifecycle.takeRecoveryRun(sessionID);
					if (recoveryRun !== undefined) {
						finalizeRecoveryCheckpoint(effectiveRoot, sessionID, recoveryRun);
					}
					const settleTitle = getProjectConfig(effectiveRoot).titleSettleWorkaround === true;
					await runWithRuntimeState(effectiveRoot, ctx.client, () => continueUnfinishedSession(sessionID, settleTitle));
				}
			}
			if (event?.type === "message.updated") {
				const info = (event.properties as { info?: { id?: unknown; role?: unknown; sessionID?: unknown } })?.info;
				if (info?.role === "user" && typeof info.sessionID === "string") {
					await runWithRuntimeState(effectiveRoot, ctx.client, () => {
						recordUserMessage(info.sessionID as string, typeof info.id === "string" ? info.id : undefined);
					});
				}
			}
			if (event?.type === "session.deleted") {
				const sessionID = (event.properties as { info?: { id?: unknown } })?.info?.id;
				if (typeof sessionID === "string") {
					releaseFileClaims(sessionID);
					clearReadFingerprints(sessionID);
					toolLifecycle.clearSession(sessionID);
					toolLifecycle.takeRecoveryRun(sessionID);
					await runWithRuntimeState(effectiveRoot, ctx.client, () => clearContinuationState(sessionID));
				}
			}
			if (
				event?.type === "command.executed" ||
				event?.type === "permission.updated" ||
				event?.type === "permission.replied" ||
				event?.type === "session.created"
			) {
				audit({
					ts: new Date().toISOString(),
					sessionID: (event.properties as { sessionID?: string })?.sessionID,
					tool: event.type ?? "event",
					decision:
						event.type === "permission.replied" &&
						/reject|deny/i.test(
							String((event.properties as { response?: unknown })?.response ?? ""),
						)
							? "block"
							: "allow",
					input: summarizeInput(event.properties),
				});
			}
		},
	};
};

// Default export MUST be a V1 PluginModule record.
export default {
	id: "workflow-guard",
	server: WorkflowGuard,
} satisfies PluginModule;
