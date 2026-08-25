import { realpathSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { persistVerifyCache } from "./audit.ts";
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
export const sessionMutationTimestamps = new Map<string, number>();
export const sessionMutationCounts = new Map<string, number>();

export let lastVerify: VerifyResult | undefined;
export const sessionVerifyResults = new Map<string, NonNullable<VerifyResult>>();

export let lastReview: ReviewResult | undefined;
export const sessionReviews = new Map<string, ReviewResult>();

export function recordMutation(sessionID?: string): void {
	lastMutationTimestamp = Date.now();
	mutationCount++;
	if (sessionID) {
		sessionMutationTimestamps.set(sessionID, lastMutationTimestamp);
		sessionMutationCounts.set(sessionID, (sessionMutationCounts.get(sessionID) ?? 0) + 1);
		sessionVerifyResults.delete(sessionID);
	}
	if (sessionID) sessionReviews.delete(sessionID);
	if (!lastReview?.targetSessionID || lastReview.targetSessionID === sessionID) {
		lastReview = undefined;
	}
}

export function getMutationCount(sessionID?: string): number {
	if (sessionID && sessionMutationCounts.has(sessionID)) {
		return sessionMutationCounts.get(sessionID) ?? 0;
	}
	return mutationCount;
}

export function getLastMutationTimestamp(): number {
	return lastMutationTimestamp;
}

export function getLastVerifyResult(): typeof lastVerify {
	return lastVerify;
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
		workspaceRoot: resolve(root),
	};
	if (sessionID && lastVerify) sessionVerifyResults.set(sessionID, lastVerify);
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
	sessionVerifyResults.clear();
}

export function recordReviewResult(
	reviewer: string,
	summary: string,
	passed: boolean,
	targetSessionID?: string,
	workspace?: string,
): void {
	const root = resolve(workspace ?? getWorkspaceRoot());
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

export function resetReviewState(): void {
	lastReview = undefined;
	sessionReviews.clear();
}

export let cachedProjectConfig: ProjectConfig | undefined;

/**
 * Strips single-line comments, block comments, and trailing commas from JSONC
 * text without corrupting comment markers inside string literals or URLs.
 */
export function stripJsonComments(jsonc: string): string {
	let insideString = false;
	let stringQuote = "";
	let escaped = false;
	let output = "";
	let i = 0;

	while (i < jsonc.length) {
		const char = jsonc[i]!;
		const next = jsonc[i + 1];

		if (escaped) {
			output += char;
			escaped = false;
			i++;
			continue;
		}

		if (char === "\\") {
			output += char;
			escaped = true;
			i++;
			continue;
		}

		if (char === '"' || char === "'") {
			if (!insideString) {
				insideString = true;
				stringQuote = char;
			} else if (stringQuote === char) {
				insideString = false;
			}
			output += char;
			i++;
			continue;
		}

		if (!insideString) {
			if (char === "/" && next === "/") {
				i += 2;
				while (i < jsonc.length && jsonc[i] !== "\n" && jsonc[i] !== "\r") {
					i++;
				}
				continue;
			}
			if (char === "/" && next === "*") {
				i += 2;
				while (i < jsonc.length && !(jsonc[i] === "*" && jsonc[i + 1] === "/")) {
					i++;
				}
				i += 2;
				continue;
			}
		}

		output += char;
		i++;
	}

	return output.replace(/,(\s*[}\]])/g, "$1");
}

export function loadProjectConfig(root: string): ProjectConfig {
	const candidates = [
		join(root, ".opencode", "workflow-guard.json"),
		join(root, ".opencode", "workflow-guard.jsonc"),
		join(root, "workflow-guard.json"),
		join(root, "workflow-guard.jsonc"),
	];
	for (const candidate of candidates) {
		try {
			const raw = readFileSync(candidate, "utf8");
			const sanitized = stripJsonComments(raw);
			return JSON.parse(sanitized);
		} catch {}
	}
	return {};
}

export function reloadProjectConfig(root: string): void {
	cachedProjectConfig = loadProjectConfig(root);
}

export function getProjectConfig(root: string): ProjectConfig {
	const active = runtimeState.getStore();
	if (active?.workspaceRoot === root) return active.projectConfig;
	return cachedProjectConfig ?? loadProjectConfig(root);
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

export function getSubagentMutationBudget(root: string): number {
	if (process.env.WORKFLOW_GUARD_MAX_SUBAGENT_MUTATIONS) {
		const parsed = parseInt(process.env.WORKFLOW_GUARD_MAX_SUBAGENT_MUTATIONS, 10);
		if (!Number.isNaN(parsed) && parsed > 0) return parsed;
	}
	const cfg = getProjectConfig(root);
	if (typeof cfg.maxSubagentMutations === "number" && cfg.maxSubagentMutations > 0) {
		return cfg.maxSubagentMutations;
	}
	return 50;
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
