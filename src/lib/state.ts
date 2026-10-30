import { existsSync, unlinkSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { audit, getDogfoodCacheFilePath, getReviewCacheFilePath, loadDogfoodCache, loadReviewCache, persistDogfoodCache, persistReviewCache, persistVerifyCache, persistVerifyHistory } from "./audit.ts";
import { findGitRoot, getCachedProjectConfig, isSameGitRepo, loadProjectConfig, projectRootKey } from "./project-config.ts";
import { snipVerifyOutput, getCurrentGitCommitHash, getGitStatusSummary, getGitWorktreeFingerprint, getTrackedWorktreeFingerprint } from "./verify.ts";
import { normalizeLiveControlPlaneRoots } from "./live-control-plane.ts";
import type {
	TodoSdkClient,
	ProjectConfig,
	VerifyResult,
	ReviewResult,
	DogfoodResult,
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
// Per-session, per-task mutation count recorded when an active task entered
// its current active window. Completion is judged per task: one mutation
// cannot vouch for several completions.
export const sessionTodoTaskStarts = new Map<string, Map<string, number>>();

export function todoTaskStarts(sessionID: string): Map<string, number> {
	let starts = sessionTodoTaskStarts.get(sessionID);
	if (!starts) {
		starts = new Map();
		sessionTodoTaskStarts.set(sessionID, starts);
	}
	return starts;
}

export function clearTodoSessionState(sessionID: string): void {
	sessionTodoTaskStarts.delete(sessionID);
}
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
 * The nearest bound workspace up the parent chain, for a session with no
 * direct binding of its own.
 *
 * A subagent's policy root already inherits its parent's workspace, so its
 * registration must use the same answer. Without this, a child of a bound
 * session looked unbound to the registration path and its first foreign read
 * rebound it into another repository: the parent stayed confined and the child
 * escaped.
 *
 * Walks at most `MAX_PARENT_DEPTH` links and stops on a cycle.
 *
 * Cost: one `session.get` per parent link, issued only when the session has no
 * direct binding. A directly bound session returns from the in-memory map with
 * no RPC, so the common case pays nothing. The walk is depth-capped and
 * cycle-checked, so a malformed parent graph cannot spin.
 */
const MAX_PARENT_DEPTH = 16;

/**
 * Walk up the parent chain from `sessionID` and return the nearest directly
 * bound ancestor's workspace.
 *
 * Shared by `resolveInheritedWorkspace` (full walk, used by workspace
 * registration so a subagent cannot rebind out of its parent's boundary) and
 * `resolveSessionBoundWorkspace` (one level, used by review-verdict binding).
 * The depth parameter is the only difference; keeping one implementation makes
 * the one-lookup-per-link cost visible in a single place.
 */
async function resolveAncestorBoundWorkspace(sessionID: string, maxDepth: number): Promise<string | undefined> {
	if (maxDepth <= 0) return undefined;
	const client = getSdkClient();
	const session = client?.session;
	const get = session?.get;
	if (typeof get !== "function") return undefined;
	const seen = new Set<string>([sessionID]);
	let current = sessionID;
	for (let depth = 0; depth < maxDepth; depth++) {
		let parentID: unknown;
		try {
			const result = await get.call(session, { path: { id: current } });
			parentID = (result as { data?: { parentID?: unknown } } | undefined)?.data?.parentID;
		} catch {
			return undefined;
		}
		if (typeof parentID !== "string" || !parentID || seen.has(parentID)) return undefined;
		const inherited = getSessionBoundWorkspace(parentID);
		if (inherited) return inherited;
		seen.add(parentID);
		current = parentID;
	}
	return undefined;
}

export async function resolveInheritedWorkspace(sessionID?: string): Promise<string | undefined> {
	if (!sessionID) return undefined;
	const direct = getSessionBoundWorkspace(sessionID);
	if (direct) return direct;
	return resolveAncestorBoundWorkspace(sessionID, MAX_PARENT_DEPTH);
}

/**
 * Register a session's workspace from a tool call's own context.
 *
 * Two distinct operations, deliberately split:
 *
 * - **First bind.** A session with no bound workspace adopts the git root of
 *   its own call arguments (`workdir`/`filePath`), else the host-provided
 *   per-call worktree, else a path-derived bootstrap from the plugin-instance
 *   fallback. A bootstrap from the fallback stays unbound: concurrent loops
 *   share this process, so a value derived from the last-active plugin
 *   instance must never bind review evidence.
 * - **Widen.** Once bound, only an explicit host-declared per-call worktree
 *   may move the boundary. Worktree isolation and relay flows set it, so it is
 *   a boundary statement from the host. A bare path candidate outside the
 *   boundary is a read or write against foreign state, which the boundary
 *   policy refuses; adopting it would let one allowed external read move the
 *   whole write boundary.
 *
 * "Bound" includes an inherited binding: a subagent with no direct binding of
 * its own already resolves to its nearest bound ancestor's workspace for
 * policy decisions, so a path-derived candidate must not bind it elsewhere.
 *
 * Every widen and every refused widen is journaled, because the boundary is
 * what unattended operation rests on.
 */
export async function registerSessionWorkspaceFromToolCall(
	sessionID: string | undefined,
	call: { workdir?: string; filePath?: string; hostWorktree?: string; toolWorktree: string; mutating?: boolean },
): Promise<void> {
	if (!sessionID) return;
	const bound = await resolveInheritedWorkspace(sessionID);

	// A host-declared per-call worktree is an explicit boundary statement.
	const hostRoot = call.hostWorktree ? findGitRoot(call.hostWorktree) : undefined;
	if (hostRoot && hostRoot !== bound) {
		setSessionWorkspace(sessionID, hostRoot);
		auditWorkspaceRebind(sessionID, bound, hostRoot, "host-worktree");
		return;
	}

	const rawCandidate = call.workdir ?? call.filePath;
	if (!rawCandidate) {
		if (sessionWorkspaces.has(sessionID)) return;
		const gitRoot = findGitRoot(call.toolWorktree);
		sessionWorkspaces.set(sessionID, gitRoot ?? projectRootKey(call.toolWorktree));
		return;
	}

	const candidatePath = isAbsolute(rawCandidate) ? rawCandidate : resolve(call.toolWorktree, rawCandidate);
	const gitRoot = findGitRoot(candidatePath);
	if (!gitRoot) return;
	if (gitRoot === bound) return;

	if (!bound) {
		sessionWorkspaces.set(sessionID, gitRoot);
		sessionWorkspaceBound.add(sessionID);
		return;
	}
	auditWorkspaceRebindRefused(sessionID, bound, gitRoot, call.mutating ? "mutation" : "read");
}

/** Durable record of a granted boundary widening. */
function auditWorkspaceRebind(sessionID: string, from: string | undefined, to: string, source: string): void {
	audit({
		ts: new Date().toISOString(),
		sessionID,
		tool: "workspace.binding",
		decision: "allow",
		phase: "event",
		reason: "workspace_rebind_host_worktree",
		input: { from, to, source },
	});
}

/**
 * Durable record of a refused widening. The refusal itself is the boundary
 * policy's decision; this entry exists so an operator can tell whether a
 * foreign path arrived through a read or a mutation.
 */
function auditWorkspaceRebindRefused(sessionID: string, from: string, to: string, source: "read" | "mutation"): void {
	audit({
		ts: new Date().toISOString(),
		sessionID,
		tool: "workspace.binding",
		decision: "block",
		phase: "event",
		reason: "workspace_rebind_refused",
		input: { from, to, source },
	});
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
	// One level only: review-verdict binding asks for the immediate parent, and
	// walking further would let a grandparent's workspace answer for a child
	// that was deliberately left unbound.
	return resolveAncestorBoundWorkspace(sessionID, 1);
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
	sessionTodoTaskStarts.clear();
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

let dogfoodRecords: DogfoodResult[] = [];
const MAX_DOGFOOD_RECORDS = 20;

/**
 * Records a dogfood run for a workspace.
 *
 * A HOLD is kept in memory so its taxonomy class stays diagnosable, but only
 * passing records are persisted: caching a failed run would let a later
 * preflight read it as evidence.
 *
 * Records accumulate rather than replacing each other, because a deploy matrix
 * needs one record per host. Keeping only the newest would make a multi-host
 * matrix impossible to satisfy.
 */
export function recordDogfoodResult(result: Omit<DogfoodResult, "workspace" | "commitHash" | "gitStatus" | "worktreeFingerprint" | "timestamp"> & { workspace?: string }, targetSessionID?: string): DogfoodResult {
	const root = projectRootKey(result.workspace ?? getWorkspaceRoot());
	const stored: DogfoodResult = {
		...result,
		timestamp: Date.now(),
		workspace: root,
		commitHash: getCurrentGitCommitHash(root),
		gitStatus: getGitStatusSummary(root),
		// Bind to tracked content only, matching review: the dogfood run
		// covered the change, and untracked scratch files are not part of it.
		worktreeFingerprint: getTrackedWorktreeFingerprint(root),
		sessionID: targetSessionID,
	};
	dogfoodRecords = [stored, ...dogfoodRecords].slice(0, MAX_DOGFOOD_RECORDS);
	if (stored.verdict === "pass") persistDogfoodCache(dogfoodRecords.filter((record) => record.verdict === "pass"));
	return stored;
}

/**
 * Candidate dogfood records for one worktree.
 *
 * Memory and disk are merged, so a pass recorded in a previous process is
 * still a candidate next to one recorded now. Duplicates are harmless because
 * the gate keeps only the newest record per host.
 *
 * Exact-worktree candidates win over same-repository ones, so a sibling
 * worktree's run cannot displace this worktree's evidence. Same-repository
 * candidates are returned when this worktree has none, which is what lets a
 * run in a linked worktree satisfy the parent when the tracked content matches.
 * Freshness is judged per record by the caller, never here.
 */
export function getDogfoodRecordsForWorkspace(root: string): DogfoodResult[] {
	const workspace = projectRootKey(root);
	const all = [...dogfoodRecords, ...loadDogfoodCache()].filter(
		(result): result is DogfoodResult & { workspace: string } => result?.workspace != null,
	);
	const exact = all.filter((result) => projectRootKey(result.workspace) === workspace);
	if (exact.length > 0) return exact;
	return all.filter((result) => isSameGitRepo(result.workspace, root));
}

export function getLastDogfoodResultForWorkspace(root: string): DogfoodResult | undefined {
	const records = getDogfoodRecordsForWorkspace(root);
	return records.reduce<DogfoodResult | undefined>((best, result) => !best || result.timestamp > best.timestamp ? result : best, undefined);
}

export function resetDogfoodState(): void {
	dogfoodRecords = [];
	try {
		const p = getDogfoodCacheFilePath();
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

/**
 * Dogfood gate (pre-deployment evidence). Off by default, per the rule that
 * every write path ships opt-in first: a repository opts in only once its
 * runner exists, and an unset flag keeps today's PR behavior.
 */
export function isDogfoodRequired(root: string): boolean {
	const env = process.env.WORKFLOW_GUARD_REQUIRE_DOGFOOD?.toLowerCase();
	if (env === "0" || env === "false" || env === "off") return false;
	if (env === "1" || env === "true" || env === "on") return true;
	return getProjectConfig(root).requireDogfood === true;
}

/**
 * Host labels that must each carry a passing dogfood record. Unset means the
 * recorded host alone satisfies the gate, so a single-machine setup needs no
 * matrix. Blank and duplicate labels are dropped; a non-array value is
 * ignored rather than throwing, matching the other config readers.
 */
export function getDogfoodDeployMatrix(root: string): string[] {
	const env = process.env.WORKFLOW_GUARD_DOGFOOD_DEPLOY_MATRIX;
	const raw = env !== undefined && env.trim() !== "" ? env.split(",") : getProjectConfig(root).dogfoodDeployMatrix;
	if (!Array.isArray(raw)) return [];
	return [...new Set(raw.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean))];
}

/**
 * Dogfood recursion depth for this process. The runner sets
 * `WORKFLOW_GUARD_DOGFOOD_DEPTH` on the actor it spawns, so the marker is
 * inherited rather than handshaken. Unparseable or negative values fail
 * closed to depth 1, because a corrupt marker must not read as a clean root.
 */
export function getDogfoodDepth(): number {
	const env = process.env.WORKFLOW_GUARD_DOGFOOD_DEPTH;
	if (env === undefined || env.trim() === "") return 0;
	const parsed = Number(env.trim());
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : 1;
}

/**
 * True when this process is a dogfood actor, that is, a session spawned by the
 * runner to be tested. Every policy still applies; the marker only refuses
 * self-certification and stops dogfood evidence from being persisted.
 */
export function isDogfoodActor(): boolean {
	if (process.env.WORKFLOW_GUARD_DOGFOOD_ACTOR === "1") return true;
	return getDogfoodDepth() > 0;
}

/**
 * Policy 25 (live-documentation research floor): enabled by default. The env
 * override mirrors `isReviewRequired`; project config can opt out. The floor
 * engages after `getLiveDocFailureThreshold` failed tool calls with no live
 * lookup since the last failure.
 */
export function isLiveDocsRequired(root: string): boolean {
	const env = process.env.WORKFLOW_GUARD_REQUIRE_LIVE_DOCS?.toLowerCase();
	if (env === "0" || env === "false" || env === "off") return false;
	if (env === "1" || env === "true" || env === "on") return true;
	const cfg = getProjectConfig(root);
	return cfg.requireLiveDocs !== false;
}

export function getLiveDocFailureThreshold(root: string): number {
	const env = process.env.WORKFLOW_GUARD_LIVE_DOC_THRESHOLD;
	if (env !== undefined && env.trim() !== "") {
		// Number() rejects trailing junk that parseInt would silently accept.
		const parsed = Number(env.trim());
		if (Number.isInteger(parsed) && parsed >= 1) return parsed;
	}
	const cfg = getProjectConfig(root);
	if (typeof cfg.liveDocFailureThreshold === "number" && Number.isInteger(cfg.liveDocFailureThreshold) && cfg.liveDocFailureThreshold >= 1) {
		return cfg.liveDocFailureThreshold;
	}
	return 3;
}

/**
 * Extra tool-name fragments that count as a live-documentation lookup, so an
 * operator whose docs server is not in the builtin token set can still satisfy
 * the floor: `researchTools` in project config or
 * `WORKFLOW_GUARD_RESEARCH_TOOLS` (comma-separated).
 */
export function getResearchToolPatterns(root: string = getWorkspaceRoot()): string[] {
	const env = process.env.WORKFLOW_GUARD_RESEARCH_TOOLS;
	if (env !== undefined && env.trim() !== "") {
		return env.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
	}
	const configured = getProjectConfig(root).researchTools;
	return Array.isArray(configured)
		? configured.filter((value): value is string => typeof value === "string").map((value) => value.trim().toLowerCase()).filter(Boolean)
		: [];
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
