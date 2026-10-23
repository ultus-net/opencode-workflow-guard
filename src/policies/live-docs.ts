/**
 * Policy 25: Live-Documentation Research Floor.
 *
 * Failure mode this closes: after a handful of failed attempts, an agent keeps
 * guessing from its training data instead of consulting current documentation,
 * a live API reference, or a web source. Prior art calls the remedy "iterative
 * grounding" (De-Hallucinator, arXiv 2401.01701) or a knowledge-lookup gate
 * ("writes are refused unless a knowledge lookup has run in that turn").
 *
 * Scope: the floor blocks only mutation and shell tools - the surfaces where a
 * guessed API, flag, or documented behavior actually gets written down. It
 * never blocks a research tool, so the escape hatch is always the thing the
 * agent should have reached for first.
 *
 * Semantics: the floor counts tool failures that occur *since the session last
 * grounded itself in a live source*. A successful research call clears the
 * debt; an unrelated successful tool does NOT, because "the guess happened to
 * work once" is not the same as having consulted the documentation. This is
 * deliberately stronger than the existing circuit breaker, whose counter resets
 * on any success and so would be bypassed by a benign command.
 *
 * State is module-level, like `file-claims.ts`: verification/review evidence
 * maps in `state.ts` are process-global by design so parent and subagent
 * sessions share freshness, and the research floor follows that convention.
 */

/** Tool names that consult live/external sources (builtin + common aliases). */
export const RESEARCH_TOOL_NAMES = new Set([
	"websearch",
	"webfetch",
	"web_search",
	"web_fetch",
	"search_web",
	"fetch_page",
	"fetch_url",
]);

/**
 * Documentation sources expose lookup under their own tool names, and MCP tool
 * names arrive namespaced (`mcp__<server>__<tool>`, `<server>_<tool>`). Matching
 * whole tokens rather than substrings keeps `git_ref_*` or `read_wiki_index`
 * from being read as a docs source by accident.
 */
const RESEARCH_TOOL_TOKENS = new Set([
	"context7",
	"deepwiki",
	"tavily",
	"brave",
	"exa",
	"kagi",
	"perplexity",
	"docs",
	"doc",
	"docs_search",
	"documentation",
	"wiki",
	"resolve",
]);

/**
 * A research tool is a recognised builtin/alias name, a documented MCP source
 * (matched by token), or an operator-declared name from `researchTools`.
 */
export function isResearchTool(toolName: string, extraPatterns: readonly string[] = []): boolean {
	if (typeof toolName !== "string") return false;
	const lower = toolName.toLowerCase();
	if (RESEARCH_TOOL_NAMES.has(lower)) return true;
	if (lower.includes("resolve-library")) return true;
	const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean);
	if (tokens.some((token) => RESEARCH_TOOL_TOKENS.has(token))) return true;
	return extraPatterns.some((pattern) => pattern.length > 0 && lower.includes(pattern));
}

const MAX_TRACKED_SESSIONS = 4096;

/** Per-session failures accrued since the session last consulted a live source. */
export class LiveDocsResearchFloor {
	private readonly failuresSinceResearch = new Map<string, number>();

	private bucket(sessionID: string): number {
		return this.failuresSinceResearch.get(sessionID) ?? 0;
	}

	recordFailure(sessionID: string): void {
		if (!sessionID) return;
		this.failuresSinceResearch.set(sessionID, this.bucket(sessionID) + 1);
		if (this.failuresSinceResearch.size > MAX_TRACKED_SESSIONS) {
			this.failuresSinceResearch.delete(this.failuresSinceResearch.keys().next().value!);
		}
	}

	/** A successful live-source lookup clears the session's research debt. */
	recordResearch(sessionID: string): void {
		if (!sessionID) return;
		this.failuresSinceResearch.delete(sessionID);
	}

	failureCount(sessionID: string): number {
		return this.bucket(sessionID);
	}

	/**
	 * Returns a block reason when a non-research tool call must first consult a
	 * live source, or `undefined` when the call may proceed. Research tools are
	 * never gated, and calls below the failure threshold proceed.
	 */
	gatingReason(sessionID: string, toolName: string, threshold: number, extraPatterns: readonly string[] = []): string | undefined {
		if (!sessionID) return undefined;
		if (!Number.isInteger(threshold) || threshold < 1) return undefined;
		if (isResearchTool(toolName, extraPatterns)) return undefined;
		const count = this.bucket(sessionID);
		if (count < threshold) return undefined;
		return (
			`Blocked: ${count} tool failure(s) in this session and no live documentation lookup since. ` +
			`Stop guessing from training data and consult current sources first with 'websearch' or 'webfetch' ` +
			`(or an MCP documentation tool), then retry. If the failure is environmental rather than a knowledge gap, ` +
			`inspect the underlying error before retrying instead.`
		);
	}

	clearSession(sessionID: string): void {
		this.failuresSinceResearch.delete(sessionID);
	}
}

const floor = new LiveDocsResearchFloor();

/** Record a tool failure for the session's research debt. */
export function recordLiveDocsFailure(sessionID: string): void {
	floor.recordFailure(sessionID);
}

/** Record that the session successfully consulted a live source. */
export function recordResearchLookup(sessionID: string): void {
	floor.recordResearch(sessionID);
}

/** Return the session's failures-since-research count (for tests/inspection). */
export function liveDocsFailureCount(sessionID: string): number {
	return floor.failureCount(sessionID);
}

/**
 * Policy decision helper for the enforcement hooks: a block reason when a
 * mutation/shell call must first research, otherwise `undefined`.
 */
export function liveDocsGatingReason(sessionID: string, toolName: string, threshold: number, extraPatterns: readonly string[] = []): string | undefined {
	return floor.gatingReason(sessionID, toolName, threshold, extraPatterns);
}

/** Drop a session's floor state (session deletion). */
export function clearLiveDocsFloor(sessionID: string): void {
	floor.clearSession(sessionID);
}
