import { tool } from "@opencode-ai/plugin";
import { spawnSync } from "node:child_process";
import type { AuditEntry, LearningEvidenceKind } from "./types.ts";
import type { ProjectMemoryStore } from "./project-memory.ts";
import {
	exportProjectKnowledge,
	importProjectKnowledge,
	listReviewFollowups,
	recordProjectMemory,
	recordReviewFollowup,
	resolveReviewFollowup,
	searchProjectMemory,
} from "./project-memory.ts";
import { loadLearnerProfile, recordLearningEvidence, selectLearningOpportunity, updateLearnerProfile } from "./learning.ts";
import { isEvidenceFresh, reviewEvidence, verificationEvidence } from "./evidence.ts";
import {
	getLearningInterventionBudget,
	getOperationProfile,
	getProjectConfig,
	getRalphMaxIterations,
	getLastReviewResultForWorkspace,
	getLastVerifyResultForWorkspace,
	getWorkspaceMutationCount,
	getWorkspaceMutationTimestamp,
	getWorkspaceRoot,
	isDocumentationRequired,
	isRecoveryCheckpointsEnabled,
	isRalphModeEnabled,
	isReviewRequired,
	recordMutation,
	recordReviewResult,
	resolveEffectiveWorkspace,
	runWithRuntimeState,
} from "./state.ts";
import { getRalphOutcome } from "../policies/continuation.ts";
import { loadProjectConfig, projectRootKey } from "./project-config.ts";
import { detectVerifyCommand, getCurrentGitCommitHash, getGitWorktreeFingerprint, getTrackedWorktreeFingerprint } from "./verify.ts";
import { buildReviewRubric } from "./review.ts";
import { createGitWorktree, cleanupGitWorktree } from "./worktree.ts";
import { branchHasDocumentationChange } from "../policies/docs.ts";
import { restoreRecoveryCheckpoint } from "./checkpoint.ts";
import { audit, getRecentAuditEntries } from "./audit.ts";
import { guardToolCallImpl } from "./guard-dispatcher.ts";
import { discoverPlanningSources } from "../policies/planning.ts";
import { secretIn } from "../policies/secrets.ts";
import { currentGitBranch, onProtectedBranch } from "../policies/git.ts";
import { effectiveTodoOwnerSessionID, effectiveTodos, fetchParentSession, fetchParentSessionID, hasActiveTodo } from "../policies/todo.ts";

export function extractReviewFollowups(summary: string): Array<{ severity: "P2" | "P3"; summary: string }> {
	return summary.split(/\r?\n/).map((line) => {
		const trimmed = line.trim();
		const match = trimmed.match(/(?:^|\s)(P[23])(?:\b|[:])/i);
		const severity = match?.[1]?.toUpperCase() as "P2" | "P3" | undefined;
		return { line: trimmed, severity };
	}).filter((finding): finding is { line: string; severity: "P2" | "P3" } => {
		if (!finding.line || !finding.severity) return false;
		const rest = finding.line.replace(new RegExp(`^.*?(?:${finding.severity})\\s*[:\\-]?\\s*`, "i"), "").trim();
		if (!rest || /^(?:none|nil|n\/?a|0|zero|no\s+(?:issues|findings|defects|items|blockers)|clean|passed|ok|none\s+identified)\b/i.test(rest)) {
			return false;
		}
		return true;
	}).map((finding) => ({ severity: finding.severity, summary: finding.line }));
}

export function buildWorkflowGuardSystemGuidance(options: {
	projectMemoryEnabled?: boolean;
	learningEnabled?: boolean;
	recoveryCheckpointsEnabled?: boolean;
	isReadOnly?: boolean;
}): string {
	const sections: string[] = [
		"## Workflow Guard & Operational Tools",
		"Workflow Guard enforces safe engineering discipline and provides proactive workflow tools:",
		"- Task Planning: Proactively call `guard_next_tasks` at session start or when planning work to discover repository roadmap, plan, and TODO items. Check `guard_status` to inspect branch protection, mutation count, and outstanding verification/review gates.",
	];

	if (!options.isReadOnly) {
		sections.push(
			"- Review & Verification: Before completing tasks or creating PRs, run tests to produce fresh verification evidence, retrieve the review rubric via `guard_review_rubric` (5 core axes: test integrity, task completeness, cleanliness, security, platform), and spawn a reviewer subagent via `task` that records its verdict with `record_review`.",
			"- Worktree Isolation: When orchestrating parallel subagent tasks with `task`, call `guard_worktree_create` to prevent concurrent file conflicts, and `guard_worktree_cleanup` when finished.",
		);
	}

	sections.push(
		"- Technical Debt: Inspect open P2/P3 review follow-ups with `guard_review_followups` during planning; resolve fixed items with `guard_review_followup_resolve`.",
		"- Policy Simulation: If uncertain whether a command or file edit is permitted, simulate it with `guard_why`.",
	);

	if (options.projectMemoryEnabled) {
		sections.push(
			"- Project Memory: Proactively call `project_memory_search` before architectural changes or complex implementations. Record durable lessons, architectural decisions, and repo constraints with `project_memory_record`.",
		);
	}

	if (options.learningEnabled) {
		sections.push(
			"- Socratic Learning: When facing non-trivial architectural trade-offs, design choices, or debugging breakthroughs, call `learning_checkpoint`. If selected (intervene: true), ask one concise question via `question` before proceeding, and capture observed understanding with `learning_record`.",
		);
	}

	if (options.recoveryCheckpointsEnabled) {
		sections.push(
			"- Recovery: If workspace state needs rollback to the pre-run checkpoint, use `guard_recovery_restore`.",
		);
	}

	return sections.join("\n");
}

export function createCustomTools(options: {
	effectiveRoot: string;
	projectMemoryEnabled: boolean;
	learningEnabled: boolean;
	projectMemory: ProjectMemoryStore | undefined;
	followupStore: ProjectMemoryStore | undefined;
	portableMemoryPath: string;
	learningInterventions: Map<string, number>;
	client: unknown;
}) {
	const { effectiveRoot, projectMemoryEnabled, learningEnabled, projectMemory, followupStore, portableMemoryPath, learningInterventions, client } = options;
	return {
		...(isRecoveryCheckpointsEnabled(effectiveRoot) ? {
			guard_recovery_restore: tool({
				description: "Restore this root session's workspace to its pre-run recovery checkpoint. Refuses if the run has not gone idle or if the workspace changed after that boundary.",
				args: { run: tool.schema.number() },
				execute: async (args, toolContext) => {
					if (!Number.isInteger(args.run) || args.run < 1) return "[workflow-guard] Recovery rejected: run must be a positive integer.";
					const parent = await fetchParentSession(toolContext.sessionID);
					if (!parent.ok) return "[workflow-guard] Recovery rejected: could not confirm this is a root session.";
					if (parent.parentID) return "[workflow-guard] Recovery rejected: only root sessions can restore their checkpoints.";
					const result = restoreRecoveryCheckpoint(effectiveRoot, toolContext.sessionID, args.run);
					return result.ok ? `[workflow-guard] Restored recovery checkpoint for run ${args.run}.` : `[workflow-guard] Recovery rejected: ${result.error}`;
				},
			}),
		} : {}),
		guard_next_tasks: tool({
			description: "Load durable repository task context when deciding what to work on next or planning upcoming steps. Proactively call at session start or during planning to discover roadmap, plan, tasks, backlog, and TODO.md files.",
			args: {},
			execute: async () => {
				const sources = discoverPlanningSources(effectiveRoot);
				return sources.length > 0 ? JSON.stringify({ sources }, null, 2) : JSON.stringify({ sources: [], message: "No TODO, roadmap, plan, tasks, or backlog Markdown files found." });
			},
		}),
		...(projectMemoryEnabled ? {
			project_memory_search: tool({
				description: "Search current durable knowledge for this project, including past architectural decisions, constraints, and conventions. Proactively call before starting complex architectural changes, refactors, or new feature implementations.",
				args: { query: tool.schema.string() },
				execute: async (args) => projectMemory ? JSON.stringify(args.query.length <= 500 ? searchProjectMemory(projectMemory, args.query, 8) : [], null, 2) : "[workflow-guard] Project memory unavailable; core guard enforcement remains active.",
			}),
			project_memory_record: tool({
				description: "Record a durable project fact, decision, constraint, or lesson when it will matter in future sessions. Proactively call after making important architectural choices, discovering tricky repo constraints, or establishing new patterns.",
				args: { kind: tool.schema.string().describe("fact, decision, constraint, or lesson"), content: tool.schema.string(), paths: tool.schema.array(tool.schema.string()), supersedes: tool.schema.string().optional() },
				execute: async (args, toolContext) => {
					if (!projectMemory) return "[workflow-guard] Project memory unavailable; core guard enforcement remains active.";
					if (!(["fact", "decision", "constraint", "lesson"] as string[]).includes(args.kind)) return "[workflow-guard] Project memory rejected: invalid kind.";
					const detectedSecret = secretIn(args.content);
					if (detectedSecret) return `[workflow-guard] Project memory rejected: possible secret detected (${detectedSecret}).`;
					return JSON.stringify(recordProjectMemory(projectMemory, { kind: args.kind as "fact" | "decision" | "constraint" | "lesson", content: args.content, source: "agent", sessionID: toolContext.sessionID, commit: getCurrentGitCommitHash(effectiveRoot), paths: args.paths, supersedes: args.supersedes || undefined }));
				},
			}),
			project_memory_export: tool({
				description: "Explicitly promote selected durable project-memory records to the human-readable repo-local .opencode/memory/project-memory.jsonl file. Call when durable knowledge should be committed and shared with the team.",
				args: { ids: tool.schema.array(tool.schema.string()) },
				execute: async (args) => {
					if (!projectMemory) return "[workflow-guard] Project memory unavailable; core guard enforcement remains active.";
					if (args.ids.length > 100 || args.ids.some((id) => id.length > 200)) return "[workflow-guard] Project memory export rejected: invalid record IDs.";
					const count = exportProjectKnowledge(projectMemory, args.ids, portableMemoryPath, (content) => secretIn(content) !== undefined);
					return `[workflow-guard] Exported ${count} project-memory record(s) to .opencode/memory/project-memory.jsonl.`;
				},
			}),
			project_memory_import: tool({ description: "Import the repo-local .opencode/memory/project-memory.jsonl file into this project's local working-memory index. Call to synchronize local project memory with shared repository records.", args: {}, execute: async () => projectMemory ? `[workflow-guard] Imported ${importProjectKnowledge(projectMemory, portableMemoryPath, (content) => secretIn(content) !== undefined)} new project-memory record(s).` : "[workflow-guard] Project memory unavailable; core guard enforcement remains active." }),
		} : {}),
		...(learningEnabled ? {
			learning_profile: tool({ description: "Inspect the local evidence-based learner profile so explanations and teaching can build on demonstrated knowledge without assuming unobserved concepts are gaps.", args: {}, execute: async () => JSON.stringify(loadLearnerProfile(), null, 2) }),
			learning_checkpoint: tool({
				description: "At a high-value design decision, debugging moment, or important new concept, rank candidate Socratic learning opportunities. Proactively call when encountering non-trivial architectural trade-offs, design choices, or tricky bugs. If selected (intervene: true), ask one concise question via question before continuing; do not turn routine syntax into a lesson.",
				args: { opportunities: tool.schema.array(tool.schema.object({ type: tool.schema.string().describe("design, debugging, or new-concept"), concept: tool.schema.string().describe("Transferable engineering concept"), relevance: tool.schema.number().describe("Current-task relevance from 0 to 1"), consequence: tool.schema.number().describe("Decision consequence from 0 to 1") })) },
				execute: async (args, toolContext) => {
					const valid = args.opportunities.slice(0, 20).filter((candidate): candidate is typeof candidate & { type: "design" | "debugging" | "new-concept" } => (candidate.type === "design" || candidate.type === "debugging" || candidate.type === "new-concept") && candidate.concept.length > 0 && candidate.concept.length <= 100 && candidate.relevance >= 0 && candidate.relevance <= 1 && candidate.consequence >= 0 && candidate.consequence <= 1);
					const used = learningInterventions.get(toolContext.sessionID) ?? 0;
					const selected = selectLearningOpportunity(loadLearnerProfile(), valid, { interventionsThisSession: used, maxInterventionsPerSession: getLearningInterventionBudget(effectiveRoot) });
					if (!selected) return JSON.stringify({ intervene: false, reason: "No opportunity selected or session learning budget reached." });
					learningInterventions.set(toolContext.sessionID, used + 1);
					return JSON.stringify({ intervene: true, opportunity: selected, guidance: "Ask one question, use the answer as task context, briefly reconcile if useful, then continue building." });
				},
			}),
			learning_record: tool({
				description: "Record concise evidence from a real Socratic interaction after observing the learner's reasoning and response to a learning checkpoint question. Record what was demonstrated, not a grade or an inferred deficit.",
				args: { concept: tool.schema.string(), kind: tool.schema.string().describe("exposed, developing, demonstrated, independent, critique, or needs-reinforcement"), summary: tool.schema.string().describe("Short factual description of observed reasoning") },
				execute: async (args, toolContext) => {
					const validKinds = new Set(["exposed", "developing", "demonstrated", "independent", "critique", "needs-reinforcement"]);
					if (!validKinds.has(args.kind)) return "[workflow-guard] Learning evidence rejected: invalid evidence kind.";
					if (args.concept.length < 1 || args.concept.length > 100 || args.summary.length < 1 || args.summary.length > 1000) return "[workflow-guard] Learning evidence rejected: concept must be 1-100 characters and summary 1-1000 characters.";
					try {
						updateLearnerProfile((profile) => {
							if (!profile.concepts[args.concept] && Object.keys(profile.concepts).length >= 500) throw new Error("concept-limit");
							recordLearningEvidence(profile, { concept: args.concept, kind: args.kind as LearningEvidenceKind, summary: args.summary, timestamp: Date.now(), sessionID: toolContext.sessionID, project: effectiveRoot });
						});
					} catch (error) {
						if ((error as Error).message === "concept-limit") return "[workflow-guard] Learning evidence rejected: learner profile concept limit reached.";
						throw error;
					}
					return `[workflow-guard] Learning evidence recorded for ${args.concept}.`;
				},
			}),
		} : {}),
		guard_status: tool({
			description: "Inspect active guardrails, current branch protection, mutation count, outstanding verification/review requirements, and ralph status. Proactively call at session start and before completing tasks or creating PRs.",
			args: {
				directory: tool.schema.string().optional().describe("Target repository directory to inspect (defaults to active session directory or workspace root)"),
			},
			execute: async (args, toolContext) => {
				const root = await resolveEffectiveWorkspace({ sessionID: toolContext.sessionID, directory: args?.directory, fallback: toolContext.worktree || toolContext.directory || effectiveRoot });
				const branch = currentGitBranch(root) ?? "unknown"; const isProtected = onProtectedBranch(root); const lastV = getLastVerifyResultForWorkspace(root); const lastR = getLastReviewResultForWorkspace(root); const lastMut = getWorkspaceMutationTimestamp(root); const cfg = loadProjectConfig(root);
				const subject = { workspace: projectRootKey(root), commitHash: getCurrentGitCommitHash(root), worktreeFingerprint: getGitWorktreeFingerprint(root) };
				const verifyEvidence = lastV ? verificationEvidence(lastV) : undefined;
				const reviewEvidenceRecord = lastR ? reviewEvidence(lastR) : undefined;
				const verifyCommand = detectVerifyCommand(root);
				const verifyFresh = Boolean(lastV && verifyEvidence && lastV.passed && lastV.command === verifyCommand && isEvidenceFresh(verifyEvidence, subject, lastMut));
				const reviewRequired = isReviewRequired(root);
				// Review freshness is content-scoped, matching the PR preflight:
				// the approval covers the tracked tree it reviewed, so it stays
				// fresh until that content changes. Untracked scratch cleanup
				// (or mutations in a sibling worktree) must not read as stale,
				// while any tracked edit or new commit does.
				const reviewFresh = Boolean(lastR && reviewEvidenceRecord && lastR.passed && isEvidenceFresh(reviewEvidenceRecord, { ...subject, worktreeFingerprint: getTrackedWorktreeFingerprint(root), sessionID: lastR.targetSessionID }, 0));
				const documentationRequired = isDocumentationRequired(root);
				const outstandingRequirements = [
					...(verifyCommand && !verifyFresh ? ["verification"] : []),
					...(reviewRequired && !reviewFresh ? ["review"] : []),
					...(documentationRequired && !branchHasDocumentationChange(root) ? ["documentation"] : []),
				];
				const recommendedActions: string[] = [];
				if (outstandingRequirements.includes("verification")) {
					recommendedActions.push(verifyCommand ? `Execute test verification command '${verifyCommand}' to produce fresh verification evidence.` : "Run project tests to establish fresh verification evidence.");
				}
				if (outstandingRequirements.includes("review")) {
					recommendedActions.push("Call guard_review_rubric to retrieve the 5-axis review rubric, then spawn a secondary reviewer subagent via task to evaluate changes and record verdict with record_review.");
				}
				if (outstandingRequirements.includes("documentation")) {
					recommendedActions.push("Update documentation files (e.g. README.md, docs/) to satisfy the documentation gate before opening a PR.");
				}
				let openFollowupsCount = 0;
				try { openFollowupsCount = followupStore ? listReviewFollowups(followupStore, "open", 10).length : 0; } catch {}
				if (openFollowupsCount > 0) {
					recommendedActions.push(`Inspect ${openFollowupsCount} open P2/P3 review follow-up(s) with guard_review_followups and resolve with guard_review_followup_resolve once addressed.`);
				}
				if (recommendedActions.length === 0) {
					recommendedActions.push("All operational requirements are satisfied for task finalization and PR creation.");
				}
				const ralphOutcome = runWithRuntimeState(root, client, () => getRalphOutcome(toolContext.sessionID));
				return JSON.stringify({ workspaceRoot: root, branch, onProtectedBranch: isProtected, outstandingRequirements, recommendedActions, lastMutationTimestamp: lastMut, mutationCount: getWorkspaceMutationCount(root), lastVerify: lastV && verifyEvidence ? { command: lastV.command, passed: lastV.passed, fresh: verifyFresh, evidenceId: verifyEvidence.id, commitHash: lastV.commitHash } : null, lastReview: lastR && reviewEvidenceRecord ? { reviewer: lastR.reviewer, passed: lastR.passed, summary: lastR.summary, fresh: reviewFresh, evidenceId: reviewEvidenceRecord.id } : null, ralph: { enabled: isRalphModeEnabled(root), maxIterations: getRalphMaxIterations(root), outcome: ralphOutcome ?? null }, projectConfig: { profile: getOperationProfile(root), protectedBranches: cfg.protectedBranches ?? ["main", "master"], verifyCommand: verifyCommand ?? null, requireReview: reviewRequired, requireDocumentation: documentationRequired, recoveryCheckpoints: isRecoveryCheckpointsEnabled(root) } }, null, 2);
			},
		}),
		guard_audit: tool({ description: "View recent audit entries recorded by opencode-workflow-guard. Use to diagnose policy decisions, blocked commands, or outcome telemetry.", args: { limit: tool.schema.number().optional().describe("Maximum entries to return (default 10)") }, execute: async (args) => JSON.stringify(getRecentAuditEntries(typeof args?.limit === "number" ? Math.min(args.limit, 50) : 10), null, 2) }),
		guard_why: tool({ description: "Simulate and return the structured policy decision for a specific tool call or command. Proactively use before executing questionable or complex commands to check if they would be blocked by guard policies.", args: { tool: tool.schema.string().describe("Tool name (e.g. bash, edit, write, read, apply_patch)"), input: tool.schema.record(tool.schema.string(), tool.schema.any()).optional().describe("Tool input arguments") }, execute: async (args, toolContext) => JSON.stringify(await runWithRuntimeState(effectiveRoot, client, () => guardToolCallImpl(args.tool, args.input ?? {}, { sessionID: toolContext.sessionID, worktree: toolContext.worktree, directory: toolContext.directory, simulate: true })), null, 2) }),
		record_review: tool({
			description: "Record a secondary reviewer agent's approval or critique of the current changes. The summary must reference the 5 core review axes from guard_review_rubric (test integrity, task completeness, cleanliness, security, platform).",
			args: {
				reviewer: tool.schema.string().describe("Identifier/name of the reviewer subagent"),
				summary: tool.schema.string().describe("Review findings summary across the 5 core review axes"),
				passed: tool.schema.boolean().describe("True if change is approved, false if changes requested"),
				directory: tool.schema.string().optional().describe("Target repository directory being reviewed (defaults to parent session's repository or active directory)"),
			},
			execute: async (args, toolContext) => {
				const auditVerdict = (verdict: "approved" | "changes_requested" | "rejected", reason: string, binding?: NonNullable<AuditEntry["evidence"]>["binding"]) => audit({ ts: new Date().toISOString(), sessionID: toolContext.sessionID, tool: "record_review.verdict", decision: verdict === "rejected" ? "block" : "allow", phase: "event", reason, evidence: { reviewVerdict: verdict, ...(binding ? { binding } : {}) } });
				const axesRefs = ["test integrity", "task completeness", "cleanliness", "security", "platform"];
				const referenced = axesRefs.filter((axis) => args.summary.toLowerCase().includes(axis));
				if (referenced.length < 3) { auditVerdict("rejected", "insufficient_rubric_axes"); return `[workflow-guard] Review rejected: summary must reference the review axes (found ${referenced.length}/5). Call guard_review_rubric to get the rubric, evaluate each axis, and include findings per axis in the summary.`; }
				if (args.passed && /(?:^|\s)(?:\[p[01]\]|p[01]\s*:\s*(?:blocker|defect|vulnerability|error|bug|issue)|p[01]\s+blocker)/i.test(args.summary)) { auditVerdict("rejected", "approval_contains_blocker"); return "[workflow-guard] Review rejected: cannot record approval when P0 or P1 blockers are flagged in findings. Resolve all P0/P1 issues before approving or record review with passed=false."; }
				// Any session may record a verdict so that reviewer agents whose
				// toolset lacks record_review can have their verdict relayed.
				// The verdict is bound to the reviewed DIRECTORY content (commit
				// hash + tracked worktree fingerprint); the recorder's lineage is
				// captured in the audit trail. The review-before-PR requirement
				// itself is unchanged.
				const reviewWorkspace = await resolveEffectiveWorkspace({ sessionID: toolContext.sessionID, directory: args.directory, fallback: toolContext.worktree || toolContext.directory || effectiveRoot });
				const bindingFingerprint = getTrackedWorktreeFingerprint(reviewWorkspace);
				if (!bindingFingerprint) {
					auditVerdict("rejected", "review_workspace_unbindingable", { workspace: reviewWorkspace, recorderSessionID: toolContext.sessionID });
					return `[workflow-guard] Review rejected: the verdict cannot be bound because no tracked-content fingerprint is available for '${reviewWorkspace}' (not a git repository, or git is unavailable). The verdict was NOT recorded. Call record_review with 'directory' set to the reviewed repository worktree, or run it from a session rooted there.`;
				}
				const parentSessionID = await runWithRuntimeState(effectiveRoot, client, () => fetchParentSessionID(toolContext.sessionID));
				const bindingCommitHash = getCurrentGitCommitHash(reviewWorkspace);
				const binding = {
					workspace: reviewWorkspace,
					commitHash: bindingCommitHash,
					worktreeFingerprint: bindingFingerprint.slice(0, 16),
					recorderSessionID: toolContext.sessionID,
					recorderRole: parentSessionID ? ("subagent" as const) : ("root" as const),
					targetSessionID: parentSessionID ?? toolContext.sessionID,
				};
				recordReviewResult(args.reviewer, args.summary, args.passed, parentSessionID ?? toolContext.sessionID, reviewWorkspace);
				if (followupStore && !secretIn(args.summary)) for (const finding of extractReviewFollowups(args.summary)) recordReviewFollowup(followupStore, { severity: finding.severity, summary: finding.summary, reviewer: args.reviewer, sessionID: toolContext.sessionID, commit: bindingCommitHash });
				auditVerdict(args.passed ? "approved" : "changes_requested", args.passed ? "approved" : "changes_requested", binding);
				const recorderNote = parentSessionID
					? `Recorded by secondary session ${toolContext.sessionID} for parent ${parentSessionID}.`
					: `Recorded by root session ${toolContext.sessionID}; prefer relaying through an independent secondary reviewer subagent when one is available.`;
				const boundTo = `Bound to ${reviewWorkspace} (commit ${bindingCommitHash?.slice(0, 12) ?? "unversioned"}, tracked fingerprint ${bindingFingerprint.slice(0, 12)}).`;
				return args.passed
					? `[workflow-guard] Review recorded as APPROVED by ${args.reviewer}. ${boundTo} ${recorderNote}`
					: `[workflow-guard] Review recorded as CHANGES REQUESTED by ${args.reviewer}. ${boundTo} ${recorderNote}`;
			},
		}),
		guard_review_followups: tool({ description: "List durable local P2/P3 review follow-ups (technical debt) for this project. Proactively check during planning or before final verification to address open findings.", args: {}, execute: async () => JSON.stringify(followupStore ? listReviewFollowups(followupStore) : [], null, 2) }),
		guard_review_followup_resolve: tool({ description: "Resolve a durable local review follow-up after the underlying issue has been fixed and verified.", args: { id: tool.schema.string() }, execute: async (args) => followupStore && resolveReviewFollowup(followupStore, args.id) ? `[workflow-guard] Review follow-up ${args.id} resolved.` : `[workflow-guard] Review follow-up ${args.id} was not open or was not found.` }),
		guard_review_rubric: tool({
			description: "Get the secondary-review rubric for the current branch diff across 5 core review axes (test integrity, task completeness, cleanliness, security, platform). The orchestrator should call this before finalizing work or creating a PR, then spawn a reviewer subagent with the rubric as the prompt, which records its verdict via record_review.",
			args: {
				base: tool.schema.string().optional().describe("Base ref to diff against (default: origin/main, origin/master, main)"),
				directory: tool.schema.string().optional().describe("Target repository directory (defaults to active session directory or workspace root)"),
			},
			execute: async (args, toolContext) => {
				const sanitizedBase = typeof args.base === "string" && !args.base.startsWith("-") && !/[\s;'"\0]/.test(args.base) ? args.base : undefined;
				const bases = sanitizedBase ? [sanitizedBase] : ["origin/main", "origin/master", "main", "master"];
				const rubricWorkspace = await resolveEffectiveWorkspace({ sessionID: toolContext?.sessionID, directory: args?.directory, fallback: toolContext?.worktree || toolContext?.directory || effectiveRoot });
				let diffText = "";
				for (const base of bases) { const res = spawnSync("git", ["diff", "--", `${base}...HEAD`], { cwd: rubricWorkspace, encoding: "utf8", timeout: 10_000 }); if (res.status === 0 && res.stdout.trim()) { diffText = res.stdout; break; } }
				if (!diffText) { const last = spawnSync("git", ["diff", "--", "HEAD~1"], { cwd: rubricWorkspace, encoding: "utf8", timeout: 10_000 }); diffText = last.status === 0 ? last.stdout : "(no diff available)"; }
				return buildReviewRubric(diffText);
			},
		}),
		guard_worktree_create: tool({
			description: "Create an isolated git worktree directory for concurrent subagent execution. Proactively call when launching parallel tasks/subagents to prevent file collision and maintain branch isolation.", args: { branch: tool.schema.string().describe("Branch name for the isolated worktree (e.g. 'feat/subagent-task')"), baseBranch: tool.schema.string().optional().describe("Base branch to branch off of (defaults to HEAD)") },
			execute: async (args, toolContext) => {
				const todos = await effectiveTodos(toolContext.sessionID); if (todos !== undefined && !hasActiveTodo(todos)) return "[workflow-guard] Blocked: worktree creation with no active todo item. Break the request down with todowrite first, then create worktrees.";
				const toolRoot = toolContext.worktree || toolContext.directory || effectiveRoot; const res = createGitWorktree(args.branch, args.baseBranch ?? "HEAD", toolRoot); if (!res.success) return `[workflow-guard] Failed to create worktree: ${res.error}`;
				recordMutation((await effectiveTodoOwnerSessionID(toolContext.sessionID)) ?? toolContext.sessionID, toolContext.sessionID); return `[workflow-guard] Worktree created successfully at: ${res.worktreePath}\nRun subagent tasks or pass worktree directory context to isolate file mutations.`;
			},
		}),
		guard_worktree_cleanup: tool({
			description: "Commit a final snapshot and remove an isolated git worktree directory. Call to clean up worktrees created with guard_worktree_create after subagent tasks complete.", args: { worktreePath: tool.schema.string().describe("Path of the worktree directory to clean up") },
			execute: async (args, toolContext) => {
				const todos = await effectiveTodos(toolContext.sessionID); if (todos !== undefined && !hasActiveTodo(todos)) return "[workflow-guard] Blocked: worktree cleanup with no active todo item. Break the request down with todowrite first, then clean up worktrees.";
				const toolRoot = toolContext.worktree || toolContext.directory || effectiveRoot; const res = cleanupGitWorktree(args.worktreePath, toolRoot); if (!res.success) return `[workflow-guard] Failed to clean up worktree: ${res.error}`;
				recordMutation((await effectiveTodoOwnerSessionID(toolContext.sessionID)) ?? toolContext.sessionID, toolContext.sessionID); return `[workflow-guard] Worktree at '${args.worktreePath}' cleaned up successfully.`;
			},
		}),
	};
}
