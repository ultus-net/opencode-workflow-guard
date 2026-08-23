import { realpathSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
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
export const sessionMutationTimestamps = new Map<string, number>();

export let lastVerify: VerifyResult | undefined;
export const sessionVerifyResults = new Map<string, VerifyResult>();

export let lastReview: ReviewResult | undefined;
export const sessionReviews = new Map<string, ReviewResult>();

export function recordMutation(sessionID?: string): void {
	lastMutationTimestamp = Date.now();
	if (sessionID) {
		sessionMutationTimestamps.set(sessionID, lastMutationTimestamp);
		sessionVerifyResults.delete(sessionID);
	}
	if (sessionID) sessionReviews.delete(sessionID);
	if (!lastReview?.targetSessionID || lastReview.targetSessionID === sessionID) {
		lastReview = undefined;
	}
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
): void {
	lastVerify = {
		command,
		passed: result.passed,
		output: result.output.slice(-4000),
		timestamp: Date.now(),
		durationMs: result.durationMs,
	};
	if (sessionID && lastVerify) sessionVerifyResults.set(sessionID, lastVerify);
}

export function resetVerifyState(): void {
	lastMutationTimestamp = 0;
	lastVerify = undefined;
	sessionMutationTimestamps.clear();
	sessionVerifyResults.clear();
}

export function recordReviewResult(
	reviewer: string,
	summary: string,
	passed: boolean,
	targetSessionID?: string,
	workspace?: string,
): void {
	lastReview = {
		reviewer,
		summary: summary.slice(-4000),
		passed,
		timestamp: Date.now(),
		targetSessionID,
		workspace,
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
			return JSON.parse(raw);
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
