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
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

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
	getMutationCount,
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

// ── Shared shell/env utilities ───────────────────────────────────────────────
import {
	asRecord,
	extractCommands,
	normalize,
	splitShellSegments,
	getCleanEnv,
	showBlockToast,
	SENSITIVE_ENV_KEYS,
	SENSITIVE_ENV_RE,
} from "./lib/utils.ts";

export { getCleanEnv };

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

export { getAuditFilePath, getVerifyCacheFilePath, persistVerifyCache, loadVerifyCache, getRecentAuditEntries };

// ── Verification engine ──────────────────────────────────────────────────────
import {
	detectVerifyCommand,
	runVerify,
	snipVerifyOutput,
	getCurrentGitCommitHash,
	getGitStatusSummary,
} from "./lib/verify.ts";

export {
	detectVerifyCommand,
	runVerify,
	snipVerifyOutput,
	getCurrentGitCommitHash,
	getGitStatusSummary,
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
	effectiveTodos,
	effectiveTodoOwnerSessionID,
	hasActiveTodo,
} from "./policies/todo.ts";

export { validateTodoLifecycle };

import {
	PUSH_TO_MAIN_RE,
	GIT_WRITE_RE,
	GIT_BRANCH_CREATE_RE,
	currentGitBranch,
	onProtectedBranch,
	isProtectedBranchName,
	pushedProtectedBranchIn,
	branchGuardReason,
	parseGitInvocation,
	normalizeGitCommands,
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
	hasPrCreateInvocation,
	branchHasChangelogChange,
	prBodyIncludesChangelog,
} from "./policies/changelog.ts";

import { liveMutationIn, extractEditContent } from "./policies/destructive.ts";

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

import { isSecretPath, secretIn, secretFileReadIn, isEnvFilePath, generateMaskedEnvSchema } from "./policies/secrets.ts";

export { isSecretPath, isEnvFilePath, generateMaskedEnvSchema };

import { extractInterpreterPayload } from "./policies/interpreter.ts";
export { extractInterpreterPayload };

import { branchHasDocumentationChange } from "./policies/docs.ts";
export { branchHasDocumentationChange };

import {
	checkInteractiveTtyCommand,
	checkPackageHygiene,
	sendDesktopNotification,
} from "./policies/shell-safety.ts";

import { checkCompletionClaims } from "./policies/completion.ts";

export { checkCompletionClaims };

export { checkInteractiveTtyCommand, checkPackageHygiene, sendDesktopNotification };

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

	// ── Policy 17: secret file read block via read tool ──
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
			if (isEnvFilePath(target)) {
				let schemaHint = "";
				try {
					const resolvedTarget = resolve(currentRoot, target);
					if (existsSync(resolvedTarget)) {
						const raw = readFileSync(resolvedTarget, "utf8");
						const masked = generateMaskedEnvSchema(raw);
						schemaHint = `\n\nSafe variable schema mask:\n\`\`\`\n${masked.slice(0, 800)}\n\`\`\``;
					}
				} catch {}
				return (
					`Blocked: reading sensitive credential file '${target}' directly is not permitted. ` +
					`Use environment variables or reference safe templates.${schemaHint}`
				);
			}
			return (
				`Blocked: reading sensitive credential/secret file '${target}' is not permitted. ` +
				"Reference environment variables by name or inspect safe templates (e.g. .env.example) instead."
			);
		}
		return undefined;
	}

	// ── Policy 1: todowrite lifecycle validation & finalization gates ──
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
				// Policy 19: conflict-free mergeability gate before task completion/handoff
				const conflictCheck = checkMergeConflicts(currentRoot);
				if (conflictCheck.hasConflicts) {
					const reason = `Blocked todowrite: ${conflictCheck.reason}`;
					logBlock(`[workflow-guard] ${reason}`);
					return reason;
				}

				// Policy 10: evidence-based verification
				const command = detectVerifyCommand(currentRoot);
				if (command) {
					const sessionID = context?.sessionID;
					let verifyResult = sessionID
						? sessionVerifyResults.get(sessionID)
						: lastVerify;

					// Recover durable evidence from disk when in-memory state is missing.
					// Durable evidence is bound to the workspace that produced it: without
					// this check a passing run from a different project (identical verify
					// command, non-git state) could satisfy finalization here.
					if (!verifyResult) {
						const diskCached = loadVerifyCache();
						if (
							diskCached &&
							diskCached.passed &&
							diskCached.command === command &&
							diskCached.workspaceRoot === resolve(currentRoot)
						) {
							verifyResult = diskCached;
						}
					}

					const mutationTimestamp = sessionID
						? (sessionMutationTimestamps.get(sessionID) ?? 0)
						: lastMutationTimestamp;

					const currentCommit = getCurrentGitCommitHash(currentRoot);
					const currentGitStatus = getGitStatusSummary(currentRoot);

					const gitStateMatches =
						!verifyResult?.commitHash ||
						(verifyResult.commitHash === currentCommit &&
							verifyResult.gitStatus === currentGitStatus);

					const isFresh =
						verifyResult !== undefined &&
						verifyResult.passed &&
						verifyResult.command === command &&
						verifyResult.timestamp >= mutationTimestamp &&
						gitStateMatches;

					if (!isFresh) {
						const result = await runVerify(command, currentRoot);
						recordVerifyResult(command, result, sessionID, currentRoot);
						if (!result.passed) {
							const tail = snipVerifyOutput(result.output, result.passed).slice(-500);
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

	// ── Policies 1, 6, 7, 8 & 9: edit/write/patch gates ──
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
				"or 'in_progress'), then work them through, marking " +
				"each completed via todowrite as you finish it. When every " +
				"item is completed, create a fresh todo list before " +
				"starting new work."
			);
		}
		recordMutation(await effectiveTodoOwnerSessionID(context?.sessionID));
		return undefined;
	}

	const allowLive = process.env.WORKFLOW_GUARD_ALLOW_LIVE === "1";

	// ── Policy 5: MCP tools that mutate GitHub / Azure / DevOps ──
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

		// ── Policy 22: non-interactive shell & TTY hang guard ──
		const ttyCheck = checkInteractiveTtyCommand(command);
		if (ttyCheck.isInteractive) {
			logBlock(`[workflow-guard] blocked interactive TTY command: ${command.slice(0, 100)}`);
			return (
				`Blocked: '${command.slice(0, 60)}' is an ${ttyCheck.name} and will hang non-interactive agent execution. ` +
				`${ttyCheck.advice}`
			);
		}

		// ── Policy 23: package supply-chain & dependency hygiene guard ──
		const packageCheck = checkPackageHygiene(command);
		if (packageCheck.isViolating && !allowLive) {
			logBlock(`[workflow-guard] blocked package supply-chain violation: ${command.slice(0, 100)}`);
			return (
				`Blocked: '${command.slice(0, 60)}' is a ${packageCheck.name}. ` +
				`${packageCheck.advice}`
			);
		}

		const normalizedCommand = normalizeGitCommands(command);
		const gitInvocations = splitShellSegments(command)
			.map((segment) => parseGitInvocation(segment.trim()))
			.filter((invocation): invocation is NonNullable<ReturnType<typeof parseGitInvocation>> => invocation !== undefined);
		const effectiveRoot = gitInvocations[0]?.repoDir ?? currentRoot;

		// Workspace boundary check for external git repo targets
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

		// ── Policy 7: changes only on feature branches ──
		for (const invocation of gitInvocations) {
			if (GIT_WRITE_RE.test(`git ${invocation.rest}`) && onProtectedBranch(invocation.repoDir)) {
				logBlock(
					`[workflow-guard] blocked git write on protected branch: ${command.slice(0, 120)}`,
				);
				return branchGuardReason();
			}
		}

		// Policy 20: base freshness when creating a fresh branch
		if (GIT_BRANCH_CREATE_RE.test(normalizedCommand)) {
			const behindCheck = checkBranchBaseIsUpToDate(effectiveRoot);
			if (behindCheck.isBehind) {
				logBlock(
					`[workflow-guard] blocked branch creation: base is behind remote ${behindCheck.baseRef}`,
				);
				return `Blocked: ${behindCheck.reason}`;
			}
		}

		// ── Policy 6: block self-modification of approval gates ──
		if (isSettingsTamper(command)) {
			logBlock(
				`[workflow-guard] blocked settings tamper: ${command.slice(0, 120)}`,
			);
			return PROTECTED_PATH_REASON;
		}

		// ── Policy 17: secret file reads via shell ──
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

		// ── Policy 18: interpreter inline evasion scanner ──
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

		// ── Policies 1, 7 & 8: shell file mutations get the same gates as edits ──
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

		// ── Policy 4: live-system mutations (env var is the ONLY override) ──
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

		// ── Policy 2: block git push to main/master ──
		if (PUSH_TO_MAIN_RE.test(normalizedCommand)) {
			logBlock(
				`[workflow-guard] blocked push to main/master: ${command}`,
			);
			return (
				"Blocked: direct pushes to main/master are not allowed. " +
				"Create a feature branch and open a PR instead."
			);
		}
		// Policy 2 (cont.): configured protected branches receive the same
		// destination-side push protection as main/master.
		for (const invocation of gitInvocations) {
			const pushText = `git ${invocation.rest}`;
			if (!/\bgit\s+push\b/.test(pushText)) continue;
			const pushedBranch = pushedProtectedBranchIn(pushText, invocation.repoDir);
			if (pushedBranch) {
				logBlock(
					`[workflow-guard] blocked push to protected branch '${pushedBranch}': ${command}`,
				);
				return (
					`Blocked: direct pushes to protected branch '${pushedBranch}' are not allowed. ` +
					"Create a feature branch and open a PR instead."
				);
			}
		}

		// ── Policy 20: block push from protected or already-merged branches ──
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

		// ── Policy 3: PRs must include a changelog (GitHub & Azure DevOps) ──
		if (hasPrCreateInvocation(raw)) {
			const isAz = /\baz\s+repos\s+pr\s+create\b/.test(normalizedCommand);
			const prTool = isAz ? "az repos pr create" : "gh pr create";
			const descFlag = isAz ? "--description" : "--body";

			// Policy 19: conflict-free mergeability gate before opening PR
			const conflictCheck = checkMergeConflicts(currentRoot);
			if (conflictCheck.hasConflicts) {
				logBlock(`[workflow-guard] blocked ${prTool}: merge conflicts detected`);
				return `Blocked: ${conflictCheck.reason}`;
			}

			// Policy 20: branch already merged/closed
			const branch = currentGitBranch(currentRoot);
			if (branch) {
				const mergedStatus = isBranchAlreadyMergedOrClosed(currentRoot, branch);
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

			// Policy 21: documentation review & update check
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
				logBlock(`[workflow-guard] blocked ${prTool}: no changelog found`);
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

/**
 * Public guard entry point. Audits every decision (block or allow) to a
 * durable JSONL file before returning.
 */
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

async function emitBlockFeedback(message: string): Promise<void> {
	try {
		sendDesktopNotification("Workflow Guard Blocked", message);
	} catch {}
	await showBlockToast(message);
}

export const WorkflowGuard: Plugin = async (ctx) => {
	// Honor worktree if present (e.g. opencode worktrees or devcontainers)
	// so worktree plugins cannot punch through boundary gates.
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
			return runWithRuntimeState(effectiveRoot, ctx.client, async () => {
				const args =
					(output as { args?: unknown } | undefined)?.args ??
					(input as { args?: unknown }).args;
				const reason = await guardToolCall(input.tool, args, {
					sessionID: input.sessionID,
				});
				if (reason !== undefined) {
					await emitBlockFeedback(reason);
					throw new Error(`[workflow-guard] ${reason}`);
				}
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
				contextBlocks.push(stateLines.join("\n"));

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
					logBlock(`[workflow-guard] completion claim mismatch: ${check.reason}`);
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

		// Keep tool descriptions honest: todowrite's description reflects the
		// finalization gates so the model is not surprised by verification blocks.
		"tool.definition": async (input, output) => {
			if (input.toolID !== "todowrite") return;
			const description = typeof output.description === "string" ? output.description : "";
			if (description.includes("verification evidence")) return;
			output.description =
				description +
				"\n\nNote: marking every task completed triggers the workflow guard's finalization gate - fresh verification evidence (test run) is required after the last mutation, and protected-branch/conflict checks apply.";
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

// Default export MUST be a V1 PluginModule record.
export default {
	id: "workflow-guard",
	server: WorkflowGuard,
} satisfies PluginModule;
