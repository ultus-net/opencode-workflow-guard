import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadVerifyCache } from "./audit.ts";
import { isEvidenceFresh, reviewEvidence, verificationEvidence } from "./evidence.ts";
import { projectRootKey } from "./project-config.ts";
import {
	getLastReviewResult,
	getSdkClient,
	getWorkspaceRoot,
	isDocumentationRequired,
	isReviewRequired,
	lastMutationTimestamp,
	lastVerify,
	recordMutation,
	recordVerifyResult,
	sessionMutationTimestamps,
	sessionReviews,
	sessionVerifyResults,
} from "./state.ts";
import {
	dynamicShellSyntaxIn,
	extractCommands,
	normalize,
	shellWrappersChangeCwd,
	splitShellSegments,
	unwrapShellCommand,
} from "./shell.ts";
import { asRecord, extractTargetPath } from "./utils.ts";
import type { PolicyDecision } from "./types.ts";
import { getProjectMemoryIdentity } from "./project-memory.ts";
import {
	detectVerifyCommand,
	getCurrentGitCommitHash,
	getGitStatusSummary,
	getGitWorktreeFingerprint,
	runVerify,
	snipVerifyOutput,
} from "./verify.ts";
import { detectShellMutation, extractPatchPaths, guardShellMutation, isPathOutsideWorkspace } from "../policies/boundary.ts";
import { branchHasChangelogChange, checkLockfileSync, hasPrCreateInvocation, prBodyHasLiteralLineBreakEscapes, prBodyIncludesChangelog } from "../policies/changelog.ts";
import { extractEditContent, liveMutationIn } from "../policies/destructive.ts";
import { branchHasDocumentationChange } from "../policies/docs.ts";
import { claimFiles, fileClaimConflictReason } from "../policies/file-claims.ts";
import {
	GIT_BRANCH_CREATE_RE,
	GIT_WRITE_RE,
	PUSH_TO_MAIN_RE,
	branchGuardReason,
	checkBranchBaseIsUpToDate,
	checkMergeConflicts,
	currentGitBranch,
	hasUnsafeGitAlias,
	isBranchAlreadyMergedOrClosed,
	normalizeGitCommands,
	onProtectedBranch,
	parseGitInvocation,
	pushedProtectedBranchIn,
} from "../policies/git.ts";
import { extractInterpreterPayload, outsideWritePathInPayload, secretPathInPayload, writePathsInPayload } from "../policies/interpreter.ts";
import { mcpMutationTool } from "../policies/mcp.ts";
import { editTargets } from "../policies/post-edit-validation.ts";
import { generateMaskedEnvSchema, isEnvFilePath, isSecretPath, secretFileReadIn, secretIn } from "../policies/secrets.ts";
import { checkInteractiveTtyCommand, checkPackageHygiene } from "../policies/shell-safety.ts";
import { staleWriteReason } from "../policies/stale-write.ts";
import { PROTECTED_PATH_REASON, isProtectedPath, isSettingsTamper } from "../policies/tamper.ts";
import {
	EDIT_TOOL_NAMES,
	effectiveTodoOwnerSessionID,
	effectiveTodos,
	fetchSessionTodos,
	hasActiveTodo,
	subagentMutationBudgetReason,
	validateTodoLifecycle,
} from "../policies/todo.ts";

const SHELL_TOOL_NAMES = new Set(["bash", "run_commands", "execute_command", "shell"]);

const READ_ONLY_ROLES = new Set([
	"reviewer",
	"planner",
	"advisor",
	"critic",
	"explorer",
	"scout",
	"evaluator",
]);

export function isReadOnlyRole(agent?: string): boolean {
	if (!agent) return false;
	const lower = agent.toLowerCase().trim();
	return READ_ONLY_ROLES.has(lower) || Array.from(READ_ONLY_ROLES).some((r) => lower.includes(r));
}

function logBlock(message: string, simulate = false): void {
	if (simulate) return;
	try {
		void getSdkClient()?.app?.log?.({
			body: {
				service: "workflow-guard",
				level: "warn",
				message,
			},
		});
	} catch {}
}

export async function guardToolCallImpl(
	toolName: string,
	input: unknown,
	context?: { sessionID?: string; callID?: string; worktree?: string; directory?: string; agent?: string; simulate?: boolean },
): Promise<PolicyDecision> {
	const logPolicyBlock = (message: string) => logBlock(message, context?.simulate);
	const currentRoot = getWorkspaceRoot();
	const allow = (): PolicyDecision => ({ status: "allowed", code: "allowed", message: "Allowed by current guardrails." });
	const block = (policy: string, code: string, message: string): PolicyDecision => ({ status: "blocked", policy, code, message });
	const needsApproval = (policy: string, code: string, message: string): PolicyDecision => ({ status: "needs_approval", policy, code, message });
	let remotePrStateUnchecked = false;

	if (context?.agent && isReadOnlyRole(context.agent)) {
		if (EDIT_TOOL_NAMES.has(toolName) || toolName.startsWith("guard_worktree_")) {
			const reason = `Blocked: subagent with read-only role '${context.agent}' cannot perform file mutations or lifecycle changes.`;
			logPolicyBlock(`[workflow-guard] ${reason}`);
			return block("subagent-role", "read_only_role", reason);
		}
	}

	if (toolName === "read" || toolName === "read_file") {
		const target = extractTargetPath(input) ?? "";
		if (target && isSecretPath(target)) {
			logPolicyBlock(`[workflow-guard] blocked read: secret file ${target}`);
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
				return block("secrets", "secret_read", `Blocked: reading sensitive credential file '${target}' directly is not permitted. Use environment variables or reference safe templates.${schemaHint}`);
			}
			return block("secrets", "secret_read", `Blocked: reading sensitive credential/secret file '${target}' is not permitted. Reference environment variables by name or inspect safe templates (e.g. .env.example) instead.`);
		}
		return allow();
	}

	if (toolName === "todowrite") {
		const record = asRecord(input);
		const rawTodos = record?.todos;
		if (Array.isArray(rawTodos)) {
			const newTodos = rawTodos;
			const existingTodos = context?.sessionID ? await fetchSessionTodos(context.sessionID) : undefined;
			const err = validateTodoLifecycle(newTodos, existingTodos);
			if (err) {
				logPolicyBlock(`[workflow-guard] ${err}`);
				return block("todo", "todo_lifecycle", err);
			}
			const allDone = newTodos.length > 0 && newTodos.every((t) => {
				const s = String(t.status ?? "");
				return s === "completed" || s === "cancelled";
			});
			if (allDone) {
				const conflictCheck = checkMergeConflicts(currentRoot);
				if (conflictCheck.hasConflicts) {
					const reason = `Blocked todowrite: ${conflictCheck.reason}`;
					logPolicyBlock(`[workflow-guard] ${reason}`);
					return block("git", "merge_conflict", reason);
				}
				const command = detectVerifyCommand(currentRoot);
				if (command) {
					const sessionID = context?.sessionID;
					let verifyResult = sessionID ? sessionVerifyResults.get(sessionID) : lastVerify;
					if (!verifyResult) {
						const diskCached = loadVerifyCache();
						if (diskCached && diskCached.passed && diskCached.command === command && diskCached.workspaceRoot && projectRootKey(diskCached.workspaceRoot) === projectRootKey(currentRoot)) verifyResult = diskCached;
					}
					const mutationTimestamp = sessionID ? (sessionMutationTimestamps.get(sessionID) ?? 0) : lastMutationTimestamp;
					const currentSubject = { workspace: projectRootKey(currentRoot), commitHash: getCurrentGitCommitHash(currentRoot), worktreeFingerprint: getGitWorktreeFingerprint(currentRoot), sessionID };
					const isFresh = verifyResult !== undefined && verifyResult.passed && verifyResult.command === command && isEvidenceFresh(verificationEvidence(verifyResult, sessionID), currentSubject, mutationTimestamp);
					if (!isFresh) {
						if (context?.simulate) return block("verification", "verification_required", `Blocked: finalization requires fresh passing verification (${command}).`);
						const result = await runVerify(command, currentRoot);
						recordVerifyResult(command, result, sessionID, currentRoot);
						if (!result.passed) {
							const tail = snipVerifyOutput(result.output, result.passed).slice(-500);
							const reason = `Blocked todowrite: all tasks marked done but verification is failing (${command}). Fix the failure before finishing; output tail: ${tail}`;
							logPolicyBlock(`[workflow-guard] ${reason}`);
							return block("verification", "verification_failed", reason);
						}
					}
				}
			}
		}
		return allow();
	}

	if (EDIT_TOOL_NAMES.has(toolName)) {
		const allowLive = process.env.WORKFLOW_GUARD_ALLOW_LIVE === "1";
		const record = asRecord(input);
		const target = extractTargetPath(input) ?? "";
		if (target && isProtectedPath(target)) {
			logPolicyBlock(`[workflow-guard] blocked ${toolName}: protected path ${target}`);
			return block("tamper", "protected_path", PROTECTED_PATH_REASON);
		}
		if (target && isSecretPath(target)) {
			logPolicyBlock(`[workflow-guard] blocked ${toolName}: secret file path ${target}`);
			return block("secrets", "secret_write", `Blocked: modifying secret file '${target}' directly is not permitted. Store credentials in environment variables or safe secret stores instead.`);
		}
		if (toolName === "apply_patch") {
			const patchText = typeof record?.patchText === "string" ? record.patchText : "";
			for (const patchPath of extractPatchPaths(patchText)) {
				if (isProtectedPath(patchPath)) {
					logPolicyBlock(`[workflow-guard] blocked apply_patch: protected path ${patchPath}`);
					return block("tamper", "protected_path", PROTECTED_PATH_REASON);
				}
				if (isSecretPath(patchPath)) {
					logPolicyBlock(`[workflow-guard] blocked apply_patch: secret file path ${patchPath}`);
					return block("secrets", "secret_write", `Blocked: modifying secret file '${patchPath}' directly is not permitted.`);
				}
				if (isPathOutsideWorkspace(patchPath, currentRoot)) {
					logPolicyBlock(`[workflow-guard] blocked apply_patch: patch target escapes workspace: ${patchPath}`);
					return block("boundary", "workspace_escape", `Blocked: patch targets file '${patchPath}' outside workspace root (${currentRoot}).`);
				}
			}
		}
		if (target && isPathOutsideWorkspace(target, currentRoot)) {
			logPolicyBlock(`[workflow-guard] blocked ${toolName}: path escapes workspace: ${target}`);
			return block("boundary", "workspace_escape", `Blocked: file path '${target}' escapes workspace root (${currentRoot}). All changes must stay within the workspace.`);
		}
		for (const content of extractEditContent(input)) {
			const secret = secretIn(content);
			if (secret) {
				logPolicyBlock(`[workflow-guard] blocked ${toolName}: payload contains ${secret}`);
				return block("secrets", "secret_payload", `Blocked: payload appears to contain a ${secret}. Secrets must not be committed to the repository. Store them in a secret manager or environment file excluded from git, and reference them by name instead.`);
			}
		}
		if (!allowLive) {
			for (const content of extractEditContent(input)) {
				for (const line of content.split("\n")) {
					const trimmed = line.trim();
					if (trimmed.startsWith("#") || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) continue;
					const what = liveMutationIn(normalizeGitCommands(line));
					if (what) {
						logPolicyBlock(`[workflow-guard] blocked ${toolName}: payload contains ${what}`);
						return block("destructive", "live_mutation_payload", `Blocked: the file you are writing contains a ${what}. Script files are not a way to smuggle destructive commands past the shell guard. Only the user can allow live mutations (WORKFLOW_GUARD_ALLOW_LIVE=1).`);
					}
				}
			}
		}
		for (const content of extractEditContent(input)) if (isSettingsTamper(content)) return block("tamper", "settings_tamper", PROTECTED_PATH_REASON);
		if (onProtectedBranch(currentRoot)) {
			logPolicyBlock(`[workflow-guard] blocked ${toolName}: on protected branch ${currentGitBranch(currentRoot)}`);
			return block("git", "protected_branch", branchGuardReason());
		}
		const todos = await effectiveTodos(context?.sessionID);
		if (todos !== undefined && !hasActiveTodo(todos)) {
			logPolicyBlock(`[workflow-guard] blocked ${toolName}: no active todo item (session ${context?.sessionID ?? "?"})`);
			return block("todo", "no_active_todo", "Blocked: no active todo item. First break the request down with the todowrite tool (create items with status 'pending' or 'in_progress'), then work them through, marking each completed via todowrite as you finish it. When every item is completed, create a fresh todo list before starting new work.");
		}
		if (context?.sessionID) {
			const reason = await subagentMutationBudgetReason(context.sessionID, currentRoot);
			if (reason) {
				logPolicyBlock(`[workflow-guard] ${reason}`);
				return block("todo", "mutation_budget", reason);
			}
		}
		if (context?.sessionID) {
			if (toolName === "edit" || toolName === "write") {
				for (const path of editTargets(input, currentRoot)) {
					const staleReason = staleWriteReason(path, context.sessionID);
					if (staleReason) {
						logPolicyBlock(`[workflow-guard] ${staleReason}`);
						return block("stale-write", "stale_write", staleReason);
					}
				}
			}
			const targets = editTargets(input, currentRoot);
			const claimReason = context.simulate
				? fileClaimConflictReason(targets, context.sessionID)
				: context.callID ? claimFiles(targets, context.sessionID, context.callID) : undefined;
			if (claimReason) {
				logPolicyBlock(`[workflow-guard] ${claimReason}`);
				return block("file-claims", "file_claim_conflict", claimReason);
			}
		}
		if (!context?.simulate) recordMutation(await effectiveTodoOwnerSessionID(context?.sessionID), context?.sessionID);
		return allow();
	}

	const allowLive = process.env.WORKFLOW_GUARD_ALLOW_LIVE === "1";
	if (!allowLive) {
		const mcpWhat = mcpMutationTool(toolName);
		if (mcpWhat) {
			logPolicyBlock(`[workflow-guard] blocked MCP tool ${toolName} (${mcpWhat} mutation)`);
			return block("mcp", "live_mcp_mutation", `Blocked: ${toolName} mutates ${mcpWhat} - a live system. Changes must be made in code unless the user explicitly allows live changes. Only the user can override this, via the WORKFLOW_GUARD_ALLOW_LIVE=1 environment variable set before launching the agent.`);
		}
	}
	if (!SHELL_TOOL_NAMES.has(toolName)) return allow();
	const shellWorkdir = asRecord(input)?.workdir;
	const requestedShellRoot = typeof shellWorkdir === "string" ? resolve(currentRoot, shellWorkdir) : currentRoot;
	const shellRoot = !isPathOutsideWorkspace(requestedShellRoot, currentRoot) || getProjectMemoryIdentity(requestedShellRoot) === getProjectMemoryIdentity(currentRoot)
		? requestedShellRoot
		: currentRoot;

	for (const raw of extractCommands(input)) {
		const dynamicSyntax = dynamicShellSyntaxIn(raw);
		if (dynamicSyntax) return block("shell-safety", "dynamic_shell_syntax", `Blocked: command contains ${dynamicSyntax} that cannot be safely classified without executing shell expansion.`);
		const command = normalize(raw);
		const ttyCheck = checkInteractiveTtyCommand(command);
		if (ttyCheck.isInteractive) {
			logPolicyBlock(`[workflow-guard] blocked interactive TTY command: ${command.slice(0, 100)}`);
			return block("shell-safety", "interactive_tty", `Blocked: '${command.slice(0, 60)}' is an ${ttyCheck.name} and will hang non-interactive agent execution. ${ttyCheck.advice}`);
		}
		const packageCheck = checkPackageHygiene(command);
		if (packageCheck.isViolating && !allowLive) {
			logPolicyBlock(`[workflow-guard] blocked package supply-chain violation: ${command.slice(0, 100)}`);
			return block("shell-safety", "package_hygiene", `Blocked: '${command.slice(0, 60)}' is a ${packageCheck.name}. ${packageCheck.advice}`);
		}
		const normalizedCommand = normalizeGitCommands(command);
		if (hasUnsafeGitAlias(command)) return block("git", "unsafe_git_alias", "Blocked: per-invocation Git aliases cannot be used because they can hide guarded Git operations.");
		const gitInvocations = splitShellSegments(command).map((segment) => parseGitInvocation(segment.trim())).filter((invocation): invocation is NonNullable<ReturnType<typeof parseGitInvocation>> => invocation !== undefined);
		const effectiveRoot = gitInvocations[0]?.repoDir ?? currentRoot;
		for (const invocation of gitInvocations) {
			const normalizedInvocation = `git ${invocation.rest}`;
			if (isPathOutsideWorkspace(invocation.repoDir, currentRoot) && (GIT_WRITE_RE.test(normalizedInvocation) || /\bgit\s+push\b/.test(normalizedInvocation))) {
				logPolicyBlock(`[workflow-guard] blocked git mutation on repository outside workspace: ${invocation.repoDir}`);
				return block("boundary", "workspace_escape", `Blocked: git command targets repository '${invocation.repoDir}' outside workspace root (${currentRoot}). All changes must stay within the workspace.`);
			}
		}
		for (const invocation of gitInvocations) {
			if (GIT_WRITE_RE.test(`git ${invocation.rest}`) && onProtectedBranch(invocation.repoDir)) {
				logPolicyBlock(`[workflow-guard] blocked git write on protected branch: ${command.slice(0, 120)}`);
				return block("git", "protected_branch", branchGuardReason());
			}
		}
		if (GIT_BRANCH_CREATE_RE.test(normalizedCommand)) {
			const behindCheck = checkBranchBaseIsUpToDate(effectiveRoot);
			if (behindCheck.isBehind) {
				logPolicyBlock(`[workflow-guard] blocked branch creation: base is behind remote ${behindCheck.baseRef}`);
				return block("git", "branch_base_behind", `Blocked: ${behindCheck.reason}`);
			}
		}
		if (isSettingsTamper(command)) {
			logPolicyBlock(`[workflow-guard] blocked settings tamper: ${command.slice(0, 120)}`);
			return block("tamper", "settings_tamper", PROTECTED_PATH_REASON);
		}
		for (const segment of command.split(/[\n|;&]+/)) {
			const secretFile = secretFileReadIn(segment.trim());
			if (secretFile) {
				logPolicyBlock(`[workflow-guard] blocked shell read of secret file: ${secretFile}`);
				return block("secrets", "secret_read", `Blocked: reading sensitive credential/secret file '${secretFile}' via shell is not permitted. Reference environment variables by name or inspect safe templates (e.g. .env.example) instead.`);
			}
		}
		for (const payload of extractInterpreterPayload(raw)) {
			const outsidePath = outsideWritePathInPayload(payload, currentRoot);
			if (outsidePath) {
				logPolicyBlock(`[workflow-guard] blocked interpreter payload writing outside workspace: ${outsidePath}`);
				return block("boundary", "workspace_escape", `Blocked: inline interpreter script targets file '${outsidePath}' outside workspace root (${currentRoot}). All changes must stay within the workspace.`);
			}
			const writePaths = writePathsInPayload(payload);
			if (writePaths.length > 0) {
				if (context?.agent && isReadOnlyRole(context.agent)) return block("subagent-role", "read_only_role", `Blocked: subagent with read-only role '${context.agent}' cannot perform shell file mutations.`);
				for (const path of writePaths) if (isProtectedPath(path)) return block("tamper", "protected_path", PROTECTED_PATH_REASON);
				if (onProtectedBranch(currentRoot)) return block("git", "protected_branch", branchGuardReason());
				const todos = await effectiveTodos(context?.sessionID);
				if (todos !== undefined && !hasActiveTodo(todos)) return block("todo", "no_active_todo", "Blocked: inline interpreter file mutation with no active todo item.");
				if (!context?.simulate) recordMutation(await effectiveTodoOwnerSessionID(context?.sessionID), context?.sessionID);
			}
			if (!allowLive) {
				const liveCheck = liveMutationIn(normalizeGitCommands(normalize(payload)));
				if (liveCheck) {
					logPolicyBlock(`[workflow-guard] blocked interpreter payload containing ${liveCheck}`);
					return block("destructive", "live_mutation_payload", `Blocked: inline interpreter script contains a ${liveCheck}. Interpreter payloads cannot smuggle live destructive commands past the guard.`);
				}
			}
			if (isSettingsTamper(payload)) return block("tamper", "settings_tamper", PROTECTED_PATH_REASON);
			const secretPath = secretPathInPayload(payload);
			if (secretPath) return block("secrets", "secret_read", `Blocked: reading sensitive credential/secret file '${secretPath}' via inline interpreter script is not permitted.`);
		}
		const shellMutationReason = await guardShellMutation(command, context?.sessionID, !context?.simulate);
		if (shellMutationReason) {
			logPolicyBlock(`[workflow-guard] blocked shell mutation: ${command.slice(0, 120)}`);
			return block("boundary", "shell_mutation", shellMutationReason);
		}
		if (!allowLive) {
			const what = liveMutationIn(normalizedCommand) ?? liveMutationIn(command);
			if (what) {
				logPolicyBlock(`[workflow-guard] blocked ${what}: ${command.slice(0, 120)}`);
				return block("destructive", "live_mutation", `Blocked: ${what} targets a live system. Changes must be made in code (IaC, migrations, source) unless the user explicitly allows live changes. Only the user can override this, via the WORKFLOW_GUARD_ALLOW_LIVE=1 environment variable set before launching the agent.`);
			}
		}
		if (PUSH_TO_MAIN_RE.test(normalizedCommand)) {
			logPolicyBlock(`[workflow-guard] blocked push to main/master: ${command}`);
			return block("git", "protected_branch_push", "Blocked: direct pushes to main/master are not allowed. Create a feature branch and open a PR instead.");
		}
		for (const invocation of gitInvocations) {
			const pushText = `git ${invocation.rest}`;
			if (!/\bgit\s+push\b/.test(pushText)) continue;
			const pushedBranch = pushedProtectedBranchIn(pushText, invocation.repoDir);
			if (pushedBranch) {
				logPolicyBlock(`[workflow-guard] blocked push to protected branch '${pushedBranch}': ${command}`);
				return block("git", "protected_branch_push", `Blocked: direct pushes to protected branch '${pushedBranch}' are not allowed. Create a feature branch and open a PR instead.`);
			}
		}
		for (const invocation of gitInvocations) {
			if (!/\bgit\s+push\b/.test(`git ${invocation.rest}`)) continue;
			if (onProtectedBranch(invocation.repoDir)) {
				logPolicyBlock(`[workflow-guard] blocked push from protected branch: ${command}`);
				return block("git", "protected_branch", branchGuardReason());
			}
			const branch = currentGitBranch(invocation.repoDir);
			if (branch) {
				if (context?.simulate) remotePrStateUnchecked = true;
				const mergedStatus = isBranchAlreadyMergedOrClosed(invocation.repoDir, branch, !context?.simulate);
				if (mergedStatus.merged) {
					logPolicyBlock(`[workflow-guard] blocked push to merged/closed branch: ${branch}`);
					return block("git", "merged_branch", `Blocked: ${mergedStatus.reason}`);
				}
			}
		}
		if (hasPrCreateInvocation(raw)) {
			const prRoot = shellRoot;
			const isAz = /\baz\s+repos\s+pr\s+create\b/.test(normalizedCommand);
			const prTool = isAz ? "az repos pr create" : "gh pr create";
			const descFlag = isAz ? "--description" : "--body";
			const preflightFailures: string[] = [];
			if (prBodyHasLiteralLineBreakEscapes(raw)) preflightFailures.push(`PR description contains literal \\n/\\r escapes that will render as text; use real newlines, ANSI-C quoting ($'...\\n...'), or a body/description file instead.`);
			const conflictCheck = checkMergeConflicts(prRoot);
			if (conflictCheck.hasConflicts) preflightFailures.push(conflictCheck.reason ?? "Branch has merge conflicts with its base branch.");
			const branch = currentGitBranch(prRoot);
			if (branch) {
				if (context?.simulate) remotePrStateUnchecked = true;
				const mergedStatus = isBranchAlreadyMergedOrClosed(prRoot, branch, !context?.simulate);
				if (mergedStatus.merged) preflightFailures.push(mergedStatus.reason ?? "Branch is already merged or closed.");
			}
			if (isReviewRequired(prRoot)) {
				const review = context?.sessionID ? (sessionReviews.get(context.sessionID) ?? getLastReviewResult()) : getLastReviewResult();
				const reviewMatchesContext = review?.passed === true && isEvidenceFresh(reviewEvidence(review), { workspace: projectRootKey(prRoot), commitHash: getCurrentGitCommitHash(prRoot), worktreeFingerprint: getGitWorktreeFingerprint(prRoot), sessionID: review.targetSessionID }, 0) && (!review.targetSessionID || review.targetSessionID === context?.sessionID);
				if (!reviewMatchesContext) preflightFailures.push("Passing secondary review approval is required; invoke a secondary review subagent and record approval with record_review.");
			}
			if (isDocumentationRequired(prRoot) && !branchHasDocumentationChange(prRoot)) preflightFailures.push("Documentation update is required (Policy 21); update README.md or relevant documentation in docs/.");
			const branchChangelog = branchHasChangelogChange(prRoot);
			let shellCwdKnown = true;
			const prSegments: Array<{ segment: string; invocationRoot: string | null }> = [];
			for (const segment of splitShellSegments(raw)) {
				const unwrapped = unwrapShellCommand(segment);
				if (/(?:^|\s)(?:(?:builtin|command)\s+)?(?:cd|pushd|popd)(?:\s|$)/.test(unwrapped)) shellCwdKnown = false;
				if (hasPrCreateInvocation(segment)) {
					const wrapperChangesCwd = shellWrappersChangeCwd(segment);
					prSegments.push({ segment, invocationRoot: shellCwdKnown && !wrapperChangesCwd ? prRoot : null });
				}
			}
			const hasChangelog = branchChangelog || prSegments.every(({ segment, invocationRoot }) => prBodyIncludesChangelog(segment, invocationRoot));
			if (!hasChangelog) preflightFailures.push(`Release information is required; update a CHANGELOG/changeset file or include a Summary, Changes, Release notes, or Changelog section in the PR description (${descFlag}).`);
			const lockCheck = checkLockfileSync(prRoot);
			if (lockCheck.isOutOfSync) preflightFailures.push(lockCheck.reason ?? "Dependency lockfile is out of sync with its manifest.");
			if (preflightFailures.length > 0) {
				const reason = `Blocked: PR preflight failed:\n${preflightFailures.map((failure) => `- ${failure}`).join("\n")}`;
				logPolicyBlock(`[workflow-guard] blocked ${prTool}: ${preflightFailures.length} preflight requirement(s) failed`);
				return block("pr-preflight", "pr_preflight_failed", reason,);
			}
		}
		const hasGitMutation = gitInvocations.some((invocation) => {
			const normalizedInvocation = `git ${invocation.rest}`;
			return GIT_WRITE_RE.test(normalizedInvocation) || /\bgit\s+(?:switch|checkout)\b/.test(normalizedInvocation);
		});
		if (context?.agent && isReadOnlyRole(context.agent)) {
			const mutation = detectShellMutation(command);
			if (mutation) {
				logPolicyBlock(`[workflow-guard] blocked shell mutation for read-only role ${context.agent}: ${mutation.what}`);
				return block("subagent-role", "read_only_role", `Blocked: subagent with read-only role '${context.agent}' cannot perform shell file mutations (${mutation.what}).`);
			}
			if (hasGitMutation) {
				logPolicyBlock(`[workflow-guard] blocked git mutation for read-only role ${context.agent}`);
				return block("subagent-role", "read_only_role", `Blocked: subagent with read-only role '${context.agent}' cannot mutate git history or state.`);
			}
		}
		const shellMut = detectShellMutation(command);
		if (hasGitMutation || shellMut) {
			if (context?.sessionID) {
				const reason = await subagentMutationBudgetReason(context.sessionID, currentRoot);
				if (reason) {
					logPolicyBlock(`[workflow-guard] ${reason}`);
					return block("todo", "mutation_budget", reason);
				}
			}
		}
		if (hasGitMutation && !context?.simulate) recordMutation(await effectiveTodoOwnerSessionID(context?.sessionID), context?.sessionID);
	}
	if (remotePrStateUnchecked) return needsApproval("git", "remote_state_unchecked", "Remote GitHub/Azure PR state was not queried during simulation; no deterministic local guardrail blocked this call, but final allow/block status requires real enforcement.");
	return allow();
}
