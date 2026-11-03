/**
 * OpenCode V2 plugin implementation for Workflow Guard.
 *
 * Registers the same policies and tools as the V1 entrypoint in
 * `workflow-guard.ts`, through the V2 `@opencode/plugin` API:
 * - `ctx.tool.transform` for custom tools and tool-description enrichment
 * - `ctx.tool.hook("execute.before"/"execute.after")` for deterministic enforcement
 * - `ctx.session.hook("context"/"compaction"/"prompt")` for system guidance,
 *   read-only tool pruning, compaction context, and recovery checkpoints
 * - `ctx.command.transform` for the server-side `/guard-status` command
 * - `ctx.permission.hook("evaluate")` for the pre-execution deny seat
 * - `ctx.shell.hook("create.before")` for env scrubbing
 * - `ctx.mcp.list()` plus `mcp.status.changed` for the guarded-server inventory
 * - `ctx.event.subscribe()` for tool outcomes, session lifecycle, and claims-vs-evidence
 *
 * The V1 SDK client surface (`TodoSdkClient`) is satisfied by an adapter so
 * `lib/` and `policies/` keep working unchanged.
 */

import { Plugin } from "@opencode/plugin";
import { Message } from "@opencode/ai/effect";
import { z } from "zod";
import { join, resolve } from "node:path";
import type { TodoSdkClient } from "./types.ts";
import { detectTodoCapability, recordTodoCapability, recordedTodoCapability, scanSessionTodos } from "./v2-todo.ts";
import { findGitRoot, reloadProjectConfig } from "./project-config.ts";
import {
	setWorkspaceRoot,
	setSdkClient,
	getSessionBoundWorkspace,
	rebindSessionWorkspaceFromHost,
	forgetSessionWorkspace,
	registerSessionWorkspaceFromToolCall,
	runWithRuntimeState,
	getSessionMutationCount,
	sessionVerifyResults,
	sessionReviews,
	clearTodoSessionState,
	isRecoveryCheckpointsEnabled,
	isLearningEnabled,
	isProjectMemoryEnabled,
	getProjectConfig,
	isLiveDocsRequired,
	getLiveDocFailureThreshold,
	getResearchToolPatterns,
	isDogfoodRequired,
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
import { isMutatingSurfaceTool, isReadOnlyRole, SHELL_TOOL_NAMES } from "./guard-dispatcher.ts";
import { ToolInvocationLifecycle } from "./tool-lifecycle.ts";
import { ToolOutcomeTracker } from "./tool-outcomes.ts";
import { EDIT_TOOL_NAMES, fetchParentSession, fetchParentSessionID, effectiveTodos } from "../policies/todo.ts";
import { currentGitBranch, isProtectedBranchName } from "../policies/git.ts";
import { checkCompletionClaims } from "../policies/completion.ts";
import { checkSweepingClaims } from "../policies/sweeping-claims.ts";
import { clearLiveDocsFloor, isResearchTool, liveDocsGatingReason, recordLiveDocsFailure, recordResearchLookup } from "../policies/live-docs.ts";
import { releaseFileClaims } from "../policies/file-claims.ts";
import { beginReadObservation, recordMutationObservation, recordSuccessfulRead, clearReadFingerprints } from "../policies/stale-write.ts";
import { editTargets, runPostEditValidators, snapshotFile, type FileSnapshot } from "../policies/post-edit-validation.ts";
import { extractCommands, splitShellSegments } from "./shell.ts";
import { expandShellTargetPath, isPathOutsideWorkspace, OPENCODE_SCRATCH_DIR, redirectMutationsIn } from "../policies/boundary.ts";
import { audit, summarizeInput } from "./audit.ts";
import { asRecord, isSensitiveEnvKey } from "./utils.ts";
import { loadedPluginVersion } from "./version.ts";
import { clearContinuationState, continueUnfinishedSession, isGeneratedContinuationMessage, markInterrupted, notifySessionRenamed, recordUserMessage } from "../policies/continuation.ts";
import { createRecoveryCheckpoint, finalizeRecoveryCheckpoint, nextRecoveryRun } from "./checkpoint.ts";
import { buildCompactionContext, guardToolCall } from "./guard-api.ts";
import { evaluateDogfoodGate } from "./dogfood.ts";
import {
	appendToolDescriptionSuffix,
	EDIT_MARKER,
	EDIT_SUFFIX,
	SUBAGENT_MARKER,
	SUBAGENT_SUFFIX,
	TODOWRITE_MARKER,
	TODOWRITE_SUFFIX,
} from "./tool-descriptions.ts";
import { registerPluginInstance, releasePluginInstance } from "./plugin-instance.ts";
import { claimToolCall, releaseToolCallClaim } from "./call-claims.ts";
import { evaluatePermissionSeat } from "./permission-seat.ts";
import { pruneToolsForReadOnlyRole } from "./read-only-tools.ts";
import { registerGuardStatusCommand } from "./guard-command.ts";
import { createHostWorktreePort } from "./host-worktree.ts";
import { listHostMcpServerNames, recordHostMcpServers } from "./mcp-inventory.ts";

type V2Context = Plugin.Context;

// ── V1 SDK client adapter ─────────────────────────────────────────────────────

// V2 has no todo endpoint; `scanSessionTodos` reconstructs one session's list
// from message history and distinguishes "empty" from "unknown" (no todo
// capability) so builtin-only sessions are not gated forever. See v2-todo.ts.

function createV2SdkClient(ctx: V2Context): TodoSdkClient {
	// V2 has no server-side log API or TUI surface. The client shim supplies
	// only { app, session, lsp }, so there is no `tui.showToast` to call: block
	// paths on V2 do not attempt a toast and rely on the thrown hook error,
	// which is what actually reaches the model. Keep this adapter from logging
	// anything beyond guard decision summaries.
	const client: TodoSdkClient = {
		app: {
			log: async ({ body }) => {
				try {
					console.log(`[${body.service}] ${body.level}: ${body.message}`);
				} catch {}
			},
		},
		session: {
			todo: async ({ path }) => ({ data: await scanSessionTodos(ctx, path.id, recordedTodoCapability()) }),
			get: async ({ path }) => {
				const session = await ctx.session.get({ sessionID: path.id });
				return { data: { parentID: (session as { parentID?: string }).parentID, title: (session as { title?: string }).title } };
			},
			// V2 only: forwards a synthetic message with `delivery`/`resume`.
			// Its presence is also what marks this client as V2 for
			// `policies/continuation.ts`, which is why the values travel here
			// instead of through the shared `promptAsync` body type.
			synthetic: async (opts) => {
				await ctx.session.synthetic({
					sessionID: opts.sessionID,
					text: opts.text,
					...(opts.delivery ? { delivery: opts.delivery } : {}),
					...(opts.resume === undefined ? {} : { resume: opts.resume }),
				});
			},
			promptAsync: async (opts) => {
				const body = opts.body as {
					parts: Array<{ type: "text"; text: string; synthetic?: boolean }>;
					delivery?: "steer" | "queue";
					resume?: boolean;
				};
				for (const part of body.parts) {
					if (part.synthetic) {
						await client.session!.synthetic!({
							sessionID: opts.path.id,
							text: part.text,
							...(body.delivery ? { delivery: body.delivery } : {}),
							...(body.resume === undefined ? {} : { resume: body.resume }),
						});
					} else {
						await ctx.session.prompt({ sessionID: opts.path.id, text: part.text });
					}
				}
			},
		},
		lsp: {},
	};
	return client;
}

// Builtin tool description enrichment. Candidates are matched against the
// host's tool registry; `ToolEditor.update` ignores missing IDs, so extra
// candidates are harmless no-ops.
//
// Version boundary for the builtin surface:
// - V2.0.x (docs + binary, up to and including 2.0.15): read, glob, grep,
//   edit, write, patch, shell, webfetch, websearch, question, skill, subagent,
//   execute. There is no builtin `todowrite`; todowrite parts in V2 sessions
//   come from ACP agents that supply their own tools, which are not in the
//   server registry, so this enrichment cannot reach them.
// - V2.1.x adds a builtin `todowrite` behind the `experimental.todo` config
//   key, so the candidate below reaches a real registry entry there.
// - V2.2.x exposes `todowrite` through that same `experimental.todo` opt-in.
//   The guard probes the registry rather than inferring capability from the
//   version, so 2.1.x and 2.2.x need no version check here.
// - The V1 subagent tool `task` was renamed to `subagent`; both are kept as
//   candidates for the same reason.
const ENRICHMENT_TARGETS: Array<{ candidates: string[]; suffix: string; marker: string }> = [
	{ candidates: ["todowrite"], suffix: TODOWRITE_SUFFIX, marker: TODOWRITE_MARKER },
	{ candidates: [...EDIT_TOOL_NAMES], suffix: EDIT_SUFFIX, marker: EDIT_MARKER },
	{ candidates: ["task", "subagent"], suffix: SUBAGENT_SUFFIX, marker: SUBAGENT_MARKER },
];

// ── Setup ─────────────────────────────────────────────────────────────────────

export const WorkflowGuardV2 = async (ctx: V2Context) => {
	const hostRoot = ctx.location?.directory || process.cwd();
	const hostIsFilesystemRoot = resolve(hostRoot) === resolve(hostRoot, "..");
	// `location.project` is required by the host's `Location.Info` schema
	// (`@opencode/schema/dist/location.d.ts`), so the optional read is only a
	// runtime guard for harnesses and stubs that construct a partial context.
	const projectDirectory = ctx.location.project?.directory;
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
	// Load-once guard: OpenCode 2 merges plugin arrays, so the same package
	// named in global and project config loads this module twice. A duplicate
	// stays inert (no hooks, no tools, no second workspace latch) and leaves a
	// warn-level record; see lib/plugin-instance.ts.
	const instance = registerPluginInstance({ workspaceRoot: effectiveRoot });
	if (instance.duplicate) {
		try {
			console.warn(
				`[workflow-guard] warn: duplicate plugin load for ${instance.workspaceRoot} (module ${instance.modulePath}); ` +
					"this instance stays inert. Configure the guard in one location only.",
			);
		} catch {}
		return () => releasePluginInstance(instance.key);
	}
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
	const customTools = createCustomTools({ effectiveRoot, projectMemoryEnabled, learningEnabled, projectMemory, followupStore, portableMemoryPath, learningInterventions, client, hostWorktree: createHostWorktreePort(ctx), todoCapability: () => recordedTodoCapability(), hostVersion: () => ctx.app?.version });
	await ctx.tool.transform((editor) => {
		for (const [name, definition] of Object.entries(customTools)) {
			editor.add({
				name,
				description: definition.description,
				// definition.args is a V1 zod raw shape (plain object of zod fields);
				// wrap it so the V2 registry receives a real StandardSchemaV1.
				input: z.object(definition.args as unknown as z.ZodRawShape),
				execute: async (rawInput: unknown, toolContext: { sessionID: string; id: string; signal?: AbortSignal }) => {
					// Only a session-bound workspace counts as the tool's own
					// context; an unbound entry is a plugin-instance bootstrap
					// and must not be presented to the tools as one.
					const boundWorktree = getSessionBoundWorkspace(toolContext.sessionID);
					// `signal` aborts when the session is interrupted. Guard tools
					// pass it to cancellable work so an interrupt stops them
					// instead of waiting out their own timeouts. V1's tool
					// context supplies no signal, so the checks there are no-ops.
					const result = await (definition.execute as (input: unknown, context: unknown) => Promise<unknown>)(rawInput, {
						sessionID: toolContext.sessionID,
						...(boundWorktree ? { worktree: boundWorktree } : {}),
						directory: boundWorktree ?? effectiveRoot,
						...(toolContext.signal ? { signal: toolContext.signal } : {}),
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
					const next = appendToolDescriptionSuffix(description, target.suffix, target.marker);
					if (next !== undefined) tool.description = next;
				});
			}
		}
	});

	// ── /guard-status command ──
	// Reachable from every V2 client without the optional TUI companion. The
	// report is produced by the same guard_status implementation the tool uses,
	// then delivered as a synthetic message so it costs no model turn.
	await registerGuardStatusCommand(ctx, {
		runStatus: async (sessionID) => {
			const boundWorktree = getSessionBoundWorkspace(sessionID);
			const result = await (customTools.guard_status as unknown as {
				execute: (input: unknown, context: unknown) => Promise<unknown>;
			}).execute({}, {
				sessionID,
				...(boundWorktree ? { worktree: boundWorktree } : {}),
				directory: boundWorktree ?? effectiveRoot,
			});
			return typeof result === "string" ? result : JSON.stringify(result);
		},
		effectiveRoot,
		client,
	});

	// ── Deterministic enforcement ──
	await ctx.tool.hook("execute.before", (event) => {
		// One policy decision per tool call even if a second instance with a
		// different module path (global cache copy plus a source checkout)
		// registered too. The owner evaluates; the other defers.
		if (!claimToolCall(instance.key, event.sessionID, event.id, event.tool)) return;
		const toolWorktree = getSessionBoundWorkspace(event.sessionID) || effectiveRoot;
		return runWithRuntimeState(toolWorktree, client, async () => {
			const args = event.input;
			const reason = await guardToolCall(event.tool, args, {
				sessionID: event.sessionID,
				callID: event.id,
				worktree: toolWorktree,
				agent: event.agent,
			});
			if (reason !== undefined) {
				releaseToolCallClaim(instance.key, event.sessionID, event.id, event.tool);
				const failureCount = event.sessionID ? toolOutcomes.getFailureCount(event.sessionID) : 0;
				const circuitBreakerSuffix = failureCount >= 2
					? "\n\n[Workflow Guard Circuit Breaker: Repeated failures detected in this session. Stop attempting alternative workarounds or shell laundering. Address the required step above directly, or inspect policy details with guard_status or guard_why.]"
					: "";
				throw new Error(`[workflow-guard] ${reason}${circuitBreakerSuffix}`);
			}
			// Policy 25: repeated failures with no live lookup since block the
			// guess-and-retry surfaces until the session grounds itself in
			// current documentation (V1 parity). Research tools are never gated.
			if (event.sessionID && isMutatingSurfaceTool(event.tool)) {
				const threshold = getLiveDocFailureThreshold(toolWorktree);
				if (isLiveDocsRequired(toolWorktree)) {
					const researchReason = liveDocsGatingReason(event.sessionID, event.tool, threshold, getResearchToolPatterns(toolWorktree));
					if (researchReason !== undefined) {
						releaseToolCallClaim(instance.key, event.sessionID, event.id, event.tool);
						console.log(`[workflow-guard] warn: ${researchReason}`);
						audit({
							ts: new Date().toISOString(),
							sessionID: event.sessionID,
							callID: event.id,
							tool: event.tool,
							decision: "block",
							phase: "decision",
							reason: "live_docs_research_floor",
						});
						throw new Error(`[workflow-guard] ${researchReason}`);
					}
				}
			}
			toolLifecycle.start(event.sessionID, event.id);
			const record = asRecord(args);
			const workdir = typeof record?.workdir === "string" ? record.workdir : undefined;
			const filePath = typeof record?.filePath === "string" ? record.filePath : (typeof record?.path === "string" ? record.path : undefined);
			await registerSessionWorkspaceFromToolCall(event.sessionID, {
				workdir,
				filePath,
				toolWorktree,
				mutating: EDIT_TOOL_NAMES.has(event.tool) || SHELL_TOOL_NAMES.has(event.tool),
			});
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
			if (SHELL_TOOL_NAMES.has(event.tool)) {
				// An allowed shell redirect authors the target's bytes exactly
				// like edit/write (LL-003), so pre-register each redirect
				// target's pre-state and seed the session's freshness
				// observation after the call succeeds. Observation only: shell
				// writes never run the post-edit validators. (V1 parity.)
				const shellWorkdir = typeof record?.workdir === "string" ? record.workdir : undefined;
				const shellCwd = shellWorkdir ? resolve(toolWorktree, shellWorkdir) : toolWorktree;
				const snapshots: FileSnapshot[] = [];
				for (const command of extractCommands(args)) {
					for (const segment of splitShellSegments(command)) {
						for (const mutation of redirectMutationsIn(segment)) {
							const target = mutation.target ?? "";
							if (!target || target === "/dev/null") continue;
							const expanded = expandShellTargetPath(target);
							if (!expanded) continue;
							const resolvedTarget = resolve(shellCwd, expanded);
							if (resolvedTarget === OPENCODE_SCRATCH_DIR || resolvedTarget.startsWith(OPENCODE_SCRATCH_DIR + "/")) continue;
							if (isPathOutsideWorkspace(resolvedTarget, toolWorktree)) continue;
							snapshots.push(snapshotFile(resolvedTarget));
						}
					}
				}
				if (snapshots.length) toolLifecycle.setShellWriteSnapshots(event.sessionID, event.id, toolWorktree, snapshots);
			}
		});
	});

	await ctx.tool.hook("execute.after", async (event) => {
		releaseToolCallClaim(instance.key, event.sessionID, event.id, event.tool);
		const startedAt = toolLifecycle.finish(event.sessionID, event.id);
		recordV2ToolOutcome(toolOutcomes, effectiveRoot, {
			tool: event.tool,
			sessionID: event.sessionID,
			callID: event.id,
			status: event.status,
			error: event.status === "error" ? event.error : undefined,
		}, startedAt);
		releaseFileClaims(event.sessionID, event.id);
		if (event.tool === "read") {
			const observation = toolLifecycle.takeReadObservation(event.sessionID, event.id);
			if (observation) recordSuccessfulRead(observation, event.sessionID);
		}
		if (event.status === "error") return;
		const shellPending = toolLifecycle.takeShellWriteSnapshots(event.sessionID, event.id);
		if (shellPending) {
			// Seed the session's observation of the bytes its shell redirect
			// authored (LL-003); observation-only, validators are not run for
			// shell writes, and the digest gate keeps no-op calls from
			// seeding. (V1 parity.)
			for (const before of shellPending.snapshots) recordMutationObservation(before.path, event.sessionID, before.digest);
		}
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
			// A read-only role must not be able to *choose* a mutating tool. The
			// execute.before seat still denies it, but pruning the per-request
			// tool snapshot removes the call before the model plans it. Pruning
			// is a narrowing only: tools supplied outside the host snapshot
			// (ACP agents, nested Code Mode calls) still meet the backstop.
			if (event.agent && isReadOnlyRole(event.agent)) {
				const removed = pruneToolsForReadOnlyRole(event.tools as Record<string, unknown> | undefined);
				if (removed.length > 0) {
					audit({
						ts: new Date().toISOString(),
						sessionID: event.sessionID,
						tool: "session.context",
						decision: "block",
						phase: "decision",
						reason: "read_only_role_tools_pruned",
						input: { agent: event.agent, removed },
					});
				}
			}
			const existing = Array.isArray(event.system)
				? event.system.map((part) => (typeof part === "string" ? part : (part as { text?: string }).text ?? "")).join("\n")
				: "";
			if (existing.includes("## Workflow Guard & Operational Tools")) return;
			const isReadOnly = event.agent ? isReadOnlyRole(event.agent) : false;
			const guidance = buildWorkflowGuardSystemGuidance({
				projectMemoryEnabled,
				learningEnabled,
				recoveryCheckpointsEnabled: isRecoveryCheckpointsEnabled(effectiveRoot),
				dogfoodRequired: isDogfoodRequired(effectiveRoot),
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
						"\nComplete tasks efficiently and address remaining ones. Mark a task completed only after its work is actually done: the guard blocks a completion with no recorded file mutation in that task's window. Append `[read-only]` to a genuinely read-only task (review, investigation), and use `cancelled` for work that was dropped.",
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
			const dogfoodCtxGate = evaluateDogfoodGate(effectiveRoot);
			if (dogfoodCtxGate.required) {
				stateLines.push(
					dogfoodCtxGate.missingHosts.length === 0
						? `- Dogfood Evidence: PASS on ${(dogfoodCtxGate.matchedRecords ?? []).map((record) => record.host.label).join(", ") || "recorded host"}`
						: `- Dogfood Evidence: MISSING for ${dogfoodCtxGate.missingHosts.join(", ")} (required before PR creation)`,
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

	// ── Permission seat: deny before the tool starts ──
	// `evaluate` sees normalized `action`/`resources` and runs before the tool,
	// so it is the earliest hard stop for shell commands, file mutations, and
	// guarded MCP calls. It cannot see raw tool input, so the raw-argument work
	// (todo lifecycle, stale-write, post-edit snapshots) stays in
	// `execute.before`. See lib/permission-seat.ts for the split and the limits.
	//
	// Flow limit, documented by the host: an explicit configured `deny` is
	// resolved before this hook runs, so the hook never sees it. A guard audit
	// therefore cannot explain a configured deny; only host config can. The
	// hook runs for allow/ask, and a denial here is always a tightening.
	await ctx.permission.hook("evaluate", async (event) => {
		const configuredEffect = event.effect;
		try {
			const seat = await evaluatePermissionSeat(
				{
					sessionID: event.sessionID,
					agent: event.agent,
					action: event.action,
					resources: event.resources,
					effect: configuredEffect,
				},
				{ workspaceRoot: effectiveRoot, client },
			);
			if (seat.effect === "deny" && seat.decision) {
				event.effect = "deny";
				event.message = seat.decision.message;
			}
			// An abstention leaves the configured effect and message untouched,
			// and still journals. `execute.before` runs the real check, which
			// includes the remote PR probe that simulation skips. It records
			// `abstain` rather than `allow`, so the deferral stays visible.
			const abstained = seat.effect === "abstain";
			audit({
				ts: new Date().toISOString(),
				sessionID: event.sessionID,
				tool: "permission.ask",
				decision: seat.effect === "deny" ? "block" : abstained ? "abstain" : "allow",
				phase: "decision",
				reason: abstained ? "deferred_to_execute_before" : seat.decision?.code,
				policyDecision: seat.decision,
				input: {
					action: event.action,
					resources: event.resources,
					agent: event.agent,
					configuredEffect,
					mappedTool: seat.mappedTool,
					...(abstained ? { deferred: "execute.before" } : {}),
				},
			});
		} catch (error) {
			// Fail closed: a seat that cannot evaluate must not become a pass.
			try {
				event.effect = "deny";
				event.message = `[workflow-guard permission.evaluate] Blocked: the guard could not evaluate this permission request (${(error as Error)?.message ?? "unknown error"}).`;
			} catch {}
		}
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

	// ── MCP inventory ──
	// Seed the guarded token set from host-declared servers, then refresh it
	// whenever the host reports that a server's tools changed. Widen-only:
	// removal adds nothing, so a renamed or dropped server can never unguard a
	// tool that still names a live system. The static defaults in
	// policies/mcp.ts stay the floor.
	const seedMcpInventory = async () => {
		try {
			const added = recordHostMcpServers(await listHostMcpServerNames(ctx));
			if (added.length > 0) {
				audit({
					ts: new Date().toISOString(),
					tool: "mcp.inventory",
					decision: "allow",
					phase: "event",
					reason: "host_mcp_servers_widened",
					input: { added },
				});
			}
		} catch {}
	};
	await seedMcpInventory();

	// ── Todo capability probe ──
	// Ask the host's registry whether `todowrite` exists, instead of inferring
	// it from history. On 2.0.x the answer is no, so the mutation gate fails
	// open; on 2.1.x with `experimental.todo: true` the answer is yes, so a
	// session that never planned is gated. Probe once: the registry is fixed
	// for the life of the process.
	try {
		const capability = await detectTodoCapability(ctx);
		recordTodoCapability(capability);
		audit({
			ts: new Date().toISOString(),
			tool: "todo.capability",
			decision: "allow",
			phase: "event",
			reason: `todo_capability_${capability}`,
		});
	} catch {}

	// ── Event stream ──
	// `types` is a host-side filter, so unrelated events never cross the stream
	// or reach the handler. It must list every literal `handleV2Event` acts on:
	// the test suite asserts this set matches the handler's comparisons, because
	// a missing type silently disables its feature instead of failing loudly.
	const controller = new AbortController();
	void (async () => {
		try {
			for await (const raw of ctx.event.subscribe({ types: V2_EVENT_TYPES, signal: controller.signal })) {
				const event = raw as { type?: string; data?: unknown };
				try {
					await handleV2Event(event, {
						effectiveRoot,
						client,
						toolLifecycle,
						toolOutcomes,
						refreshMcpInventory: seedMcpInventory,
					});
				} catch {}
			}
		} catch (error) {
			if (!controller.signal.aborted) throw error;
		}
	})();

	return () => {
		controller.abort();
		releasePluginInstance(instance.key);
	};
};

// ── Tool outcome telemetry ────────────────────────────────────────────────────

/**
 * Record one tool call's terminal outcome from `execute.after`.
 *
 * The former `session.message.content.updated` subscription never fired: that
 * type is absent from `EventManifest.ServerDefinitions`, so no tool part was
 * ever mapped and the repeated-failure circuit breaker plus the Policy 25
 * research floor both read an always-zero count. `execute.after` does fire,
 * including for a failed call, because the host triggers the hook with
 * `status: "error"` before it rethrows. The error's own message feeds the
 * tracker's signature, so repeat detection keys on what the model actually saw.
 */
function recordV2ToolOutcome(
	toolOutcomes: ToolOutcomeTracker,
	effectiveRoot: string,
	event: {
		tool: string;
		sessionID?: string;
		callID: string;
		status?: "completed" | "error";
		error?: { message?: string } | string;
	},
	startedAt?: number,
): void {
	const status = event.status;
	if (status !== "completed" && status !== "error") {
		// The host's `execute.after` always carries a terminal status. A partial
		// event from a harness or stub leaves it unknown, so record the
		// optimistic completion that this hook used to record unconditionally
		// rather than dropping the call from telemetry entirely. The audit row
		// is kept here so this path does not lose the coverage it had before
		// outcomes moved onto `execute.after`.
		const fallback = toolOutcomes.recordFallbackCompleted(event.sessionID ?? "", event.callID, event.tool, startedAt === undefined ? undefined : Date.now() - startedAt);
		if (fallback) {
			audit({
				ts: new Date().toISOString(),
				sessionID: fallback.sessionID,
				callID: fallback.callID,
				tool: fallback.tool,
				decision: "allow",
				phase: "outcome",
				durationMs: fallback.durationMs,
				reason: fallback.status,
			});
		}
		return;
	}
	const error = typeof event.error === "string" ? event.error : event.error?.message;
	const outcome = toolOutcomes.record({
		type: "tool",
		sessionID: event.sessionID,
		callID: event.callID,
		tool: event.tool,
		state: {
			status,
			error,
			time: startedAt === undefined ? undefined : { start: startedAt, end: Date.now() },
		},
	});
	if (!outcome) return;
	// Policy 25 research floor (V1 parity): failures accrue debt; successful
	// live-source lookups clear it. A failed research attempt never accrues
	// debt, so a flaky lookup cannot deepen the block it was meant to escape.
	if (isResearchTool(outcome.tool, getResearchToolPatterns(getSessionBoundWorkspace(outcome.sessionID) || effectiveRoot))) {
		if (outcome.status !== "error") recordResearchLookup(outcome.sessionID);
	} else if (outcome.status === "error") {
		recordLiveDocsFailure(outcome.sessionID);
	}
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

// ── Event handling ────────────────────────────────────────────────────────────

/**
 * Every event type `handleV2Event` acts on.
 *
 * The subscription passes this as the host-side `types` filter. Each entry is a
 * literal the handler compares against, so the two lists must stay identical: a
 * type missing here is never delivered, and its feature becomes dead code that
 * still type-checks. The suite asserts the match in both directions.
 *
 * Both idle triggers are listed because which one the host publishes is not
 * settled, and `session.idle` is deprecated but still delivered.
 */
export const V2_EVENT_TYPES = [
	"mcp.status.changed",
	"session.text.ended",
	"session.moved",
	"session.renamed",
	"session.execution.interrupted",
	"session.status",
	"session.idle",
	"session.deleted",
	"permission.asked",
	"permission.replied",
] as const;

export interface V2EventState {
	effectiveRoot: string;
	client: unknown;
	toolLifecycle: ToolInvocationLifecycle;
	toolOutcomes: ToolOutcomeTracker;
	/** Re-read the host MCP roster after `mcp.status.changed`. */
	refreshMcpInventory?: () => Promise<void>;
}

export async function handleV2Event(
	event: { type?: string; data?: unknown },
	state: V2EventState,
): Promise<void> {
	const { effectiveRoot, client, toolLifecycle, toolOutcomes } = state;

	if (event.type === "mcp.status.changed") {
		// A server's connection status settled (connected, failed, needs_auth,
		// closed), which is when its tools become callable. Re-read the roster
		// so a newly connected live-system server is guarded before its tools
		// can be called. Widen-only: this can add tokens, never remove them.
		// `mcp.resources.changed` is deliberately not a trigger: it reports
		// resources, not tool availability.
		await state.refreshMcpInventory?.();
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
			// Policy 26: journal sweeping repository claims unsupported by read
			// coverage. Observability only - never mutates the response text.
			const sweeping = checkSweepingClaims(text, { sessionID });
			if (sweeping.sweeping && sweeping.reason) {
				console.log(`[workflow-guard] sweeping claim mismatch: ${sweeping.reason}`);
				audit({
					ts: new Date().toISOString(),
					sessionID,
					tool: "experimental.text.complete",
					decision: "allow",
					reason: `Sweeping claim '${sweeping.claim}' with ${sweeping.readFileCount} file(s) read`,
					input: { claim: sweeping.claim, readFileCount: sweeping.readFileCount },
				});
			}
		} catch {}
		return;
	}

	if (event.type === "session.renamed") {
		// The async title write landed. A pending continuation waits on this
		// instead of polling for the full settle interval.
		const data = event.data as { sessionID?: unknown } | undefined;
		if (typeof data?.sessionID === "string") notifySessionRenamed(data.sessionID);
		return;
	}

	if (event.type === "session.moved") {
		// `session_move` relocates a session between checkouts, and the host
		// announces it. On the pinned 2.2.0 SDK the V2 union carries
		// `session.moved` and no `session.updated`, and the move event itself
		// names the destination: `data.sessionID` plus
		// `data.location.directory`. Without this rebind the session kept
		// judging the tree it left.
		const data = event.data as {
			sessionID?: unknown;
			location?: { directory?: unknown };
		} | undefined;
		const sessionID = typeof data?.sessionID === "string" ? data.sessionID : undefined;
		const directory = typeof data?.location?.directory === "string" ? data.location.directory : undefined;
		rebindSessionWorkspaceFromHost(sessionID, directory, { moved: true });
		return;
	}

	if (event.type === "session.execution.interrupted") {
		// `reason` is one of "user" | "shutdown" | "superseded" | "inactivity".
		// Only "user" is user intent (Esc), so only it suspends automatic
		// continuation. The other three are host-lifecycle events and must
		// leave continuation state alone.
		const data = event.data as { sessionID?: unknown; reason?: unknown } | undefined;
		const sessionID = typeof data?.sessionID === "string" ? data.sessionID : undefined;
		if (sessionID && data?.reason === "user") {
			// Continuation state is keyed on the SDK client plus project root,
			// so it must be reached inside the runtime state.
			await runWithRuntimeState(effectiveRoot, client, () => markInterrupted(sessionID));
		}
		return;
	}

	// Idle is the trigger for automatic continuation. The host keeps two
	// event types for it: `session.status` with `status.type === "idle"`, and
	// the deprecated `session.idle`. Both are in
	// `EventManifest.ServerDefinitions` on 2.0.15, 2.1.3, and 2.2.0, but which
	// one the server actually publishes is not settled: the TUI derives idle
	// from `session.execution.*` instead of consuming `session.status`, and an
	// upstream report says `session.status` is declared but never published.
	// Handling both keeps continuation working whichever one arrives, and adds
	// no new trigger beyond what each host already emits. A host that emits
	// both for one transition still sends a single prompt, because
	// `continueUnfinishedSession` holds a per-session in-flight lock for the
	// whole awaited send. The side effects keep their original order.
	if (event.type === "session.status" || event.type === "session.idle") {
		const data = event.data as { sessionID?: unknown; status?: { type?: unknown } } | undefined;
		if (event.type === "session.status" && data?.status?.type !== "idle") return;
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
			clearLiveDocsFloor(sessionID);
			toolOutcomes.clearSession(sessionID);
			clearTodoSessionState(sessionID);
			toolLifecycle.takeRecoveryRun(sessionID);
			await runWithRuntimeState(effectiveRoot, client, () => clearContinuationState(sessionID));
			forgetSessionWorkspace(sessionID);
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
	// - `permission.updated`: replaced by `permission.asked`/`permission.replied` above.
	// - `session.created`: V2 journals no create event; session state resets on
	//   `session.deleted`.
}
