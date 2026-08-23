/**
 * Workflow Guard Plugin for OpenCode (hooks-only - no prompt rules)
 *
 * Deterministic enforcement via the tool.execute.before plugin hook.
 * Throwing from the hook blocks the tool call outright.
 */

import { tool, type Plugin, type PluginModule } from "@opencode-ai/plugin";

// Re-export types
export type {
	TodoItem,
	TodoSdkClient,
	ProjectConfig,
	VerifyResult,
	ReviewResult,
	AuditEntry,
	GitInvocation,
	ShellMutation,
} from "./lib/types.ts";

// Re-export state & utils
import {
	setWorkspaceRoot,
	getWorkspaceRoot,
	setSdkClient,
	getSdkClient,
	runWithRuntimeState,
	lastMutationTimestamp,
	getLastMutationTimestamp,
	lastVerify,
	getLastVerifyResult,
	recordMutation,
	recordVerifyResult,
	resetVerifyState,
	sessionMutationTimestamps,
	sessionVerifyResults,
	loadProjectConfig,
	reloadProjectConfig,
	isReviewRequired,
	isDocumentationRequired,
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
	getLastVerifyResult,
	recordMutation,
	recordVerifyResult,
	resetVerifyState,
	loadProjectConfig,
	reloadProjectConfig,
	isReviewRequired,
	isDocumentationRequired,
	recordReviewResult,
	getLastReviewResult,
	resetReviewState,
};

import {
	asRecord,
	extractCommands,
	normalize,
	splitShellSegments,
	unwrapShellCommand,
	getCleanEnv,
	showBlockToast,
	SENSITIVE_ENV_KEYS,
	SENSITIVE_ENV_RE,
} from "./lib/utils.ts";

export { getCleanEnv };

import {
	getAuditFilePath,
	getRecentAuditEntries,
	audit,
	logDecision,
	summarizeInput,
} from "./lib/audit.ts";

export { getAuditFilePath, getRecentAuditEntries };

import { detectVerifyCommand, runVerify } from "./lib/verify.ts";
export { detectVerifyCommand, runVerify };

import { buildReviewRubric } from "./lib/review.ts";
export { buildReviewRubric };

// Re-export policies
import {
	EDIT_TOOL_NAMES,
	validateTodoLifecycle,
	fetchSessionTodos,
	fetchParentSessionID,
	effectiveTodos,
	effectiveTodoOwnerSessionID,
	hasActiveTodo,
} from "./policies/todo.ts";

export { validateTodoLifecycle };

import {
	PROTECTED_BRANCHES,
	PUSH_TO_MAIN_RE,
	GIT_WRITE_RE,
	GIT_BRANCH_CREATE_RE,
	currentGitBranch,
	onProtectedBranch,
	branchGuardReason,
	parseGitInvocation,
	normalizeGitCommands,
	isBranchAlreadyMergedOrClosed,
	checkMergeConflicts,
	checkBranchBaseIsUpToDate,
} from "./policies/git.ts";

export {
	isBranchAlreadyMergedOrClosed,
	checkMergeConflicts,
	checkBranchBaseIsUpToDate,
};

import {
	hasPrCreateInvocation,
	branchHasChangelogChange,
	prBodyIncludesChangelog,
} from "./policies/changelog.ts";

import {
	liveMutationIn,
	extractEditContent,
} from "./policies/destructive.ts";

import { mcpMutationTool } from "./policies/mcp.ts";

import {
	PROTECTED_PATH_REASON,
	isProtectedPath,
	isSettingsTamper,
} from "./policies/tamper.ts";

export { isProtectedPath };

import {
	isPathOutsideWorkspace,
	extractPatchPaths,
	guardShellMutation,
} from "./policies/boundary.ts";

import {
	isSecretPath,
	secretIn,
	secretFileReadIn,
} from "./policies/secrets.ts";

export { isSecretPath };

import { extractInterpreterPayload } from "./policies/interpreter.ts";
export { extractInterpreterPayload };

import { branchHasDocumentationChange } from "./policies/docs.ts";
export { branchHasDocumentationChange };

const SHELL_TOOL_NAMES = new Set(["bash", "run_commands", "execute_command", "shell"]);

function logBlock(message: string): void {
	try {
		void (getSdkClient() as any)?.app?.log?.({
			body: {
				service: "workflow-guard",
				level: "warn",
				message,
			},
		});
	} catch {}
}

async function guardToolCallImpl(
	toolName: string,
	input: unknown,
	context?: { sessionID?: string },
): Promise<string | undefined> {
	const currentRoot = getWorkspaceRoot();

	if (toolName === "read" || toolName === "read_file") {
		const record = asRecord(input);
		const target =
			typeof record?.filePath === "string"
				? record.filePath
				: typeof record?.path === "string"
					? record.path
					: typeof input === "string"
						? input
						: "";
		if (target && isSecretPath(target)) {
			logBlock(`[workflow-guard] blocked read: secret file ${target}`);
			return (
				`Blocked: reading sensitive credential/secret file '${target}' is not permitted. ` +
				"Reference environment variables by name or inspect safe templates (e.g. .env.example) instead."
			);
		}
		return undefined;
	}

	if (toolName === "todowrite") {
		const record = asRecord(input);
		const rawTodos = record?.todos;
		if (Array.isArray(rawTodos)) {
			const newTodos = rawTodos as any[];
			const existingTodos = context?.sessionID
				? await fetchSessionTodos(context.sessionID)
				: undefined;
			const err = validateTodoLifecycle(newTodos, existingTodos);
			if (err) {
				logBlock(`[workflow-guard] ${err}`);
				return err;
			}

			const allDone =
				newTodos.length > 0 &&
				newTodos.every((t) => {
					const s = String(t.status ?? "");
					return s === "completed" || s === "cancelled";
				});
			if (allDone) {
				const conflictCheck = checkMergeConflicts(currentRoot);
				if (conflictCheck.hasConflicts) {
					const reason = `Blocked todowrite: ${conflictCheck.reason}`;
					logBlock(`[workflow-guard] ${reason}`);
					return reason;
				}

				const command = detectVerifyCommand(currentRoot);
				if (command) {
					const sessionID = context?.sessionID;
					const verifyResult = sessionID
						? sessionVerifyResults.get(sessionID)
						: lastVerify;
					const mutationTimestamp = sessionID
						? (sessionMutationTimestamps.get(sessionID) ?? 0)
						: lastMutationTimestamp;
					const isFresh =
						verifyResult !== undefined &&
						verifyResult.passed &&
						verifyResult.command === command &&
						verifyResult.timestamp >= mutationTimestamp;

					if (!isFresh) {
						const result = await runVerify(command, currentRoot);
						recordVerifyResult(command, result, sessionID);
						if (!result.passed) {
							const tail = result.output.slice(-500);
							const reason =
								`Blocked todowrite: all tasks marked done but verification is failing ` +
								`(${command}). Fix the failure before finishing; ` +
								`output tail: ${tail}`;
							logBlock(`[workflow-guard] ${reason}`);
							return reason;
						}
					}
				}
			}
		}
		return undefined;
	}

	if (EDIT_TOOL_NAMES.has(toolName)) {
		const allowLive = process.env.WORKFLOW_GUARD_ALLOW_LIVE === "1";
		const record = asRecord(input);
		const target =
			typeof record?.filePath === "string"
				? record.filePath
				: typeof record?.path === "string"
					? record.path
					: typeof input === "string"
						? input
						: "";

		if (target && isProtectedPath(target)) {
			logBlock(`[workflow-guard] blocked ${toolName}: protected path ${target}`);
			return PROTECTED_PATH_REASON;
		}
		if (target && isSecretPath(target) && !allowLive) {
			logBlock(`[workflow-guard] blocked ${toolName}: secret file path ${target}`);
			return (
				`Blocked: modifying secret file '${target}' directly is not permitted. ` +
				"Store credentials in environment variables or safe secret stores instead."
			);
		}
		if (toolName === "apply_patch") {
			const patchText =
				typeof record?.patchText === "string" ? record.patchText : "";
			for (const patchPath of extractPatchPaths(patchText)) {
				if (isProtectedPath(patchPath)) {
					logBlock(
						`[workflow-guard] blocked apply_patch: protected path ${patchPath}`,
					);
					return PROTECTED_PATH_REASON;
				}
				if (isSecretPath(patchPath) && !allowLive) {
					logBlock(
						`[workflow-guard] blocked apply_patch: secret file path ${patchPath}`,
					);
					return `Blocked: modifying secret file '${patchPath}' directly is not permitted.`;
				}
				if (isPathOutsideWorkspace(patchPath, currentRoot)) {
					logBlock(
						`[workflow-guard] blocked apply_patch: patch target escapes workspace: ${patchPath}`,
					);
					return `Blocked: patch targets file '${patchPath}' outside workspace root (${currentRoot}).`;
				}
			}
		}

		if (target && isPathOutsideWorkspace(target, currentRoot)) {
			logBlock(
				`[workflow-guard] blocked ${toolName}: path escapes workspace: ${target}`,
			);
			return `Blocked: file path '${target}' escapes workspace root (${currentRoot}). All changes must stay within the workspace.`;
		}

		for (const content of extractEditContent(input)) {
			const secret = secretIn(content);
			if (secret) {
				logBlock(
					`[workflow-guard] blocked ${toolName}: payload contains ${secret}`,
				);
				return (
					`Blocked: payload appears to contain a ${secret}. ` +
					"Secrets must not be committed to the repository. Store them " +
					"in a secret manager or environment file excluded from git, " +
					"and reference them by name instead."
				);
			}
		}

		if (!allowLive) {
			for (const content of extractEditContent(input)) {
				const lines = content.split("\n");
				for (const line of lines) {
					const trimmed = line.trim();
					if (trimmed.startsWith("#") || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
						continue;
					}
					const normalizedContent = normalizeGitCommands(line);
					const what = liveMutationIn(normalizedContent);
					if (what) {
						logBlock(
							`[workflow-guard] blocked ${toolName}: payload contains ${what}`,
						);
						return (
							`Blocked: the file you are writing contains a ${what}. ` +
							"Script files are not a way to smuggle destructive commands " +
							"past the shell guard. Only the user can allow live mutations " +
							"(WORKFLOW_GUARD_ALLOW_LIVE=1)."
						);
					}
				}
			}
			for (const content of extractEditContent(input)) {
				if (isSettingsTamper(content)) {
					logBlock(
						`[workflow-guard] blocked ${toolName}: payload tampers with settings`,
					);
					return PROTECTED_PATH_REASON;
				}
			}
		}

		if (onProtectedBranch(currentRoot)) {
			logBlock(
				`[workflow-guard] blocked ${toolName}: on protected branch ${currentGitBranch(currentRoot)}`,
			);
			return branchGuardReason();
		}
		const todos = await effectiveTodos(context?.sessionID);
		if (todos !== undefined && !hasActiveTodo(todos)) {
			logBlock(
				`[workflow-guard] blocked ${toolName}: no active todo item (session ${context?.sessionID ?? "?"})`,
			);
			return (
				"Blocked: no active todo item. First break the request down " +
				"with the todowrite tool (create items with status 'pending' " +
				"or 'in_progress'), then work them top to bottom, marking " +
				"each completed via todowrite as you finish it. When every " +
				"item is completed, create a fresh todo list before " +
				"starting new work."
			);
		}
		recordMutation(await effectiveTodoOwnerSessionID(context?.sessionID));
		return undefined;
	}

	const allowLive = process.env.WORKFLOW_GUARD_ALLOW_LIVE === "1";

	if (!allowLive) {
		const mcpWhat = mcpMutationTool(toolName);
		if (mcpWhat) {
			logBlock(
				`[workflow-guard] blocked MCP tool ${toolName} (${mcpWhat} mutation)`,
			);
			return (
				`Blocked: ${toolName} mutates ${mcpWhat} - a live ` +
				"system. Changes must be made in code unless the user " +
				"explicitly allows live changes. Only the user can override " +
				"this, via the WORKFLOW_GUARD_ALLOW_LIVE=1 environment " +
				"variable set before launching the agent."
			);
		}
	}

	if (!SHELL_TOOL_NAMES.has(toolName)) {
		return undefined;
	}

	const commands = extractCommands(input);
	for (const raw of commands) {
		const command = normalize(raw);
		const normalizedCommand = normalizeGitCommands(command);
		const gitInvocations = splitShellSegments(command)
			.map((segment) => parseGitInvocation(segment.trim()))
			.filter((invocation): invocation is NonNullable<ReturnType<typeof parseGitInvocation>> => invocation !== undefined);
		const effectiveRoot = gitInvocations[0]?.repoDir ?? currentRoot;

		for (const invocation of gitInvocations) {
			const normalizedInvocation = `git ${invocation.rest}`;
			if (
				isPathOutsideWorkspace(invocation.repoDir, currentRoot) &&
				!allowLive &&
				(GIT_WRITE_RE.test(normalizedInvocation) || /\bgit\s+push\b/.test(normalizedInvocation))
			) {
				logBlock(`[workflow-guard] blocked git mutation on repository outside workspace: ${invocation.repoDir}`);
				return `Blocked: git command targets repository '${invocation.repoDir}' outside workspace root (${currentRoot}). All changes must stay within the workspace.`;
			}
		}

		for (const invocation of gitInvocations) {
			if (GIT_WRITE_RE.test(`git ${invocation.rest}`) && onProtectedBranch(invocation.repoDir)) {
				logBlock(
					`[workflow-guard] blocked git write on protected branch: ${command.slice(0, 120)}`,
				);
				return branchGuardReason();
			}
		}

		if (GIT_BRANCH_CREATE_RE.test(normalizedCommand)) {
			const behindCheck = checkBranchBaseIsUpToDate(effectiveRoot);
			if (behindCheck.isBehind) {
				logBlock(
					`[workflow-guard] blocked branch creation: base is behind remote ${behindCheck.baseRef}`,
				);
				return `Blocked: ${behindCheck.reason}`;
			}
		}

		if (isSettingsTamper(command)) {
			logBlock(
				`[workflow-guard] blocked settings tamper: ${command.slice(0, 120)}`,
			);
			return PROTECTED_PATH_REASON;
		}

		if (!allowLive) {
			for (const segment of command.split(/[\n|;&]+/)) {
				const secretFile = secretFileReadIn(segment.trim());
				if (secretFile) {
					logBlock(
						`[workflow-guard] blocked shell read of secret file: ${secretFile}`,
					);
					return (
						`Blocked: reading sensitive credential/secret file '${secretFile}' via shell is not permitted. ` +
						"Reference environment variables by name or inspect safe templates (e.g. .env.example) instead."
					);
				}
			}
		}

		if (!allowLive) {
			for (const payload of extractInterpreterPayload(command)) {
				const normPayload = normalizeGitCommands(normalize(payload));
				const liveCheck = liveMutationIn(normPayload);
				if (liveCheck) {
					logBlock(
						`[workflow-guard] blocked interpreter payload containing ${liveCheck}`,
					);
					return `Blocked: inline interpreter script contains a ${liveCheck}. Interpreter payloads cannot smuggle live destructive commands past the guard.`;
				}
				if (isSettingsTamper(payload)) {
					logBlock(
						`[workflow-guard] blocked interpreter payload with settings tamper`,
					);
					return PROTECTED_PATH_REASON;
				}
			}
		}

		const shellMutationReason = await guardShellMutation(
			command,
			context?.sessionID,
		);
		if (shellMutationReason) {
			logBlock(
				`[workflow-guard] blocked shell mutation: ${command.slice(0, 120)}`,
			);
			return shellMutationReason;
		}

		if (!allowLive) {
			const what = liveMutationIn(normalizedCommand) ?? liveMutationIn(command);
			if (what) {
				logBlock(
					`[workflow-guard] blocked ${what}: ${command.slice(0, 120)}`,
				);
				return (
					`Blocked: ${what} targets a live system. Changes must be ` +
					"made in code (IaC, migrations, source) unless the user " +
					"explicitly allows live changes. Only the user can override " +
					"this, via the WORKFLOW_GUARD_ALLOW_LIVE=1 environment " +
					"variable set before launching the agent."
				);
			}
		}

		if (PUSH_TO_MAIN_RE.test(normalizedCommand)) {
			logBlock(
				`[workflow-guard] blocked push to main/master: ${command}`,
			);
			return (
				"Blocked: direct pushes to main/master are not allowed. " +
				"Create a feature branch and open a PR instead."
			);
		}
		for (const invocation of gitInvocations) {
			if (!/\bgit\s+push\b/.test(`git ${invocation.rest}`)) continue;
			if (onProtectedBranch(invocation.repoDir)) {
				logBlock(`[workflow-guard] blocked push from protected branch: ${command}`);
				return branchGuardReason();
			}
			const branch = currentGitBranch(invocation.repoDir);
			if (branch) {
				const mergedStatus = isBranchAlreadyMergedOrClosed(
					invocation.repoDir,
					branch,
				);
				if (mergedStatus.merged) {
					logBlock(
						`[workflow-guard] blocked push to merged/closed branch: ${branch}`,
					);
					return `Blocked: ${mergedStatus.reason}`;
				}
			}
		}

		if (hasPrCreateInvocation(raw)) {
			const isAz = /\baz\s+repos\s+pr\s+create\b/.test(normalizedCommand);
			const prTool = isAz ? "az repos pr create" : "gh pr create";
			const descFlag = isAz ? "--description" : "--body";

			const conflictCheck = checkMergeConflicts(currentRoot);
			if (conflictCheck.hasConflicts) {
				logBlock(`[workflow-guard] blocked ${prTool}: merge conflicts detected`);
				return `Blocked: ${conflictCheck.reason}`;
			}

			const branch = currentGitBranch(currentRoot);
			if (branch) {
				const mergedStatus = isBranchAlreadyMergedOrClosed(
					currentRoot,
					branch,
				);
				if (mergedStatus.merged) {
					logBlock(
						`[workflow-guard] blocked ${prTool}: branch already merged/closed`,
					);
					return `Blocked: ${mergedStatus.reason}`;
				}
			}

			if (isReviewRequired(currentRoot)) {
				const review = context?.sessionID
					? (sessionReviews.get(context.sessionID) ?? getLastReviewResult())
					: getLastReviewResult();
				const reviewMatchesContext =
					review?.passed === true &&
					(!review.workspace || review.workspace === currentRoot) &&
					(!review.targetSessionID || review.targetSessionID === context?.sessionID);
				if (!reviewMatchesContext) {
					logBlock(`[workflow-guard] blocked ${prTool}: review approval required`);
					return (
						`Blocked: PR creation requires a passing review approval. ` +
						"Invoke a secondary review subagent to record an approval using the record_review tool first."
					);
				}
			}

			if (isDocumentationRequired(currentRoot)) {
				const hasDocChange = branchHasDocumentationChange(currentRoot);
				if (!hasDocChange) {
					logBlock(`[workflow-guard] blocked ${prTool}: documentation update required`);
					return (
						`Blocked: PR requires documentation updates (Policy 21). ` +
						"Update README.md or relevant documentation in docs/ before opening a PR."
					);
				}
			}

			const branchChangelog = branchHasChangelogChange(currentRoot);
			const prSegments = splitShellSegments(raw)
				.filter((segment) => hasPrCreateInvocation(segment));
			const hasChangelog =
				branchChangelog ||
				prSegments.every((segment) => prBodyIncludesChangelog(segment));
			if (!hasChangelog) {
				const isAz = /\baz\s+repos\s+pr\s+create\b/.test(normalizedCommand);
				const prTool = isAz ? "az repos pr create" : "gh pr create";
				const descFlag = isAz ? "--description" : "--body";
				logBlock(
					`[workflow-guard] blocked ${prTool}: no changelog found`,
				);
				return (
					`Blocked: PR must include a changelog. Either update a ` +
					`CHANGELOG file in this branch's diff, or include a ` +
					`'Changelog:' section in the PR description (${descFlag}).`
				);
			}
		}

		const hasGitMutation = gitInvocations.some((invocation) => {
			const normalizedInvocation = `git ${invocation.rest}`;
			return (
				GIT_WRITE_RE.test(normalizedInvocation) ||
				/\bgit\s+(?:switch|checkout)\b/.test(normalizedInvocation)
			);
		});
		if (hasGitMutation) {
			recordMutation(await effectiveTodoOwnerSessionID(context?.sessionID));
		}
	}

	return undefined;
}

export async function guardToolCall(
	toolName: string,
	input: unknown,
	context?: { sessionID?: string },
): Promise<string | undefined> {
	const reason = await guardToolCallImpl(toolName, input, context);
	const allowLive = process.env.WORKFLOW_GUARD_ALLOW_LIVE === "1";
	const isMutation = EDIT_TOOL_NAMES.has(toolName);
	const record = asRecord(input);
	const targetPath =
		typeof record?.filePath === "string"
			? record.filePath
			: typeof record?.path === "string"
				? record.path
				: undefined;
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

export const WorkflowGuard: Plugin = async (ctx) => {
	const effectiveRoot = ctx.worktree || ctx.directory || process.cwd();
	setWorkspaceRoot(effectiveRoot);
	setSdkClient(ctx.client);
	reloadProjectConfig(effectiveRoot);

	try {
		await (ctx.client as any)?.app?.log?.({
			body: {
				service: "workflow-guard",
				level: "info",
				message: `Workflow Guard plugin initialized for ${effectiveRoot}`,
			},
		});
	} catch {}

	return {
		tool: {
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
							lastVerify: lastV
								? {
										command: lastV.command,
										passed: lastV.passed,
										fresh: lastV.timestamp >= lastMut,
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
					"Record a secondary reviewer agent's approval or critique of the current changes.",
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
					recordReviewResult(
						args.reviewer,
						args.summary,
						args.passed,
						parentSessionID,
						toolContext.worktree || toolContext.directory,
					);
					return args.passed
						? `[workflow-guard] Review recorded as APPROVED by ${args.reviewer}.`
						: `[workflow-guard] Review recorded as CHANGES REQUESTED by ${args.reviewer}.`;
				},
			}),
		},

		"tool.execute.before": async (input, output) => {
			return runWithRuntimeState(effectiveRoot, ctx.client, async () => {
				const args =
					(output as { args?: unknown } | undefined)?.args ??
					(input as { args?: unknown }).args;
				const reason = await guardToolCall(input.tool, args, {
					sessionID: input.sessionID,
				});
				if (reason !== undefined) {
					await showBlockToast(reason);
					throw new Error(`[workflow-guard] ${reason}`);
				}
			});
		},

		"tool.execute.after": async (input) => {
			return;
		},

		"experimental.session.compacting": async (input, output) => {
			try {
				const sessionID = (input as { sessionID?: string })?.sessionID;
				const todos = await effectiveTodos(sessionID);
				const active = todos?.filter((t) => {
					const s = String(t.status ?? "");
					return s === "pending" || s === "in_progress";
				});
				if (active && active.length > 0) {
					const lines = active.map(
						(t) =>
							`- [${String(t.status) === "in_progress" ? "IN PROGRESS" : "PENDING"}] ${String(t.content ?? "")}`,
					);
					const contextPrompt =
						"## Active Tasks (Sequential Order Required)\n" +
						lines.join("\n") +
						"\nStrict focus rule: complete the in-progress task before starting another.";
					if (Array.isArray(output?.context)) {
						output.context.push(contextPrompt);
					}
				}
			} catch {}
		},

		"shell.env": async (input, output) => {
			try {
				const env = (output as { env?: Record<string, string> }).env;
				if (env && typeof env === "object") {
					const scrubbed: string[] = [];
					for (const key of SENSITIVE_ENV_KEYS) {
						if (key in env && env[key] !== "") {
							env[key] = "";
							scrubbed.push(key);
						}
					}
					for (const key of Object.keys(env)) {
						if (SENSITIVE_ENV_RE.test(key) && env[key] !== "") {
							env[key] = "";
							scrubbed.push(key);
						}
					}
					if (scrubbed.length > 0) {
						try {
							const client = getSdkClient();
							await (client as any)?.app?.log?.({
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

		event: async ({
			event,
		}: { event: { type?: string; properties?: unknown } }) => {
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

export default {
	id: "workflow-guard",
	server: WorkflowGuard,
} satisfies PluginModule;
