/**
 * Host MCP server inventory for the guard's MCP policy.
 *
 * The MCP policy identifies a guarded live-system call by name tokens
 * (`github`, `azure`, `ado`, ...). That static list covers the common servers,
 * but it cannot learn a server the operator renamed, and it cannot tell when
 * the host's roster changed.
 *
 * `ctx.mcp.list()` reports the servers for this location, and the
 * `mcp.tools.changed` event says when that roster went stale. Together they
 * widen the guarded token set from host-declared names only.
 *
 * Two deliberate limits:
 *
 * - **Widen-only.** A server the operator removed must not silently unguard a
 *   tool that still names it. Removal therefore contributes nothing; the
 *   static defaults in `policies/mcp.ts` remain the floor.
 * - **Never a replacement for the policy.** A token learned here only reaches
 *   the same `mcpMutationTool` decision the static list already used. Nothing
 *   here can allow a call the policy would otherwise block.
 */

import { addGuardedMcpTokens, GUARDED_MCP_SERVERS } from "../policies/mcp.ts";

/** A server name counts as guarded when it names a known live-system product. */
const GUARDED_SERVER_TOKEN_RE =
	/(?:^|[^a-z0-9])(?:github|gh|azure|azmcp|ado|devops|azuredevops)(?:[^a-z0-9]|$)/;

/**
 * Turn a host server name into tokens for the policy's token scan.
 *
 * Host names are free-form (`github`, `github-enterprise`, `Azure DevOps`), so
 * a guarded server contributes its tokens rather than a single literal. A name
 * that does not look guarded contributes nothing.
 */
export function guardedTokensFromServerName(serverName: string): string[] {
	if (!serverName || !GUARDED_SERVER_TOKEN_RE.test(serverName.toLowerCase())) return [];
	return serverName
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.split(" ")
		.filter(Boolean);
}

/**
 * Read the MCP servers the host reports.
 *
 * `undefined` means "the host could not tell us", which is different from an
 * empty roster. Callers must not treat unknown as "nothing is guarded".
 *
 * The 2.0.10 MCP domain types `list` with a location filter and returns
 * `{ data: [...] }`; the duck-typed read tolerates a bare array too, because a
 * shape mismatch must degrade to unknown rather than throw.
 */
export async function listHostMcpServerNames(ctx: unknown): Promise<string[] | undefined> {
	const api = (ctx as { mcp?: { list?: (input?: unknown) => Promise<unknown> } } | undefined)?.mcp;
	if (!api || typeof api.list !== "function") return undefined;
	try {
		const result = await api.list.call(api, {});
		const data = (result as { data?: unknown } | undefined)?.data;
		const entries = Array.isArray(data) ? data : Array.isArray(result) ? result : undefined;
		if (!entries) return undefined;
		return entries
			.map((entry) => (typeof entry === "string" ? entry : (entry as { name?: unknown })?.name))
			.filter((name): name is string => typeof name === "string" && name.length > 0);
	} catch {
		return undefined;
	}
}

/**
 * Merge host-declared server names into the guarded token set.
 *
 * Returns the tokens this call added, so the caller can journal widening once
 * instead of logging the whole set on every event. `undefined` input (host
 * could not answer) adds nothing and is not an error.
 */
export function recordHostMcpServers(serverNames: readonly string[] | undefined): string[] {
	if (!serverNames) return [];
	const tokens = serverNames.flatMap((name) => guardedTokensFromServerName(name));
	return addGuardedMcpTokens(tokens);
}

/** Static defaults, for callers that only need to report the floor. */
export const STATIC_GUARDED_MCP_SERVERS = GUARDED_MCP_SERVERS;
