import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { persistVerifyCache, persistVerifyHistory } from "./audit.ts";
import { getCachedProjectConfig, loadProjectConfig, projectRootKey } from "./project-config.ts";
import { snipVerifyOutput, getCurrentGitCommitHash, getGitStatusSummary, getGitWorktreeFingerprint } from "./verify.ts";
import type {
	TodoSdkClient,
	ProjectConfig,
	VerifyResult,
	ReviewResult,
} from "./types.ts";

export let workspaceRoot = process.cwd();
export let workspaceRootReal = workspaceRoot;
interface RuntimeState {
	workspaceRoot: string;
	workspaceRootReal: string;
	sdkClient: TodoSdkClient | undefined;
	projectConfig: ProjectConfig;
}
const runtimeState = new AsyncLocalStorage<RuntimeState>();

try {
	workspaceRootReal = realpathSync(workspaceRoot);
} catch {}

export function setWorkspaceRoot(root: string): void {
	workspaceRoot = root;
	try {
		workspaceRootReal = realpathSync(root);
	} catch {
		workspaceRootReal = root;
	}
}

export function getWorkspaceRoot(): string {
	return runtimeState.getStore()?.workspaceRoot ?? workspaceRoot;
}

export function getWorkspaceRootReal(): string {
	return runtimeState.getStore()?.workspaceRootReal ?? workspaceRootReal;
}

export let sdkClient: TodoSdkClient | undefined;

export function setSdkClient(client: unknown): void {
	sdkClient = client as TodoSdkClient | undefined;
}

export function getSdkClient(): TodoSdkClient | undefined {
	return runtimeState.getStore()?.sdkClient ?? sdkClient;
}

export function runWithRuntimeState<T>(root: string, client: unknown, fn: () => T): T {
	let realRoot = root;
	try {
		realRoot = realpathSync(root);
	} catch {}
	return runtimeState.run(
		{
			workspaceRoot: root,
			workspaceRootReal: realRoot,
			sdkClient: client as TodoSdkClient | undefined,
			projectConfig: loadProjectConfig(root),
		},
		fn,
	);
}

export let lastMutationTimestamp = 0;
export let mutationCount = 0;
const workspaceMutationTimestamps = new Map<string, number>();
const workspaceMutationCounts = new Map<string, number>();
export const sessionMutationTimestamps = new Map<string, number>();
export const sessionMutationCounts = new Map<string, number>();

export let lastVerify: VerifyResult | undefined;
export const sessionVerifyResults = new Map<string, NonNullable<VerifyResult>>();

export let lastReview: ReviewResult | undefined;
export const sessionReviews = new Map<string, ReviewResult>();

export function recordMutation(sessionID?: string, actorSessionID?: string): void {
	lastMutationTimestamp = Date.now();
	mutationCount++;
	const workspace = projectRootKey(runtimeState.getStore()?.workspaceRoot ?? getWorkspaceRoot());
	workspaceMutationTimestamps.set(workspace, lastMutationTimestamp);
	workspaceMutationCounts.set(workspace, (workspaceMutationCounts.get(workspace) ?? 0) + 1);
	for (const id of new Set([sessionID, actorSessionID].filter((value): value is string => Boolean(value)))) {
		sessionMutationTimestamps.set(id, lastMutationTimestamp);
		sessionMutationCounts.set(id, (sessionMutationCounts.get(id) ?? 0) + 1);
		sessionVerifyResults.delete(id);
		sessionReviews.delete(id);
	}
	if (!lastReview?.targetSessionID || lastReview.targetSessionID === sessionID || lastReview.targetSessionID === actorSessionID) {
		lastReview = undefined;
	}
}

export function getMutationCount(sessionID?: string): number {
	if (sessionID && sessionMutationCounts.has(sessionID)) {
		return sessionMutationCounts.get(sessionID) ?? 0;
	}
	return mutationCount;
}

export function getSessionMutationCount(sessionID: string): number {
	return sessionMutationCounts.get(sessionID) ?? 0;
}

export function getLastMutationTimestamp(): number {
	return lastMutationTimestamp;
}

export function getWorkspaceMutationTimestamp(root: string): number {
	return workspaceMutationTimestamps.get(projectRootKey(root)) ?? 0;
}

export function getWorkspaceMutationCount(root: string): number {
	return workspaceMutationCounts.get(projectRootKey(root)) ?? 0;
}

export function getLastVerifyResult(): typeof lastVerify {
	return lastVerify;
}

export function getLastVerifyResultForWorkspace(root: string): typeof lastVerify {
	const workspace = projectRootKey(root);
	const candidates = [lastVerify, ...sessionVerifyResults.values()].filter(
		(result): result is NonNullable<VerifyResult> => result?.workspaceRoot != null && projectRootKey(result.workspaceRoot) === workspace,
	);
	return candidates.reduce<NonNullable<VerifyResult> | undefined>((latest, result) => !latest || result.timestamp > latest.timestamp ? result : latest, undefined);
}

export function recordVerifyResult(
	command: string,
	result: { passed: boolean; output: string; durationMs?: number },
	sessionID?: string,
	root = getWorkspaceRoot(),
): void {
	lastVerify = {
		command,
		passed: result.passed,
		output: snipVerifyOutput(result.output, result.passed),
		timestamp: Date.now(),
		durationMs: result.durationMs,
		commitHash: getCurrentGitCommitHash(root),
		gitStatus: getGitStatusSummary(root),
		workspaceRoot: projectRootKey(root),
		worktreeFingerprint: getGitWorktreeFingerprint(root),
	};
	if (sessionID && lastVerify) sessionVerifyResults.set(sessionID, lastVerify);
	persistVerifyHistory(lastVerify);
	if (lastVerify.passed) {
		persistVerifyCache(lastVerify);
	}
}

export function setLastVerifyResult(result: NonNullable<VerifyResult>): void {
	lastVerify = result;
}

export function resetVerifyState(): void {
	lastMutationTimestamp = 0;
	mutationCount = 0;
	lastVerify = undefined;
	sessionMutationTimestamps.clear();
	sessionMutationCounts.clear();
	workspaceMutationTimestamps.clear();
	workspaceMutationCounts.clear();
	sessionVerifyResults.clear();
}

export function recordReviewResult(
	reviewer: string,
	summary: string,
	passed: boolean,
	targetSessionID?: string,
	workspace?: string,
): void {
	const root = projectRootKey(workspace ?? getWorkspaceRoot());
	lastReview = {
		reviewer,
		summary: summary.slice(-4000),
		passed,
		timestamp: Date.now(),
		targetSessionID,
		workspace: root,
		commitHash: getCurrentGitCommitHash(root),
		gitStatus: getGitStatusSummary(root),
		worktreeFingerprint: getGitWorktreeFingerprint(root),
	};
	if (targetSessionID) sessionReviews.set(targetSessionID, lastReview);
}

export function getLastReviewResult(): typeof lastReview {
	return lastReview;
}

export function getLastReviewResultForWorkspace(root: string): typeof lastReview {
	const workspace = projectRootKey(root);
	const candidates = [lastReview, ...sessionReviews.values()].filter(
		(result): result is ReviewResult => result?.workspace != null && projectRootKey(result.workspace) === workspace,
	);
	return candidates.reduce<ReviewResult | undefined>((latest, result) => !latest || result.timestamp > latest.timestamp ? result : latest, undefined);
}

export function resetReviewState(): void {
	lastReview = undefined;
	sessionReviews.clear();
}

export function getProjectConfig(root: string): ProjectConfig {
	const active = runtimeState.getStore();
	if (active && projectRootKey(active.workspaceRoot) === projectRootKey(root)) return active.projectConfig;
	return getCachedProjectConfig(root) ?? loadProjectConfig(root);
}

export function isReviewRequired(root: string): boolean {
	if (process.env.WORKFLOW_GUARD_REQUIRE_REVIEW === "1") return true;
	const cfg = getProjectConfig(root);
	return cfg.requireReview === true;
}

export function isDocumentationRequired(root: string): boolean {
	if (process.env.WORKFLOW_GUARD_REQUIRE_DOCS === "1") return true;
	const cfg = getProjectConfig(root);
	return cfg.requireDocumentation === true;
}

export function getOperationProfile(root: string): "interactive" | "autonomous" {
	return getProjectConfig(root).profile === "autonomous" ? "autonomous" : "interactive";
}

export function isRecoveryCheckpointsEnabled(root: string): boolean {
	const cfg = getProjectConfig(root);
	return cfg.recoveryCheckpoints ?? getOperationProfile(root) === "autonomous";
}

export function isRalphModeEnabled(root: string): boolean {
	return getProjectConfig(root).ralphMode === true;
}

export function getRalphMaxIterations(root: string): number {
	const configured = getProjectConfig(root).ralphMaxIterations;
	if (typeof configured === "number" && Number.isInteger(configured) && configured > 0 && configured <= 100) return configured;
	return 10;
}

export function getSubagentMutationBudget(root: string): number {
	if (process.env.WORKFLOW_GUARD_MAX_SUBAGENT_MUTATIONS) {
		const parsed = parseInt(process.env.WORKFLOW_GUARD_MAX_SUBAGENT_MUTATIONS, 10);
		if (!Number.isNaN(parsed) && parsed > 0) return parsed;
	}
	const cfg = getProjectConfig(root);
	if (typeof cfg.maxSubagentMutations === "number" && cfg.maxSubagentMutations > 0) {
		return cfg.maxSubagentMutations;
	}
	return 100;
}

export function isLearningEnabled(root: string): boolean {
	return process.env.WORKFLOW_GUARD_LEARNING === "1" || getProjectConfig(root).learning === true;
}

export function isProjectMemoryEnabled(root: string): boolean {
	return getProjectConfig(root).projectMemory !== false;
}

export function getLearningInterventionBudget(root: string): number {
	const configured = getProjectConfig(root).maxLearningInterventions;
	if (typeof configured === "number" && configured >= 0) return Math.floor(configured);
	return 3;
}
