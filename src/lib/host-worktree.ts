/**
 * Host worktree port for the V2 native worktree API.
 *
 * The guard hand-rolls `git worktree add` and keeps its own storage directory,
 * so worktrees it creates are invisible to the host's worktree inventory. The
 * V2 API exposes `ctx.worktree` with `create`, `list`, `remove`, and `refresh`.
 *
 * Adoption is deliberately asymmetric, because the two paths do not carry the
 * same guarantees:
 *
 * - **create** goes through the host first, so the worktree lands where the
 *   operator configured `worktree.directory` and appears in host inventory.
 *   The result is validated before it is accepted: the directory must exist,
 *   must be a worktree of THIS repository, and must not be the primary tree.
 *   Any failure falls back to the git implementation.
 * - **remove** stays with the guard. The host's `remove` takes a `force` flag
 *   and has no snapshot step, so it can destroy uncommitted work that the
 *   guard's snapshot-then-remove flow preserves. After the guard removes a
 *   worktree, the port calls `refresh` so host inventory does not keep a
 *   stale entry.
 * - **list** supplies the bounded, host-declared set of directories that
 *   cleanup may touch. This is the same widening authority Task 3 gave
 *   `hostWorktree`: the host says the directory is its worktree, and the
 *   guard still independently requires a git registration and a non-primary
 *   path.
 *
 * Unknown or unavailable host surfaces degrade to `undefined`, never to a
 * guess. The git path stays the only authority for correctness.
 */

/** Narrow, duck-typed view of `ctx.worktree` so this module stays testable. */
export interface HostWorktreeApi {
	create(input: { projectID: string; branch?: string; from?: string; name?: string; directory?: string }): Promise<{ directory?: string } | undefined>;
	list(input: { projectID: string }): Promise<ReadonlyArray<{ directory?: string }> | undefined>;
	refresh(input: { projectID: string }): Promise<unknown>;
}

export interface HostWorktreePort {
	/** True when the host exposes a usable project id and the create/list calls. */
	readonly available: boolean;
	/** Project id used for every call, or undefined when the host did not supply one. */
	readonly projectID: string | undefined;
	/**
	 * Create a worktree. `from` is an absolute DIRECTORY path, matching the host
	 * schema, not a git ref; callers that need a specific base ref use the git
	 * path instead of passing a ref here.
	 */
	create(input: { branch: string; from?: string }): Promise<{ directory?: string; error?: string }>;
	list(): Promise<readonly string[] | undefined>;
	refresh(): Promise<void>;
}

const unavailable: HostWorktreePort = {
	available: false,
	projectID: undefined,
	create: async () => ({ error: "host worktree API unavailable" }),
	list: async () => undefined,
	refresh: async () => {},
};

/**
 * Build the port from a V2 plugin context. A missing API, a missing project id,
 * or a throwing call all downgrade to the git path instead of failing the tool.
 */
export function createHostWorktreePort(ctx: unknown): HostWorktreePort {
	const context = ctx as {
		location?: { project?: { id?: unknown } };
		worktree?: Partial<HostWorktreeApi>;
	} | undefined;
	const api = context?.worktree;
	const rawProjectID = context?.location?.project?.id;
	const projectID = typeof rawProjectID === "string" && rawProjectID.length > 0 ? rawProjectID : undefined;
	if (!api || typeof api.create !== "function" || typeof api.list !== "function" || !projectID) {
		return unavailable;
	}
	const create = api.create.bind(api);
	const list = api.list.bind(api);
	const refresh = typeof api.refresh === "function" ? api.refresh.bind(api) : undefined;
	return {
		available: true,
		projectID,
		create: async ({ branch, from }) => {
			try {
				const result = await create({ projectID, branch, ...(from ? { from } : {}), name: branch.replace(/[/\\:]/g, "-") });
				const directory = typeof result?.directory === "string" && result.directory.length > 0 ? result.directory : undefined;
				return directory ? { directory } : { error: "host worktree create returned no directory" };
			} catch (error) {
				return { error: `host worktree create failed: ${(error as Error)?.message ?? String(error)}` };
			}
		},
		list: async () => {
			try {
				const result = await list({ projectID });
				if (!Array.isArray(result)) return undefined;
				return result
					.map((entry) => (typeof entry?.directory === "string" ? entry.directory : undefined))
					.filter((directory): directory is string => Boolean(directory));
			} catch {
				return undefined;
			}
		},
		refresh: async () => {
			if (!refresh) return;
			try {
				await refresh({ projectID });
			} catch {}
		},
	};
}
