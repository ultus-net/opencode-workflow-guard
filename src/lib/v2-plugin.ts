/**
 * OpenCode V2 plugin implementation for Workflow Guard.
 *
 * Registers the same policies and tools as the V1 entrypoint in
 * `workflow-guard.ts`, through the V2 `@opencode/plugin` API:
 * - `ctx.tool.transform` for custom tools and tool-description enrichment
 * - `ctx.tool.hook("execute.before"/"execute.after")` for deterministic enforcement
 * - `ctx.session.hook("context"/"compaction"/"prompt")` for system guidance,
 *   compaction context, and recovery checkpoints
 * - `ctx.permission.hook("evaluate")` for permission journaling
 * - `ctx.shell.hook("create.before")` for env scrubbing
 * - `ctx.event.subscribe()` for tool outcomes, session lifecycle, and claims-vs-evidence
 *
 * The V1 SDK client surface (`TodoSdkClient`) is satisfied by an adapter so
 * `lib/` and `policies/` keep working unchanged.
 */

import { Plugin } from "@opencode/plugin";
import { Message } from "@opencode/ai";
import { z } from "zod";
import { join, resolve } from "node:path";
import type { TodoSdkClient } from "./types.ts";
import { scanSessionTodos, toolPartName } from "./v2-todo.ts";
import { findGitRoot, reloadProjectConfig } from "./project-config.ts";
import {
	setWorkspaceRoot,
	setSdkClient,
	getSessionWorkspace,
	setSessionWorkspace,
	runWithRuntimeState,
	getSessionMutationCount,
	sessionVerifyResults,
	sessionReviews,
	isRecoveryCheckpointsEnabled,
	isLearningEnabled,
	isProjectMemoryEnabled,
	getProjectConfig,
} from "./state.ts";
import {
	openProjectMemory,
	ensureProjectMemoryExcluded,
	getProjectMemoryIdentity,
	getRecentProjectMemory,
	isProjectMemoryFreshAsync,
	listReviewFollowups,
	importProjectKnowledge,
	type ProjectMemoryStore,
} from "./project-memory.ts";
import { secretIn } from "../policies/secrets.ts";
import { createCustomTools, buildWorkflowGuardSystemGuidance } from "./custom-tools.ts";
import { isReadOnlyRole } from "./guard-dispatcher.ts";
import { ToolInvocationLifecycle } from "./tool-lifecycle.ts";
import { ToolOutcomeTracker, type ToolOutcomePart } from "./tool-outcomes.ts";
import { EDIT_TOOL_NAMES, fetchParentSession, fetchParentSessionID, effectiveTodos } from "../policies/todo.ts";
import { currentGitBranch, isProtectedBranchName } from "../policies/git.ts";
import { checkCompletionClaims } from "../policies/completion.ts";
import { releaseFileClaims } from "../policies/file-claims.ts";
import { beginReadObservation, recordMutationObservation, recordSuccessfulRead, clearReadFingerprints } from "../policies/stale-write.ts";
import { editTargets, runPostEditValidators, snapshotFile } from "../policies/post-edit-validation.ts";
import { audit, summarizeInput } from "./audit.ts";
import { asRecord, showBlockToast, isSensitiveEnvKey } from "./utils.ts";
import { loadedPluginVersion } from "./version.ts";
import { clearContinuationState, continueUnfinishedSession, isGeneratedContinuationMessage, recordUserMessage } from "../policies/continuation.ts";
import { createRecoveryCheckpoint, finalizeRecoveryCheckpoint, nextRecoveryRun } from "./checkpoint.ts";
import { buildCompactionContext, guardToolCall } from "../workflow-guard.ts";

type V2Context = Plugin.Context;

// ── V1 SDK client adapter ─────────────────────────────────────────────────────

// V2 has no todo endpoint; `scanSessionTodos` reconstructs one session's list
// from message history and distinguishes "empty" from "unknown" (no todo
// capability) so builtin-only sessions are not gated forever. See v2-todo.ts.

function createV2SdkClient(ctx: V2Context): TodoSdkClient {
	// V2 has no server-side log API or TUI surface, so app.log degrades to
	// console logging and showBlockToast becomes a no-op. Block reasons still
	// reach the agent through the thrown tool-hook error; keep this adapter
	// from logging anything beyond guard decision summaries.
	return {
		app: {
			log: async ({ body }) => {
				try {
					console.log(`[${body.service}] ${body.level}: ${body.message}`);
				} catch {}
			},
		},
		session: {
			todo: async ({ path }) => ({ data: await scanSessionTodos(ctx, path.id) }),
			get: async ({ path }) => {
				const session = await ctx.session.get({ sessionID: path.id });
				return { data: { parentID: (session as { parentID?: string }).parentID, title: (session as { title?: string }).title } };
			},
			promptAsync: async (opts) => {
				for (const part of opts.body.parts) {
					if (part.synthetic) {
						await ctx.session.synthetic({ sessionID: opts.path.id, text: part.text });
					} else {
						await ctx.session.prompt({ sessionID: opts.path.id, text: part.text });
					}
				}
			},
		},
		lsp: {},
	};
}

// ── Builtin tool description enrichment ───────────────────────────────────────

const TODOWRITE_SUFFIX =
	"\n\nWorkflow Guard lifecycle: each todowrite call replaces the complete task list. Preserve every pending/in_progress task in subsequent updates until you explicitly mark it completed or cancelled; do not omit active tasks when adding new work. Marking every task completed triggers the finalization gate - fresh verification evidence (test run) is required after the last mutation, and protected-branch/conflict checks apply. Proactively call guard_next_tasks when planning work to discover existing roadmap/TODOs, and guard_status to check outstanding requirements.";

const EDIT_SUFFIX =
	"\n\nWorkflow Guard requirement: Modifications require an active task in todowrite (status pending or in_progress), a feature branch (edits on main/master are blocked), and a prior read of existing files in the current session.";

const SUBAGENT_SUFFIX =
	"\n\nWorkflow Guard subagent guidance: When spawning parallel worker subagents, use guard_worktree_create to isolate file mutations in separate worktrees. When conducting code reviews before task completion or PR creation, fetch the rubric with guard_review_rubric and provide it to a reviewer subagent to evaluate and record via record_review.";

// Builtin tool description enrichment. Candidates are matched against the
// host's tool registry; `ToolEditor.update` ignores missing IDs, so extra
// candidates are harmless no-ops.
//
// V2.0.10 builtin surface (docs + binary): read, glob, grep, edit, write,
// patch, shell, webfetch, websearch, question, skill, subagent, execute.
// - There is no builtin `todowrite` (the V1 name). Todowrite tool parts seen
//   in V2 sessions come from ACP agents that supply their own tools; those
//   are not in the server registry, so this enrichment cannot reach them.
//   The candidate is kept for hosts that do register a todowrite tool.
// - The V1 subagent tool `task` was renamed to `subagent`; both are kept as
//   candidates for the same reason.
const ENRICHMENT_TARGETS: Array<{ candidates: string[]; suffix: string; marker: string }> = [
	{ candidates: ["todowrite"], suffix: TODOWRITE_SUFFIX, marker: "verification evidence" },
	{ candidates: [...EDIT_TOOL_NAMES], suffix: EDIT_SUFFIX, marker: "Workflow Guard requirement" },
	{ candidates: ["task", "subagent"], suffix: SUBAGENT_SUFFIX, marker: "Workflow Guard subagent guidance" },
];

// ── Setup ─────────────────────────────────────────────────────────────────────

export const WorkflowGuardV2 = async (ctx: V2Context) => {
	const hostRoot = ctx.location?.directory || process.cwd();
	const hostIsFilesystemRoot = resolve(hostRoot) === resolve(hostRoot, "..");
	const projectDirectory = (ctx.location as { project?: { directory?: string; canonical?: string } })?.project?.directory;
	let effectiveRoot = hostIsFilesystemRoot && projectDirectory && resolve(projectDirectory) !== resolve(projectDirectory, "..")
		? projectDirectory
		: hostRoot;
	if (resolve(effectiveRoot) === resolve(effectiveRoot, "..")) {
		const nonRootCandidate = [ctx.location?.directory, process.cwd()].find((p) => typeof p === "string" && resolve(p) !== resolve(p, ".."));
		if (nonRootCandidate) {
			const gitRoot = findGitRoot(nonRootCandidate);
			effectiveRoot = gitRoot ?? nonRootCandidate;
		}
	}

	const client = createV2SdkClient(ctx);
	setWorkspaceRoot(effectiveRoot);
	setSdkClient(client);
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
		console.log(`[workflow-guard] info: Workflow Guard v${loadedPluginVersion() ?? "unknown"} plugin initialized for ${effectiveRoot}; provenance is plugin-local in V2`);
	} catch {}

	const toolLifecycle = new ToolInvocationLifecycle();
	const toolOutcomes = new ToolOutcomeTracker();

	// ── Custom tools + builtin description enrichment ──
	const customTools = createCustomTools({ effectiveRoot, projectMemoryEnabled, learningEnabled, projectMemory, followupStore, portableMemoryPath, learningInterventions, client });
	await ctx.tool.transform((editor) => {
		for (const [name, definition] of Object.entries(customTools)) {
			editor.add({
				name,
				description: definition.description,
				// definition.args is a V1 zod raw shape (plain object of zod fields);
				// wrap it so the V2 registry receives a real StandardSchemaV1.
				input: z.object(definition.args as unknown as z.ZodRawShape),
				execute: async (rawInput: unknown, toolContext: { sessionID: string; id: string }) => {
					const result = await (definition.execute as (input: unknown, context: unknown) => Promise<unknown>)(rawInput, {
						sessionID: toolContext.sessionID,
						worktree: getSessionWorkspace(toolContext.sessionID) ?? effectiveRoot,
						directory: effectiveRoot,
					});
					const text = typeof result === "string" ? result : (result as { output?: string } | undefined)?.output;
					return {
						content: typeof text === "string" ? text : JSON.stringify(result),
					};
				},
			} as never);
		}
		for (const target of ENRICHMENT_TARGETS) {
			for (const id of target.candidates) {
				editor.update(id, (tool) => {
					const description = typeof tool.description === "string" ? tool.description : "";
					if (description.includes(target.marker)) return;
					tool.description = description + target.suffix;
				});
			}
		}
	});

	// ── Deterministic enforcement ──
	await ctx.tool.hook("execute.before", (event) => {
		const toolWorktree = getSessionWorkspace(event.sessionID) || effectiveRoot;
		return runWithRuntimeState(toolWorktree, client, async () => {
			const args = event.input;
			const reason = await guardToolCall(event.tool, args, {
				sessionID: event.sessionID,
				callID: event.id,
				worktree: toolWorktree,
				agent: event.agent,
			});
			if (reason !== undefined) {
				await showBlockToast(reason);
				const failureCount = event.sessionID ? toolOutcomes.getFailureCount(event.sessionID) : 0;
				const circuitBreakerSuffix = failureCount >= 2
					? "\n\n[Workflow Guard Circuit Breaker: Repeated failures detected in this session. Stop attempting alternative workarounds or shell laundering. Address the required step above directly, or inspect policy details with guard_status or guard_why.]"
					: "";
				throw new Error(`[workflow-guard] ${reason}${circuitBreakerSuffix}`);
			}
			toolLifecycle.start(event.sessionID, event.id);
			const record = asRecord(args);
			const workdir = typeof record?.workdir === "string" ? record.workdir : undefined;
			const filePath = typeof record?.filePath === "string" ? record.filePath : (typeof record?.path === "string" ? record.path : undefined);
			const candidatePath = workdir ?? filePath ?? toolWorktree;
			if (candidatePath) {
				const gitRoot = findGitRoot(candidatePath);
				if (gitRoot) setSessionWorkspace(event.sessionID, gitRoot);
			}
			if (event.tool === "read") {
				const target = editTargets(args, toolWorktree)[0];
				if (target) {
					const observation = beginReadObservation(target);
					if (observation) toolLifecycle.setReadObservation(event.sessionID, event.id, observation);
				}
			}
			if (EDIT_TOOL_NAMES.has(event.tool)) {
				const snapshots = editTargets(args, toolWorktree).map(snapshotFile);
				if (snapshots.length) toolLifecycle.setPostEditSnapshots(event.sessionID, event.id, toolWorktree, snapshots);
			}
		});
	});

	await ctx.tool.hook("execute.after", async (event) => {
		const startedAt = toolLifecycle.finish(event.sessionID, event.id);
		const outcome = toolOutcomes.recordFallbackCompleted(event.sessionID, event.id, event.tool, startedAt === undefined ? undefined : Date.now() - startedAt);
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
		releaseFileClaims(event.sessionID, event.id);
		if (event.tool === "read") {
			const observation = toolLifecycle.takeReadObservation(event.sessionID, event.id);
			if (observation) recordSuccessfulRead(observation, event.sessionID);
		}
		if (event.status === "error") return;
		const pending = toolLifecycle.takePostEditSnapshots(event.sessionID, event.id);
		if (!pending) return;
		await runWithRuntimeState(pending.root, client, async () => {
			// Seed the session's observation of the bytes it just mutated so a
			// follow-up edit needs no redundant re-read (V1 parity).
			for (const before of pending.snapshots) recordMutationObservation(before.path, event.sessionID, before.digest);
			const reports = await Promise.all(pending.snapshots.map((before) => runPostEditValidators(pending.root, before)));
			const report = reports.filter((value): value is string => Boolean(value)).join("\n\n");
			if (!report) return;
			const result = event.result as { content?: unknown } | undefined;
			if (result && "content" in result) {
				if (typeof result.content === "string") {
					result.content = `${result.content}\n\n${report}`;
				} else if (Array.isArray(result.content)) {
					result.content = [...result.content, { type: "text", text: report }];
				} else {
					result.content = report;
				}
			}
		});
	});

	// ── Session request hooks ──
	await ctx.session.hook("context", (event) => {
		try {
			const existing = Array.isArray(event.system)
				? event.system.map((part) => (typeof part === "string" ? part : (part as { text?: string }).text ?? "")).join("\n")
				: "";
			if (existing.includes("## Workflow Guard & Operational Tools")) return;
			const isReadOnly = event.agent ? isReadOnlyRole(event.agent) : false;
			const guidance = buildWorkflowGuardSystemGuidance({
				projectMemoryEnabled,
				learningEnabled,
				recoveryCheckpointsEnabled: isRecoveryCheckpointsEnabled(effectiveRoot),
				isReadOnly,
			});
			event.system.push({ type: "text", text: guidance });
		} catch {}
	});

	await ctx.session.hook("compaction", async (event) => {
		try {
			const sessionID = event.sessionID;
			const parentID = sessionID ? await fetchParentSessionID(sessionID) : undefined;
			const todos = await effectiveTodos(sessionID);
			const active = todos?.filter((t) => {
				const s = String(t.status ?? "");
				return s === "pending" || s === "in_progress";
			});
			const branch = currentGitBranch(effectiveRoot) ?? "unknown";
			const isProtected = branch !== "unknown" && isProtectedBranchName(branch, effectiveRoot);
			const sessionMutationCount = getSessionMutationCount(sessionID);
			// Mirror V1: zero-mutation subagent sessions inherit the parent's
			// verification/review evidence so inherited-todo work keeps fresh gates.
			const lastV = sessionVerifyResults.get(sessionID) ?? (sessionMutationCount === 0 && parentID ? sessionVerifyResults.get(parentID) : undefined);
			const lastR = sessionReviews.get(sessionID) ?? (sessionMutationCount === 0 && parentID ? sessionReviews.get(parentID) : undefined);
			const mutationCountVal = sessionMutationCount;

			const priorityContextBlocks: string[] = [];

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
				priorityContextBlocks.push(
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
				priorityContextBlocks.push(`## Review Follow-ups\n${openFollowups.map((item) => `- [${item.severity}:${item.id.slice(0, 8)}] ${item.summary.slice(0, 300)}`).join("\n")}\nTreat these as durable technical debt: address relevant items when practical and resolve them explicitly after verification.`);
			}
			const operationalState = stateLines.join("\n");
			let projectKnowledge: ReturnType<typeof getRecentProjectMemory> = [];
			try {
				const candidates = (projectMemory ? getRecentProjectMemory(projectMemory, 8) : [])
					.filter((memory) => memory.source !== "portable");
				const freshness = await Promise.all(candidates.map((memory) => isProjectMemoryFreshAsync(memory, effectiveRoot)));
				projectKnowledge = candidates.filter((_, index) => freshness[index]);
			} catch {}
			if (projectKnowledge.length > 0) {
				const lines = projectKnowledge.map((memory) => `- [${memory.kind}:${memory.id.slice(0, 8)}] ${memory.content.slice(0, 300)}`);
				priorityContextBlocks.push(`## Project Memory\nUse project_memory_search when deeper historical context is needed. Treat these as historical project knowledge; verify against current repository state when relevant files have changed.\n${lines.join("\n")}`);
			}

			const contextText = buildCompactionContext(operationalState, priorityContextBlocks);
			if (Array.isArray(event.messages)) {
				event.messages.push(Message.user([{ type: "text", text: contextText }]));
			}
		} catch {}
	});

	await ctx.session.hook("prompt", async (event) => {
		const sessionID = event.sessionID;
		try {
			// V2 prompt hooks do not run for synthetic messages, but keep the V1
			// generated-continuation guard so checkpoint creation cannot churn on
			// continuation prompts admitted through any other path.
			if (isRecoveryCheckpointsEnabled(effectiveRoot) && !isGeneratedContinuationMessage(sessionID, event.messageID)) {
				const parent = await runWithRuntimeState(effectiveRoot, client, () => fetchParentSession(sessionID));
				if (parent.ok && !parent.parentID) {
					const run = nextRecoveryRun(effectiveRoot, sessionID);
					const checkpoint = createRecoveryCheckpoint(effectiveRoot, sessionID, run);
					if (checkpoint) toolLifecycle.setRecoveryRun(sessionID, run);
				}
			}
			recordUserMessage(sessionID, event.messageID);
		} catch {}
	});

	// ── Permission journaling ──
	await ctx.permission.hook("evaluate", (event) => {
		try {
			audit({
				ts: new Date().toISOString(),
				sessionID: event.sessionID,
				tool: "permission.ask",
				decision: event.effect === "deny" ? "block" : "allow",
				input: {
					action: event.action,
					resources: event.resources,
					agent: event.agent,
					effect: event.effect,
				},
			});
		} catch {}
	});

	// ── Shell env scrubbing ──
	await ctx.shell.hook("create.before", (event) => {
		try {
			const env = event.env;
			if (env && typeof env === "object") {
				const scrubbed: string[] = [];
				for (const key of Object.keys(env)) {
					if (isSensitiveEnvKey(key) && env[key] !== "") {
						env[key] = "";
						scrubbed.push(key);
					}
				}
				if (scrubbed.length > 0) {
					console.log(`[workflow-guard] warn: Scrubbed sensitive env vars: ${scrubbed.join(", ")}. Auth failures may be due to this.`);
				}
			}
		} catch {}
	});

	// ── Event stream ──
	const controller = new AbortController();
	void (async () => {
		try {
			for await (const raw of ctx.event.subscribe({ signal: controller.signal })) {
				const event = raw as { type?: string; data?: unknown };
				try {
					await handleV2Event(event, {
						effectiveRoot,
						client,
						toolLifecycle,
						toolOutcomes,
					});
				} catch {}
			}
		} catch (error) {
			if (!controller.signal.aborted) throw error;
		}
	})();

	return () => controller.abort();
};

// ── Event handling ────────────────────────────────────────────────────────────

interface V2EventState {
	effectiveRoot: string;
	client: unknown;
	toolLifecycle: ToolInvocationLifecycle;
	toolOutcomes: ToolOutcomeTracker;
}

async function handleV2Event(
	event: { type?: string; data?: unknown },
	state: V2EventState,
): Promise<void> {
	const { effectiveRoot, client, toolLifecycle, toolOutcomes } = state;

	if (event.type === "session.message.content.updated") {
		const data = event.data as { sessionID?: unknown; content?: unknown } | undefined;
		const sessionID = typeof data?.sessionID === "string" ? data.sessionID : undefined;
		if (!sessionID || !Array.isArray(data?.content)) return;
		for (const part of data.content as Array<Record<string, unknown>>) {
			if (part?.type !== "tool") continue;
			const toolState = part.state as { status?: unknown; error?: { message?: string } | string } | undefined;
			const status = toolState?.status;
			if (status !== "completed" && status !== "error") continue;
			// V2 keeps timing on the tool part itself (part.time), not inside state.
			const partTime = part.time as { ran?: unknown; completed?: unknown } | undefined;
			const start = typeof partTime?.ran === "number" ? partTime.ran : undefined;
			const end = typeof partTime?.completed === "number" ? partTime.completed : undefined;
			const mapped: ToolOutcomePart = {
				type: "tool",
				sessionID,
				callID: part.id,
				tool: toolPartName(part),
				state: {
					status,
					error: typeof toolState?.error === "string" ? toolState.error : toolState?.error?.message,
					time: { start, end },
				},
			};
			const outcome = toolOutcomes.record(mapped);
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
					console.log(`[workflow-guard] ${outcome.tool} failed equivalently 3 times in this session; change approach or inspect the underlying failure before retrying.`);
				}
			}
		}
		return;
	}

	if (event.type === "session.text.ended") {
		const data = event.data as { sessionID?: unknown; text?: unknown } | undefined;
		const sessionID = typeof data?.sessionID === "string" ? data.sessionID : undefined;
		const text = typeof data?.text === "string" ? data.text : "";
		try {
			const check = checkCompletionClaims(text, { sessionID });
			if (check.claimsCompletion && check.evidenceState && check.evidenceState !== "fresh-pass") {
				console.log(`[workflow-guard] completion claim mismatch: ${check.reason}`);
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
		return;
	}

	if (event.type === "session.idle") {
		const data = event.data as { sessionID?: unknown } | undefined;
		const sessionID = typeof data?.sessionID === "string" ? data.sessionID : undefined;
		if (typeof sessionID === "string") {
			releaseFileClaims(sessionID);
			clearReadFingerprints(sessionID);
			toolLifecycle.clearSession(sessionID);
			const recoveryRun = toolLifecycle.takeRecoveryRun(sessionID);
			if (recoveryRun !== undefined) {
				finalizeRecoveryCheckpoint(effectiveRoot, sessionID, recoveryRun);
			}
			const settleTitle = getProjectConfig(effectiveRoot).titleSettleWorkaround !== false;
			await runWithRuntimeState(effectiveRoot, client, () => continueUnfinishedSession(sessionID, settleTitle));
		}
		return;
	}

	if (event.type === "session.deleted") {
		const data = event.data as { sessionID?: unknown } | undefined;
		const sessionID = typeof data?.sessionID === "string" ? data.sessionID : undefined;
		if (typeof sessionID === "string") {
			releaseFileClaims(sessionID);
			clearReadFingerprints(sessionID);
			toolLifecycle.clearSession(sessionID);
			toolOutcomes.clearSession(sessionID);
			toolLifecycle.takeRecoveryRun(sessionID);
			await runWithRuntimeState(effectiveRoot, client, () => clearContinuationState(sessionID));
		}
		return;
	}

	if (event.type === "permission.asked" || event.type === "permission.replied") {
		// V2 permission.replied data carries `reply` ("once" | "always" | "reject").
		const data = event.data as { sessionID?: unknown; reply?: unknown } | undefined;
		audit({
			ts: new Date().toISOString(),
			sessionID: typeof data?.sessionID === "string" ? data.sessionID : undefined,
			tool: event.type ?? "event",
			decision:
				event.type === "permission.replied" && /reject|deny/i.test(String(data?.reply ?? ""))
					? "block"
					: "allow",
			input: summarizeInput(event.data),
		});
		return;
	}
	// Note on V1 events without a V2 counterpart:
	// - `command.executed`: no V2 event stream equivalent (audit-only in V1; dropped).
	// - `permission.updated`: replaced by `permission.asked`/`permission.replied` above.
	// - `session.created`: exists in the V2 union but needed no V1 behavior beyond
	//   the audit above; session state resets happen on `session.deleted`.
}
