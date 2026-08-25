/**
 * Workflow Guard Plugin for OpenCode (hooks-only - no prompt rules)
 *
 * Deterministic enforcement via the tool.execute.before plugin hook.
 * Throwing from the hook blocks the tool call outright.
 *
 * Orchestrator: imports policy modules from ./policies/ and engine services
 * from ./lib/, and re-exports the public helper surface for tests.
 */

import { tool, type Plugin, type PluginModule } from "@opencode-ai/plugin";
import type { LearningEvidenceKind } from "./lib/types.ts";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { join } from "node:path";
import { editTargets, runPostEditValidators, snapshotFile } from "./policies/post-edit-validation.ts";
import { claimFiles, releaseFileClaims } from "./policies/file-claims.ts";
import { beginReadObservation, clearReadFingerprints, recordSuccessfulRead, staleWriteReason } from "./policies/stale-write.ts";
import { ToolInvocationLifecycle } from "./lib/tool-lifecycle.ts";
import { guardToolCallImpl, isReadOnlyRole } from "./lib/guard-dispatcher.ts";
export { isReadOnlyRole } from "./lib/guard-dispatcher.ts";

// ── Types ────────────────────────────────────────────────────────────────────
export type {
	TodoItem,
	TodoSdkClient,
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
	lastVerify,
	getLastVerifyResult,
	recordMutation,
	recordVerifyResult,
	resetVerifyState,
	sessionMutationTimestamps,
	sessionVerifyResults,
	loadProjectConfig,
	getProjectConfig,
	reloadProjectConfig,
	stripJsonComments,
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
	dynamicShellSyntaxIn,
	getCleanEnv,
	showBlockToast,
	isSensitiveEnvKey,
} from "./lib/utils.ts";

export { getCleanEnv, dynamicShellSyntaxIn };

// ── Adaptive learning engine ─────────────────────────────────────────────────
import {
	loadLearnerProfile,
	recordLearningEvidence,
	selectLearningOpportunity,
	updateLearnerProfile,
} from "./lib/learning.ts";
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
	recordProjectMemory,
	searchProjectMemory,
	getRecentProjectMemory,
	recordReviewFollowup,
	listReviewFollowups,
	resolveReviewFollowup,
	exportProjectKnowledge,
	importProjectKnowledge,
} from "./lib/project-memory.ts";
import {
	exportProjectKnowledge,
	ensureProjectMemoryExcluded,
	getProjectMemoryIdentity,
	getRecentProjectMemory,
	importProjectKnowledge,
	isProjectMemoryFresh,
	listReviewFollowups,
	openProjectMemory,
	recordProjectMemory,
	recordReviewFollowup,
	resolveReviewFollowup,
	searchProjectMemory,
} from "./lib/project-memory.ts";

// ── Audit & durable verification cache ───────────────────────────────────────
import {
	getAuditFilePath,
	getVerifyCacheFilePath,
	persistVerifyCache,
	loadVerifyCache,
	getRecentAuditEntries,
	audit,
	logDecision,
	summarizeInput,
} from "./lib/audit.ts";

export { getAuditFilePath, getVerifyCacheFilePath, getVerifyHistoryFilePath, persistVerifyCache, loadVerifyCache, getRecentAuditEntries, getRecentVerifyHistory } from "./lib/audit.ts";
export { summarizeInput };

export function extractReviewFollowups(summary: string): Array<{ severity: "P2" | "P3"; summary: string }> {
	return summary.split(/\r?\n/).map((line) => ({
		line: line.trim(),
		severity: line.match(/(?:^|\s)(P[23])(?:\b|[:])/i)?.[1]?.toUpperCase() as "P2" | "P3" | undefined,
	})).filter((finding): finding is { line: string; severity: "P2" | "P3" } => Boolean(finding.line && finding.severity))
		.map((finding) => ({ severity: finding.severity, summary: finding.line }));
}

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
	effectiveTodoOwnerSessionID,
	hasActiveTodo,
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
	restoreRecoveryCheckpoint,
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
	sendDesktopNotification,
	escapeAppleScriptString,
} from "./policies/shell-safety.ts";

import { checkCompletionClaims } from "./policies/completion.ts";

export { checkCompletionClaims };

export { checkInteractiveTtyCommand, checkPackageHygiene, sendDesktopNotification, escapeAppleScriptString };

function logObservation(client: unknown, message: string): void {
	try {
		void (client as any)?.app?.log?.({
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
	try {
		sendDesktopNotification("Workflow Guard Blocked", message);
	} catch {}
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
		await (ctx.client as any)?.app?.log?.({
			body: {
				service: "workflow-guard",
				level: "info",
				message: `Workflow Guard plugin initialized for ${effectiveRoot}; ${managedConfigDiagnostic()}`,
			},
		});
	} catch {}

	const toolLifecycle = new ToolInvocationLifecycle();

	return {
		tool: {
			...(getProjectConfig(effectiveRoot).recoveryCheckpoints === true ? {
				guard_recovery_restore: tool({
					description: "Restore this root session's workspace to its pre-run recovery checkpoint. Refuses if the run has not gone idle or if the workspace changed after that boundary.",
					args: { run: tool.schema.number() },
					execute: async (args, toolContext) => {
						if (!Number.isInteger(args.run) || args.run < 1) return "[workflow-guard] Recovery rejected: run must be a positive integer.";
						const parent = await fetchParentSession(toolContext.sessionID);
						if (!parent.ok) return "[workflow-guard] Recovery rejected: could not confirm this is a root session.";
						if (parent.parentID) return "[workflow-guard] Recovery rejected: only root sessions can restore their checkpoints.";
						const result = restoreRecoveryCheckpoint(effectiveRoot, toolContext.sessionID, args.run);
						return result.ok
							? `[workflow-guard] Restored recovery checkpoint for run ${args.run}.`
							: `[workflow-guard] Recovery rejected: ${result.error}`;
					},
				}),
			} : {}),
			guard_next_tasks: tool({
				description:
					"Load durable repository task context when deciding what to work on next. Prefers TODO.md; if absent, discovers conventional roadmap, plan, tasks, backlog, and docs/plans Markdown files.",
				args: {},
				execute: async () => {
					const sources = discoverPlanningSources(effectiveRoot);
					return sources.length > 0
						? JSON.stringify({ sources }, null, 2)
						: JSON.stringify({ sources: [], message: "No TODO, roadmap, plan, tasks, or backlog Markdown files found." });
				},
			}),
			...(projectMemoryEnabled ? { project_memory_search: tool({
				description: "Search current durable knowledge for this project. Returns concise typed records with provenance; superseded records are excluded.",
				args: { query: tool.schema.string() },
				execute: async (args) => projectMemory ? JSON.stringify(args.query.length <= 500 ? searchProjectMemory(projectMemory, args.query, 8) : [], null, 2) : "[workflow-guard] Project memory unavailable; core guard enforcement remains active.",
			}),
			project_memory_record: tool({
				description: "Record a durable project fact, decision, constraint, or lesson when it will matter in future sessions. Do not record transient tool output, secrets, or speculative hypotheses.",
				args: {
					kind: tool.schema.string().describe("fact, decision, constraint, or lesson"),
					content: tool.schema.string(),
					paths: tool.schema.array(tool.schema.string()),
					supersedes: tool.schema.string().optional(),
				},
				execute: async (args, toolContext) => {
					if (!projectMemory) return "[workflow-guard] Project memory unavailable; core guard enforcement remains active.";
					if (!(["fact", "decision", "constraint", "lesson"] as string[]).includes(args.kind)) return "[workflow-guard] Project memory rejected: invalid kind.";
					const detectedSecret = secretIn(args.content);
					if (detectedSecret) return `[workflow-guard] Project memory rejected: possible secret detected (${detectedSecret}).`;
					const record = recordProjectMemory(projectMemory, {
						kind: args.kind as "fact" | "decision" | "constraint" | "lesson",
						content: args.content,
						source: "agent",
						sessionID: toolContext.sessionID,
						commit: getCurrentGitCommitHash(effectiveRoot),
						paths: args.paths,
						supersedes: args.supersedes || undefined,
					});
					return JSON.stringify(record);
				},
			}),
			project_memory_export: tool({
				description: "Explicitly promote selected durable project-memory records to the human-readable repo-local .opencode/memory/project-memory.jsonl file. Nothing is exported automatically.",
				args: { ids: tool.schema.array(tool.schema.string()) },
				execute: async (args) => {
					if (!projectMemory) return "[workflow-guard] Project memory unavailable; core guard enforcement remains active.";
					if (args.ids.length > 100 || args.ids.some((id) => id.length > 200)) return "[workflow-guard] Project memory export rejected: invalid record IDs.";
					const count = exportProjectKnowledge(projectMemory, args.ids, portableMemoryPath, (content) => secretIn(content) !== undefined);
					return `[workflow-guard] Exported ${count} project-memory record(s) to .opencode/memory/project-memory.jsonl.`;
				},
			}),
			project_memory_import: tool({
				description: "Import the fixed repo-local .opencode/memory/project-memory.jsonl file into this project's local working-memory index.",
				args: {},
				execute: async () => projectMemory ? `[workflow-guard] Imported ${importProjectKnowledge(projectMemory, portableMemoryPath, (content) => secretIn(content) !== undefined)} new project-memory record(s).` : "[workflow-guard] Project memory unavailable; core guard enforcement remains active.",
			}) } : {}),
			...(learningEnabled ? {
				learning_profile: tool({
					description: "Inspect the local evidence-based learner profile so teaching can build on demonstrated knowledge without assuming unobserved concepts are gaps.",
					args: {},
					execute: async () => JSON.stringify(loadLearnerProfile(), null, 2),
				}),
				learning_checkpoint: tool({
					description: "At a high-value design decision, debugging moment, or important new concept, rank candidate Socratic learning opportunities. If one is selected, ask one concise question before continuing the work; do not turn routine syntax into a lesson.",
					args: {
						opportunities: tool.schema.array(tool.schema.object({
							type: tool.schema.string().describe("design, debugging, or new-concept"),
							concept: tool.schema.string().describe("Transferable engineering concept"),
							relevance: tool.schema.number().describe("Current-task relevance from 0 to 1"),
							consequence: tool.schema.number().describe("Decision consequence from 0 to 1"),
						})),
					},
					execute: async (args, toolContext) => {
						const valid = args.opportunities.slice(0, 20).filter((candidate): candidate is typeof candidate & { type: "design" | "debugging" | "new-concept" } =>
							(candidate.type === "design" || candidate.type === "debugging" || candidate.type === "new-concept") &&
							candidate.concept.length > 0 && candidate.concept.length <= 100 &&
							candidate.relevance >= 0 && candidate.relevance <= 1 && candidate.consequence >= 0 && candidate.consequence <= 1,
						);
						const used = learningInterventions.get(toolContext.sessionID) ?? 0;
						const selected = selectLearningOpportunity(loadLearnerProfile(), valid, {
							interventionsThisSession: used,
							maxInterventionsPerSession: getLearningInterventionBudget(effectiveRoot),
						});
						if (!selected) return JSON.stringify({ intervene: false, reason: "No opportunity selected or session learning budget reached." });
						learningInterventions.set(toolContext.sessionID, used + 1);
						return JSON.stringify({ intervene: true, opportunity: selected, guidance: "Ask one question, use the answer as task context, briefly reconcile if useful, then continue building." });
					},
				}),
				learning_record: tool({
					description: "Record concise evidence from a real Socratic interaction after observing the learner's reasoning. Record what was demonstrated, not a grade or an inferred deficit.",
					args: {
						concept: tool.schema.string(),
						kind: tool.schema.string().describe("exposed, developing, demonstrated, independent, critique, or needs-reinforcement"),
						summary: tool.schema.string().describe("Short factual description of observed reasoning"),
					},
					execute: async (args, toolContext) => {
						const validKinds = new Set(["exposed", "developing", "demonstrated", "independent", "critique", "needs-reinforcement"]);
						if (!validKinds.has(args.kind)) return "[workflow-guard] Learning evidence rejected: invalid evidence kind.";
						if (args.concept.length < 1 || args.concept.length > 100 || args.summary.length < 1 || args.summary.length > 1000) {
							return "[workflow-guard] Learning evidence rejected: concept must be 1-100 characters and summary 1-1000 characters.";
						}
						try {
							updateLearnerProfile((profile) => {
								if (!profile.concepts[args.concept] && Object.keys(profile.concepts).length >= 500) {
									throw new Error("concept-limit");
								}
								recordLearningEvidence(profile, {
									concept: args.concept,
									kind: args.kind as LearningEvidenceKind,
									summary: args.summary,
									timestamp: Date.now(),
									sessionID: toolContext.sessionID,
									project: effectiveRoot,
								});
							});
						} catch (error) {
							if ((error as Error).message === "concept-limit") {
								return "[workflow-guard] Learning evidence rejected: learner profile concept limit reached.";
							}
							throw error;
						}
						return `[workflow-guard] Learning evidence recorded for ${args.concept}.`;
					},
				}),
			} : {}),
			guard_status: tool({
				description:
					"Inspect active guardrails, current branch protection, and verification/review status.",
				args: {},
				execute: async () => {
					const root = getWorkspaceRoot();
					const branch = currentGitBranch(root) ?? "unknown";
					const isProtected = onProtectedBranch(root);
					const lastV = getLastVerifyResult();
					const lastR = getLastReviewResult();
					const lastMut = getLastMutationTimestamp();
					const cfg = loadProjectConfig(root);
					return JSON.stringify(
						{
							workspaceRoot: root,
							branch,
							onProtectedBranch: isProtected,
							lastMutationTimestamp: lastMut,
							mutationCount: getMutationCount(),
							lastVerify: lastV
								? {
										command: lastV.command,
										passed: lastV.passed,
										fresh: lastV.timestamp >= lastMut,
										commitHash: lastV.commitHash,
									}
								: null,
							lastReview: lastR
								? {
										reviewer: lastR.reviewer,
										passed: lastR.passed,
										summary: lastR.summary,
									}
								: null,
							projectConfig: {
								protectedBranches: cfg.protectedBranches ?? ["main", "master"],
								verifyCommand: detectVerifyCommand(root) ?? null,
								requireReview: isReviewRequired(root),
								requireDocumentation: isDocumentationRequired(root),
							},
						},
						null,
						2,
					);
				},
			}),
			guard_audit: tool({
				description:
					"View recent audit entries recorded by opencode-workflow-guard.",
				args: {
					limit: tool.schema
						.number()
						.optional()
						.describe("Maximum entries to return (default 10)"),
				},
				execute: async (args) => {
					const limit =
						typeof args?.limit === "number" ? Math.min(args.limit, 50) : 10;
					return JSON.stringify(getRecentAuditEntries(limit), null, 2);
				},
			}),
			guard_why: tool({
				description:
					"Simulate and explain whether a specific tool call or command would be blocked by guardrails.",
				args: {
					tool: tool.schema
						.string()
						.describe("Tool name (e.g. bash, edit, write, read, apply_patch)"),
					input: tool.schema
						.record(tool.schema.string(), tool.schema.any())
						.optional()
						.describe("Tool input arguments"),
				},
				execute: async (args) => {
					const reason = await guardToolCallImpl(args.tool, args.input ?? {});
					return reason
						? `BLOCKED: ${reason}`
						: "ALLOWED: Satisfies all current guardrails.";
				},
			}),
			record_review: tool({
				description:
					"Record a secondary reviewer agent's approval or critique of the current changes. The summary must reference the 5 core review axes from guard_review_rubric.",
				args: {
					reviewer: tool.schema
						.string()
						.describe("Identifier/name of the reviewer subagent"),
					summary: tool.schema
						.string()
						.describe("Review findings summary across the 5 core review axes"),
					passed: tool.schema
						.boolean()
						.describe("True if change is approved, false if changes requested"),
				},
				execute: async (args, toolContext) => {
					const parentSessionID = await fetchParentSessionID(toolContext.sessionID);
					if (!parentSessionID) {
						return "[workflow-guard] Review rejected: record_review must be called from a secondary/subagent session.";
					}
					// The rubric is the contract: a recorded review must demonstrate it
					// was evaluated against the 5 axes, not just assert a verdict.
					const axesRefs = [
						"test integrity",
						"task completeness",
						"cleanliness",
						"security",
						"platform",
					];
					const summaryLower = args.summary.toLowerCase();
					const referenced = axesRefs.filter((axis) => summaryLower.includes(axis));
					if (referenced.length < 3) {
						return (
							`[workflow-guard] Review rejected: summary must reference the review axes ` +
							`(found ${referenced.length}/5). Call guard_review_rubric to get the rubric, ` +
							`evaluate each axis, and include findings per axis in the summary.`
						);
					}
					if (args.passed) {
						if (/(?:^|\s)(?:\[p[01]\]|p[01]\s*:\s*(?:blocker|defect|vulnerability|error|bug|issue)|p[01]\s+blocker)/i.test(args.summary)) {
							return (
								"[workflow-guard] Review rejected: cannot record approval when P0 or P1 blockers are flagged in findings. " +
								"Resolve all P0/P1 issues before approving or record review with passed=false."
							);
						}
					}
					recordReviewResult(
						args.reviewer,
						args.summary,
						args.passed,
						parentSessionID,
						toolContext.worktree || toolContext.directory,
					);
					if (followupStore && !secretIn(args.summary)) {
						const findings = extractReviewFollowups(args.summary);
						for (const finding of findings) {
							recordReviewFollowup(followupStore, {
								severity: finding.severity,
								summary: finding.summary,
								reviewer: args.reviewer,
								sessionID: toolContext.sessionID,
								commit: getCurrentGitCommitHash(effectiveRoot),
							});
						}
					}
					return args.passed
						? `[workflow-guard] Review recorded as APPROVED by ${args.reviewer}.`
						: `[workflow-guard] Review recorded as CHANGES REQUESTED by ${args.reviewer}.`;
				},
			}),
			guard_review_followups: tool({
				description: "List durable local P2/P3 review follow-ups for this project. Open findings are technical debt that should be addressed rather than indefinitely deferred.",
				args: {},
				execute: async () => JSON.stringify(followupStore ? listReviewFollowups(followupStore) : [], null, 2),
			}),
			guard_review_followup_resolve: tool({
				description: "Resolve a durable local review follow-up after the underlying issue has been fixed and verified.",
				args: { id: tool.schema.string() },
				execute: async (args) => followupStore && resolveReviewFollowup(followupStore, args.id)
					? `[workflow-guard] Review follow-up ${args.id} resolved.`
					: `[workflow-guard] Review follow-up ${args.id} was not open or was not found.`,
			}),
			guard_review_rubric: tool({
				description:
					"Get the secondary-review rubric for the current branch diff. The orchestrator calls this, spawns a reviewer subagent with the rubric as the prompt, then the reviewer records its verdict via record_review.",
				args: {
					base: tool.schema
						.string()
						.optional()
						.describe("Base ref to diff against (default: origin/main, origin/master, main)"),
				},
				execute: async (args) => {
					const sanitizedBase =
						typeof args.base === "string" &&
						!args.base.startsWith("-") &&
						!/[\s;'"\0]/.test(args.base)
							? args.base
							: undefined;
					const bases = sanitizedBase
						? [sanitizedBase]
						: ["origin/main", "origin/master", "main", "master"];
					let diffText = "";
					for (const base of bases) {
						const res = spawnSync(
							"git",
							["diff", "--", `${base}...HEAD`],
							{ cwd: getWorkspaceRoot(), encoding: "utf8", timeout: 10_000 },
						);
						if (res.status === 0 && res.stdout.trim()) {
							diffText = res.stdout;
							break;
						}
					}
					if (!diffText) {
						const last = spawnSync("git", ["diff", "--", "HEAD~1"], {
							cwd: getWorkspaceRoot(),
							encoding: "utf8",
							timeout: 10_000,
						});
						diffText = last.status === 0 ? last.stdout : "(no diff available)";
					}
					return buildReviewRubric(diffText);
				},
			}),
			guard_worktree_create: tool({
				description:
					"Create an isolated git worktree directory for concurrent subagent execution.",
				args: {
					branch: tool.schema
						.string()
						.describe("Branch name for the isolated worktree (e.g. 'feat/subagent-task')"),
					baseBranch: tool.schema
						.string()
						.optional()
						.describe("Base branch to branch off of (defaults to HEAD)"),
				},
				execute: async (args, toolContext) => {
					const todos = await effectiveTodos(toolContext.sessionID);
					if (todos !== undefined && !hasActiveTodo(todos)) {
						return (
							"[workflow-guard] Blocked: worktree creation with no active todo item. " +
							"Break the request down with todowrite first, then create worktrees."
						);
					}
					const toolRoot = toolContext.worktree || toolContext.directory || effectiveRoot;
					const res = createGitWorktree(args.branch, args.baseBranch ?? "HEAD", toolRoot);
					if (!res.success) {
						return `[workflow-guard] Failed to create worktree: ${res.error}`;
					}
					recordMutation(
						(await effectiveTodoOwnerSessionID(toolContext.sessionID)) ?? toolContext.sessionID,
					);
					return (
						`[workflow-guard] Worktree created successfully at: ${res.worktreePath}\n` +
						`Run subagent tasks or pass worktree directory context to isolate file mutations.`
					);
				},
			}),
			guard_worktree_cleanup: tool({
				description:
					"Commit a final snapshot and remove an isolated git worktree directory.",
				args: {
					worktreePath: tool.schema
						.string()
						.describe("Path of the worktree directory to clean up"),
				},
				execute: async (args, toolContext) => {
					const todos = await effectiveTodos(toolContext.sessionID);
					if (todos !== undefined && !hasActiveTodo(todos)) {
						return (
							"[workflow-guard] Blocked: worktree cleanup with no active todo item. " +
							"Break the request down with todowrite first, then clean up worktrees."
						);
					}
					const toolRoot = toolContext.worktree || toolContext.directory || effectiveRoot;
					const res = cleanupGitWorktree(args.worktreePath, toolRoot);
					if (!res.success) {
						return `[workflow-guard] Failed to clean up worktree: ${res.error}`;
					}
					recordMutation(
						(await effectiveTodoOwnerSessionID(toolContext.sessionID)) ?? toolContext.sessionID,
					);
					return `[workflow-guard] Worktree at '${args.worktreePath}' cleaned up successfully.`;
				},
			}),
		},

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
			audit({
				ts: new Date().toISOString(),
				sessionID: input.sessionID,
				callID: input.callID,
				tool: input.tool,
				decision: "allow",
				phase: "outcome",
				durationMs: startedAt === undefined ? undefined : Date.now() - startedAt,
			});
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
				const isProtected = onProtectedBranch(effectiveRoot);
				const lastV = sessionID
					? (sessionVerifyResults.get(sessionID) ?? lastVerify)
					: lastVerify;
				const lastR = getLastReviewResult();
				const mutationCountVal = getMutationCount(sessionID);

				const contextBlocks: string[] = [];

				if (active && active.length > 0) {
					const lines = active.map(
						(t) =>
							`- [${String(t.status) === "in_progress" ? "IN PROGRESS" : "PENDING"}] ${String(t.content ?? "")}`,
					);
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
				const openFollowups = followupStore ? listReviewFollowups(followupStore, "open", 8) : [];
				if (openFollowups.length > 0) {
					stateLines.push(`- Open Review Follow-ups: ${openFollowups.length} local P2/P3 item(s)`);
					contextBlocks.push(`## Review Follow-ups\n${openFollowups.map((item) => `- [${item.severity}:${item.id.slice(0, 8)}] ${item.summary.slice(0, 300)}`).join("\n")}\nTreat these as durable technical debt: address relevant items when practical and resolve them explicitly after verification.`);
				}
				contextBlocks.push(stateLines.join("\n"));
				const projectKnowledge = (projectMemory ? getRecentProjectMemory(projectMemory, 20) : [])
					.filter((memory) => memory.source !== "portable" && isProjectMemoryFresh(memory, effectiveRoot))
					.slice(0, 8);
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
							await (getSdkClient() as any)?.app?.log?.({
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
					await runWithRuntimeState(effectiveRoot, ctx.client, () => continueUnfinishedSession(sessionID));
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
