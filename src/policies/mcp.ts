export const MCP_MUTATION_VERB_RE =
	/(?:^|_)(?:create|update|delete|remove|merge|push|close|edit|set|fork|trigger|cancel|rerun|add|assign|approve|complete|abandon)(?:_|$)/;
export const MCP_READ_ONLY_RE =
	/(?:^|_)(?:get|list|search|show|query|describe|find|read|status|diff|log)(?:_|$)/;

/**
 * Static guarded live-system server tokens.
 *
 * These stay in force regardless of host inventory, because tool names are
 * model-supplied text and the MCP policy is a live-system rail.
 */
export const GUARDED_MCP_SERVERS: ReadonlySet<string> = new Set([
	"github",
	"gh",
	"azure",
	"azmcp",
	"ado",
	"devops",
	"azuredevops",
]);

/**
 * Tokens learned from the HOST's MCP inventory (`ctx.mcp.list()`), offered by
 * `lib/mcp-inventory.ts` when a server connects or its tools change.
 *
 * Widen-only. A server the operator removed contributes nothing new, but the
 * static defaults above are never narrowed, so removing a server cannot
 * unguard a tool that still names it. Empty on hosts without the API, which
 * leaves behaviour identical to the static list.
 *
 * Held on `globalThis` via `Symbol.for` because OpenCode can load the same
 * package from two distinct module paths (a cache copy plus a source
 * checkout), and each copy would otherwise get its own set.
 */
const HOST_GUARDED_MCP_TOKENS = Symbol.for("opencode-workflow-guard.mcp-tokens.v1");
const tokenRegistry = globalThis as unknown as Record<symbol, Set<string> | undefined>;
const hostGuardedMcpTokens: Set<string> =
	tokenRegistry[HOST_GUARDED_MCP_TOKENS] ?? (tokenRegistry[HOST_GUARDED_MCP_TOKENS] = new Set());

/** Register host-declared server tokens. Returns the tokens that were new. */
export function addGuardedMcpTokens(tokens: Iterable<string>): string[] {
	const added: string[] = [];
	for (const token of tokens) {
		const normalized = String(token).toLowerCase().trim();
		if (!normalized || GUARDED_MCP_SERVERS.has(normalized) || hostGuardedMcpTokens.has(normalized)) continue;
		hostGuardedMcpTokens.add(normalized);
		added.push(normalized);
	}
	return added;
}

export function resetGuardedMcpTokensForTesting(): void {
	hostGuardedMcpTokens.clear();
}

/** Effective guarded token set: static defaults plus host-declared widening. */
export function guardedMcpServers(): ReadonlySet<string> {
	return new Set([...GUARDED_MCP_SERVERS, ...hostGuardedMcpTokens]);
}

export function mcpMutationTool(toolName: string): string | undefined {
	if (!MCP_MUTATION_VERB_RE.test(toolName) || MCP_READ_ONLY_RE.test(toolName)) {
		return undefined;
	}
	const tokens = toolName.toLowerCase().split(/[^a-z0-9]+/);
	if (tokens.some((t) => GUARDED_MCP_SERVERS.has(t) || hostGuardedMcpTokens.has(t))) {
		return "GitHub/Azure DevOps";
	}
	return undefined;
}
