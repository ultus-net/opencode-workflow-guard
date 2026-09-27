import { existsSync, unlinkSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { getReviewCacheFilePath, loadReviewCache, persistReviewCache, persistVerifyCache, persistVerifyHistory } from "./audit.ts";
import { findGitRoot, getCachedProjectConfig, isSameGitRepo, loadProjectConfig, projectRootKey } from "./project-config.ts";
import { snipVerifyOutput, getCurrentGitCommitHash, getGitStatusSummary, getGitWorktreeFingerprint, getTrackedWorktreeFingerprint } from "./verify.ts";
import { normalizeLiveControlPlaneRoots } from "./live-control-plane.ts";
import type {
	TodoSdkClient,
	ProjectConfig,
	VerifyResult,
	ReviewResult,
} from "./types.ts";

export let workspaceRoot = process.cwd();
interface RuntimeState {
	workspaceRoot: string;
	sdkClient: TodoSdkClient | undefined;
	projectConfig: ProjectConfig;
}
const runtimeState = new AsyncLocalStorage<RuntimeState>();

export function setWorkspaceRoot(root: string): void {
	workspaceRoot = root;
}

export function getWorkspaceRoot(): string {
	return runtimeState.getStore()?.workspaceRoot ?? workspaceRoot;
}

export let sdkClient: TodoSdkClient | undefined;

export function setSdkClient(client: unknown): void {
	sdkClient = client as TodoSdkClient | undefined;
}

export function getSdkClient(): TodoSdkClient | undefined {
	return runtimeState.getStore()?.sdkClient ?? sdkClient;
}

export function runWithRuntimeState<T>(root: string, client: unknown, fn: () => T): T {
	return runtimeState.run(
		{
			workspaceRoot: root,
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
export const sessionWorkspaces = new Map<string, string>();
// Sessions whose workspace was registered from their OWN context (tool-call
// arguments or a host-provided per-call worktree). A session registered only
// from the plugin-instance default is deliberately left unmarked: concurrent
// loops share this process, and a value derived from the last-active plugin
// instance must never outrank the call's own context or the host fallback.
const sessionWorkspaceBound = new Set<string>();

export function setSessionWorkspace(sessionID: string, workspace: string): void {
	if (!sessionID || !workspace) return;
	const gitRoot = findGitRoot(workspace);
	sessionWorkspaces.set(sessionID, gitRoot ?? projectRootKey(workspace));
	sessionWorkspaceBound.add(sessionID);
}

export function getSessionWorkspace(sessionID?: string): string | undefined {
	if (!sessionID) return undefined;
	return sessionWorkspaces.get(sessionID);
}

/**
 * The session's workspace only when it was registered from the session's own
 * context (tool-call arguments or a host-provided per-call worktree), never a
 * plugin-instance-default bootstrap. Policy decisions that bind evidence or
 * confine boundaries must consult this variant: two concurrent loops share one
 * guard process, and an unbound bootstrap entry may have been derived from
 * another session's plugin instance.
 */
export function getSessionBoundWorkspace(sessionID?: string): string | undefined {
	if (!sessionID) return undefined;
	return sessionWorkspaceBound.has(sessionID) ? sessionWorkspaces.get(sessionID) : undefined;
}

/**
 * Register a session's workspace from a tool call's own context. Candidates in
 * priority order: tool-argument paths (workdir/filePath — the call's own
 * target), then a host-provided per-call worktree/directory. A session that is
 * already registered is never re-anchored from the plugin-instance fallback:
 * under concurrent loops that fallback can belong to a different session's
 * workspace, which is exactly how workspaces cross-contaminate. Only a
 * session with no registration at all is bootstrapped from the fallback, and
 * such a bootstrap stays unbound (never used to bind review evidence).
 */
export function registerSessionWorkspaceFromToolCall(
	sessionID: string | undefined,
	call: { workdir?: string; filePath?: string; hostWorktree?: string; toolWorktree: string },
): void {
	if (!sessionID) return;
	const rawCandidate = call.workdir ?? call.filePath ?? call.hostWorktree;
	if (rawCandidate) {
		const candidatePath = isAbsolute(rawCandidate) ? rawCandidate : resolve(call.toolWorktree, rawCandidate);
		const gitRoot = findGitRoot(candidatePath);
		if (gitRoot) {
			sessionWorkspaces.set(sessionID, gitRoot);
			sessionWorkspaceBound.add(sessionID);
		}
		return;
	}
	if (sessionWorkspaces.has(sessionID)) return;
	const gitRoot = findGitRoot(call.toolWorktree);
	sessionWorkspaces.set(sessionID, gitRoot ?? projectRootKey(call.toolWorktree));
}

/**
 * The session's workspace resolved from its own bindings only: a directly
 * registered bound workspace, else the nearest bound parent workspace
 * (subagent sessions inherit their parent's binding for relay flows). Returns
 * undefined when neither exists — callers that must not guess (review verdict
 * binding) treat that as "resolve nothing, ask for an explicit directory".
 */
export async function resolveSessionBoundWorkspace(sessionID?: string): Promise<string | undefined> {
	if (!sessionID) return undefined;
	const direct = getSessionBoundWorkspace(sessionID);
	if (direct) return direct;
	try {
		const client = getSdkClient();
		const session = client?.session;
		const get = session?.get;
		if (typeof get === "function") {
			const result = await get.call(session, { path: { id: sessionID } });
			const parent = (result as { data?: { parentID?: unknown } } | undefined)?.data?.parentID;
			if (typeof parent === "string" && parent && sessionWorkspaceBound.has(parent)) {
				return sessionWorkspaces.get(parent);
			}
		}
	} catch {}
	return undefined;
}

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
	}
	// Review evidence is intentionally NOT erased here. Recorded approvals bind
	// to the reviewed tracked content (commit hash + tracked worktree
	// fingerprint), so freshness is re-evaluated against content at
	// consumption time. Erasing on any mutation made an unrelated untracked
	// scratch-file deletion (or a mutation in a sibling worktree) invalidate a
	// valid approval and let a re-record silently fail to stick; any change to
	// the reviewed tracked content still makes the evidence stale.
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
): ReviewResult {
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
		// Bind to tracked repository content only: the review covered the
		// reviewed diff, and untracked scratch files are not part of it.
		worktreeFingerprint: getTrackedWorktreeFingerprint(root),
	};
	if (targetSessionID) sessionReviews.set(targetSessionID, lastReview);
	if (passed) {
		persistReviewCache(lastReview);
	}
	return lastReview;
}

export function getLastReviewResult(): typeof lastReview {
	if (lastReview) return lastReview;
	const diskCached = loadReviewCache();
	if (diskCached) {
		lastReview = diskCached;
		return lastReview;
	}
	return undefined;
}

export function getLastReviewResultForWorkspace(root: string): typeof lastReview {
	const workspace = projectRootKey(root);
	const all = [lastReview, ...sessionReviews.values()].filter(
		(result): result is ReviewResult & { workspace: string } => result?.workspace != null,
	);
	// Exact worktree binding wins: concurrent loops sharing one repository
	// (different worktrees) must consume their own approvals independently —
	// a newer sibling-worktree review must never displace this worktree's
	// between record_review and PR creation.
	const exact = all.filter((result) => projectRootKey(result.workspace) === workspace);
	let preferred = exact;
	if (preferred.length === 0) {
		const sameRepo = all.filter((result) => isSameGitRepo(result.workspace, root));
		if (sameRepo.length > 0) {
			// Among same-repo candidates, prefer the review whose tracked
			// content matches THIS worktree (the PR preflight consumes the
			// approval bound to the tree it would publish); recency only
			// breaks ties.
			const prFingerprint = getTrackedWorktreeFingerprint(root);
			const contentMatched = prFingerprint ? sameRepo.filter((result) => result.worktreeFingerprint === prFingerprint) : [];
			preferred = contentMatched.length > 0 ? contentMatched : sameRepo;
		}
	}
	const latest = preferred.reduce<ReviewResult | undefined>((best, result) => !best || result.timestamp > best.timestamp ? result : best, undefined);
	if (latest) return latest;
	const diskCached = loadReviewCache();
	if (diskCached?.workspace && (projectRootKey(diskCached.workspace) === workspace || isSameGitRepo(diskCached.workspace, root))) {
		return diskCached;
	}
	return undefined;
}

export function resetReviewState(): void {
	lastReview = undefined;
	sessionReviews.clear();
	try {
		const p = getReviewCacheFilePath();
		if (existsSync(p)) unlinkSync(p);
	} catch {}
}

export async function resolveEffectiveWorkspace(options: {
	sessionID?: string;
	directory?: string;
	fallback?: string;
}): Promise<string> {
	// Intended precedence. Custom tools (resolveCallWorkspace) consult the
	// explicit argument and the host per-call context BEFORE calling this, so
	// inside this function the remaining order is: bound session workspace >
	// host fallback > unbound bootstrap hint > global latch/cwd. A future
	// direct caller passing a per-call `fallback` should apply the same
	// host-context-first step that resolveCallWorkspace does.
	if (options.directory) {
		const gitRoot = findGitRoot(options.directory);
		return gitRoot ?? projectRootKey(options.directory);
	}
	// 1. The session's own binding (direct, or inherited from a bound parent
	// for relay flows) wins over every ambient fallback. Concurrent loops
	// share one guard process; a fallback derived from the last-active
	// plugin instance must never re-anchor another session's context.
	const bound = await resolveSessionBoundWorkspace(options.sessionID);
	if (bound) return bound;
	const fallbackRoot = options.fallback ? projectRootKey(options.fallback) : undefined;
	const isFallbackFsRoot = fallbackRoot ? resolve(fallbackRoot) === resolve(fallbackRoot, "..") : true;

	// 2. The call's own host-provided per-call worktree/directory.
	if (fallbackRoot && !isFallbackFsRoot) {
		return fallbackRoot;
	}

	// 3. Unbound bootstrap hint: the session was registered only from the
	// plugin-instance default, so it carries no per-session authority and
	// loses to any real fallback (step 2). It is still better than the raw
	// global latch when the fallback is absent or the filesystem root.
	const hintRoot = options.sessionID ? sessionWorkspaces.get(options.sessionID) : undefined;
	if (hintRoot) return hintRoot;
	const activeRoot = getWorkspaceRoot();
	if (activeRoot && resolve(activeRoot) !== resolve(activeRoot, "..")) {
		const gitRoot = findGitRoot(activeRoot);
		if (gitRoot) return gitRoot;
		return activeRoot;
	}
	try {
		const cwdGitRoot = findGitRoot(process.cwd());
		if (cwdGitRoot) return cwdGitRoot;
	} catch {}
	return fallbackRoot || activeRoot || getWorkspaceRoot();
}

export function getProjectConfig(root: string): ProjectConfig {
	const active = runtimeState.getStore();
	if (active && projectRootKey(active.workspaceRoot) === projectRootKey(root)) return active.projectConfig;
	return getCachedProjectConfig(root) ?? loadProjectConfig(root);
}

/**
 * The host-declared live control-plane roots: `WORKFLOW_GUARD_LIVE_CONTROL_PLANE_PATHS`
 * (comma-separated) overrides, else project config `liveControlPlanePaths`.
 * Returns undefined when unset or when any declared root is unusable, so
 * callers fall back to the legacy fail-closed segment matching.
 */
export function getLiveControlPlaneRoots(root: string = getWorkspaceRoot()): readonly string[] | undefined {
	const env = process.env.WORKFLOW_GUARD_LIVE_CONTROL_PLANE_PATHS;
	if (env && env.trim()) {
		return normalizeLiveControlPlaneRoots(env.split(",").map((value) => value.trim()).filter(Boolean));
	}
	return normalizeLiveControlPlaneRoots(getProjectConfig(root).liveControlPlanePaths);
}

export function isReviewRequired(root: string): boolean {
	const env = process.env.WORKFLOW_GUARD_REQUIRE_REVIEW?.toLowerCase();
	if (env === "0" || env === "false" || env === "off") return false;
	if (env === "1" || env === "true" || env === "on") return true;
	const cfg = getProjectConfig(root);
	return cfg.requireReview !== false;
}

export function isSubagentReviewRequired(root: string): boolean {
	const env = process.env.WORKFLOW_GUARD_REQUIRE_SUBAGENT_REVIEW?.toLowerCase();
	if (env === "0" || env === "false" || env === "off") return false;
	if (env === "1" || env === "true" || env === "on") return true;
	return getProjectConfig(root).requireSubagentReview === true;
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
