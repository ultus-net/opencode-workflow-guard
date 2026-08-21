/**
 * Workflow Guard Plugin for OpenCode (hooks-only — no prompt rules)
 *
 * Deterministic enforcement via the `tool.execute.before` plugin hook
 * (https://opencode.ai/docs/plugins/). Throwing from the hook blocks the
 * tool call outright.
 *
 *  1. Task gate: file-editing tools (edit/write/apply_patch) are blocked
 *     until the session's NATIVE todo list (the built-in `todowrite` tool,
 *     https://opencode.ai/docs/tools/#todowrite) has at least one active
 *     item (pending/in_progress). Once every item is completed/cancelled,
 *     edits block again — forcing a fresh breakdown per request. Subagent
 *     sessions (todowrite is denied for them by default) inherit the todo
 *     list of their parent session.
 *  2. Git pushes to main/master are hard-blocked.
 *  3. PR creation (gh) requires a changelog — either a CHANGELOG update in
 *     the branch's diff or a "Changelog:" section in the PR body.
 *  4. Live-system guard: destructive commands targeting infrastructure,
 *     databases, or remote APIs are blocked unless overridden with an
 *     `# allow-live` comment or WORKFLOW_GUARD_ALLOW_LIVE=1.
 *  5. MCP mutation guard: GitHub / Azure DevOps MCP tools with mutation
 *     verbs in their names are blocked (read-only verbs pass).
 *  6. Settings tamper guard: the agent cannot edit opencode.json /
 *     permission config or run `opencode auth` to weaken its own gates.
 *  7. Branch guard: on main/master, edit tools and history-changing git
 *     commands are blocked until a feature branch is created.
 *  8. Workspace boundary guard: file edits and patches cannot escape the
 *     workspace root.
 *
 * Install: copy this file into <project>/.opencode/plugins/ or
 * ~/.config/opencode/plugins/ — files there are auto-loaded at startup.
 * Requires opencode >= 1.18 (todo endpoint GET /session/:id/todo).
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin, PluginModule } from "@opencode-ai/plugin";

// OpenCode built-in tools (https://opencode.ai/docs/tools/): bash is the
// shell tool. Legacy/alias names are kept for compatibility.
const SHELL_TOOL_NAMES = new Set(["bash", "run_commands", "execute_command", "shell"]);

let workspaceRoot = process.cwd();

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
}

/** Pull the command string(s) out of a shell tool input. */
function extractCommands(input: unknown): string[] {
	if (typeof input === "string") {
		return [input];
	}
	const record = asRecord(input);
	if (!record) {
		return [];
	}
	const commands: string[] = [];
	if (typeof record.command === "string") commands.push(record.command);
	if (Array.isArray(record.commands)) {
		for (const c of record.commands) {
			if (typeof c === "string") commands.push(c);
		}
	}
	return commands;
}

/** Normalize a command for matching: collapse whitespace. */
function normalize(cmd: string): string {
	return cmd.replace(/\s+/g, " ");
}

// Matches "git push ... main|master" as a ref (not a path like
// feature/main-fix or origin/main-backup).
const PUSH_TO_MAIN_RE =
	/\bgit\s+push\b[^|;&]*(?:\s|\/|^)(?:main|master)(?![\w./-])/;
const PR_CREATE_RE = /\bgh\s+pr\s+create\b/;
const CHANGELOG_SECTION_RE = /changelog/i;

// ── Task gate (native session todos) ─────────────────────────────────────────
// opencode has a built-in per-session todo system: the `todowrite` tool
// stores the list server-side (documented endpoint GET /session/:id/todo,
// served through the SDK client plugins receive as ctx.client). The task
// gate requires ACTIVE work in that list before any file edit.

// OpenCode file-mutation tools: `edit`, `write`, `apply_patch` (the `edit`
// permission covers all three per the permissions docs; the tools docs
// explicitly note apply_patch is reported as "apply_patch", not "patch").
const EDIT_TOOL_NAMES = new Set(["edit", "write", "patch", "apply_patch"]);

// Subagent sessions spawn with `todowrite` denied (documented: "This tool
// is disabled for subagents by default"), so a subagent's own list is
// usually empty — the gate then falls back to the parent session's list
// (sessions expose parentID) so delegated work stays gated on the
// orchestrator's breakdown.

const ACTIVE_TODO_STATUSES = new Set(["pending", "in_progress"]);

export interface TodoItem {
	content?: unknown;
	status?: unknown;
}

// Minimal structural type for the SDK client (documented endpoints
// GET /session/:id/todo, GET /session/:id, POST /tui/show-toast). Kept structural —
// not the generated SDK types — so the plugin tolerates SDK minor-version drift.
export interface TodoSdkClient {
	session?: {
		todo?: (opts: { path: { id: string } }) => Promise<{ data?: unknown }>;
		get?: (opts: { path: { id: string } }) => Promise<{ data?: { parentID?: unknown } }>;
	};
	tui?: {
		showToast?: (opts: { body: { title?: string; message: string; variant?: string } }) => Promise<unknown>;
	};
}

let sdkClient: TodoSdkClient | undefined;

/** Provide the SDK client (the plugin passes ctx.client; tests inject a fake). */
export function setSdkClient(client: unknown): void {
	sdkClient = client as TodoSdkClient | undefined;
}

async function fetchSessionTodos(sessionID: string): Promise<TodoItem[] | undefined> {
	const session = sdkClient?.session;
	const todo = session?.todo;
	if (typeof todo !== "function") return undefined;
	try {
		const result = await todo.call(session, { path: { id: sessionID } });
		const data = (result as { data?: unknown } | undefined)?.data;
		return Array.isArray(data) ? (data as TodoItem[]) : undefined;
	} catch {
		return undefined;
	}
}

async function fetchParentSessionID(sessionID: string): Promise<string | undefined> {
	const session = sdkClient?.session;
	const get = session?.get;
	if (typeof get !== "function") return undefined;
	try {
		const result = await get.call(session, { path: { id: sessionID } });
		const parent = (result as { data?: { parentID?: unknown } } | undefined)?.data?.parentID;
		return typeof parent === "string" && parent ? parent : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Todos governing a session: its own list, or — when it has none (typically
 * subagents, which cannot todowrite) — the nearest ancestor session's list.
 * Returns undefined when the list cannot be determined (client missing or
 * fetch failed); the gate then fails open instead of bricking the agent.
 */
async function effectiveTodos(
	sessionID: string | undefined,
): Promise<TodoItem[] | undefined> {
	if (!sessionID) return undefined;
	const seen = new Set<string>();
	let current: string | undefined = sessionID;
	while (current && !seen.has(current)) {
		seen.add(current);
		const todos = await fetchSessionTodos(current);
		if (todos === undefined) return undefined;
		if (todos.length > 0) return todos;
		current = await fetchParentSessionID(current);
	}
	return [];
}

function hasActiveTodo(todos: TodoItem[]): boolean {
	return todos.some((todo) => ACTIVE_TODO_STATUSES.has(String(todo.status ?? "")));
}

/**
 * Validates todo discipline rules:
 *  1. Focus rule: max one task 'in_progress' at a time.
 *  2. Sequential execution: task N cannot be marked 'completed' while an earlier
 *     task 0..N-1 is still 'pending' or 'in_progress'.
 *  3. Task lifecycle: active tasks cannot silently vanish without being marked
 *     'completed' or 'cancelled'.
 */
export function validateTodoLifecycle(
	newTodos: TodoItem[],
	existingTodos: TodoItem[] | undefined,
): string | undefined {
	// Rule 1: Single in_progress task (focus)
	const inProgress = newTodos.filter((t) => String(t.status) === "in_progress");
	if (inProgress.length > 1) {
		return (
			`Blocked todowrite: only one task may be 'in_progress' at a time (found ${inProgress.length}). ` +
			"Maintain narrow focus: finish or pause the current in-progress task before starting another."
		);
	}

	// Rule 2: Top-down sequential completion
	let seenUnfinished: string | undefined;
	let unfinishedName = "";
	for (const item of newTodos) {
		const status = String(item.status ?? "");
		if (status === "completed" && seenUnfinished !== undefined) {
			return (
				`Blocked todowrite: task '${String(item.content ?? "")}' cannot be marked completed ` +
				`while an earlier task ('${unfinishedName}') is still ${seenUnfinished}. ` +
				"Work through tasks top to bottom in list order."
			);
		}
		if (status === "pending" || status === "in_progress") {
			if (seenUnfinished === undefined) {
				seenUnfinished = status;
				unfinishedName = String(item.content ?? "");
			}
		}
	}

	// Rule 3: No silent task deletion while active work remains
	if (existingTodos && existingTodos.length > 0) {
		const activeExisting = existingTodos.filter((t) => {
			const s = String(t.status ?? "");
			return s === "pending" || s === "in_progress";
		});
		if (activeExisting.length > 0) {
			const newContents = new Set(newTodos.map((t) => String(t.content ?? "")));
			const missing = activeExisting.find(
				(t) => !newContents.has(String(t.content ?? "")),
			);
			if (missing) {
				return (
					`Blocked todowrite: active task '${String(missing.content ?? "")}' was removed ` +
					"without being marked completed or cancelled. Tasks cannot silently disappear."
				);
			}
		}
	}

	return undefined;
}

// ── Workspace boundary guard ─────────────────────────────────────────────────

function isPathOutsideWorkspace(targetPath: string, root: string): boolean {
	if (!targetPath) return false;
	const resolved = resolve(root, targetPath);
	const normalizedRoot = root.endsWith("/") ? root : root + "/";
	return resolved !== root && !resolved.startsWith(normalizedRoot);
}

function extractPatchPaths(patchText: string): string[] {
	const paths: string[] = [];
	const markerRe =
		/^\*\*\*\s+(?:Add File|Update File|Delete File|Move to|Move from):\s*(\S+)/gm;
	let match: RegExpExecArray | null;
	while ((match = markerRe.exec(patchText)) !== null) {
		if (match[1]) paths.push(match[1]);
	}
	const diffRe = /^(?:---|\+\+\+)\s+(?:[ab]\/)?(\S+)/gm;
	while ((match = diffRe.exec(patchText)) !== null) {
		if (match[1] && match[1] !== "/dev/null") paths.push(match[1]);
	}
	return paths;
}

// ── Branch guard ─────────────────────────────────────────────────────────────

const PROTECTED_BRANCHES = new Set(["main", "master"]);
const GIT_WRITE_RE =
	/\bgit\s+(commit|merge|rebase|cherry-pick|revert|stash\s+pop|apply|am|restore|reset)\b/;

function currentGitBranch(root: string): string | undefined {
	const result = spawnSync("git", ["branch", "--show-current"], {
		cwd: root,
		encoding: "utf8",
		timeout: 10_000,
	});
	if (result.status === 0 && result.stdout.trim()) {
		return result.stdout.trim();
	}
	// Fallback for unborn branches / odd runtimes: read .git/HEAD directly.
	try {
		const head = readFileSync(resolve(root, ".git", "HEAD"), "utf8").trim();
		const match = head.match(/^ref:\s+refs\/heads\/(\S+)/);
		if (match) return match[1];
	} catch {
		// Not a repo (or worktree without .git dir) — no gate.
	}
	if (result.status === 0) return ""; // detached HEAD — treat as unprotected
	return undefined;
}

function onProtectedBranch(root: string): boolean {
	const branch = currentGitBranch(root);
	return branch !== undefined && PROTECTED_BRANCHES.has(branch);
}

function branchGuardReason(): string {
	return (
		"Blocked: the workspace is on a protected branch (main/master). " +
		"Create a feature branch first — e.g. " +
		"`git switch -c feat/description` — and make all changes there, " +
		"then open a PR. Direct changes on main/master are not allowed."
	);
}

// ── Live-system guard ────────────────────────────────────────────────────────

const ALLOW_LIVE_MARKER = /#\s*allow-live\b/;

interface LivePattern {
	re: RegExp;
	what: string;
}

const LIVE_MUTATION_PATTERNS: LivePattern[] = [
	// Only DESTRUCTIVE operations are blocked. Create/update/apply/set-style
	// commands are allowed — they're normal work and reviewable in diffs.
	// Infrastructure / orchestration
	{ re: /\bkubectl\s+(delete|drain|cordon)\b/, what: "destructive kubectl command" },
	{ re: /\bkubectl\s+rollout\s+(undo|restart)\b/, what: "destructive kubectl rollout" },
	{ re: /\bhelm\s+(uninstall|rollback|delete)\b/, what: "helm release removal/rollback" },
	{ re: /\b(terraform|tofu)\s+destroy\b/, what: "terraform/tofu destroy" },
	{ re: /\bpulumi\s+destroy\b/, what: "pulumi destroy" },
	// Cloud CLI deletions
	{ re: /\baz\s+\S+\s+(delete|purge)\b/, what: "Azure resource deletion" },
	{ re: /\baz\s+(devops|repos|pipelines|boards|artifacts)\s+[\w-]*\s*(delete|abandon)\b/, what: "Azure DevOps deletion" },
	{ re: /\baws\s+\S+\s+(delete|terminate)-?\w*\b/, what: "AWS resource deletion" },
	{ re: /\bgcloud\s+\S+\s+(delete|abandon)\b/, what: "GCP resource deletion" },
	// Database destruction via CLI clients (insert/update/create are allowed)
	{ re: /\b(psql|mysql|mariadb|mongosh|mongo|redis-cli|sqlite3)\b[^|;&]*\b(drop|delete|truncate|flushall|flushdb)\b/i, what: "destructive database command" },
	// Destructive remote HTTP calls (DELETE only; POST/PUT/PATCH are normal API work)
	{ re: /\bcurl\b(?=[^|;&]*(?:(?<!\S)(?:-X|--request)\s*=?\s*DELETE))(?=[^|;&]*https?:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]))/, what: "remote HTTP DELETE" },
	// Destructive git operations
	{ re: /\bgit\s+push\b[^|;&]*(--force\b|--force-with-lease\b|\s-f\b)/, what: "force push" },
];

function liveMutationIn(command: string): string | undefined {
	for (const { re, what } of LIVE_MUTATION_PATTERNS) {
		if (re.test(command)) {
			return what;
		}
	}
	return undefined;
}

// ── MCP mutation tool guard ──────────────────────────────────────────────────
// MCP tools bypass the shell entirely, so they need their own name-based
// matching. OpenCode exposes MCP tools with names like `mcp__<server>__<tool>`;
// some runtimes use plain `<server>_<tool>` names instead, so both forms are
// matched. Read-only tool names (get/list/search/show/query/describe/…) are
// always allowed; mutating names are blocked unless explicitly allowed.

const MCP_MUTATION_VERB_RE =
	/(_create|_update|_delete|_remove|_merge|_push|_close|_edit|_set|_fork|_trigger|_cancel|_rerun|_add|_assign|_approve|_complete|_abandon)/;
const MCP_READ_ONLY_RE =
	/(_get|_list|_search|_show|_query|_describe|_find|_read|_status|_diff|_log)/;

interface GuardedMcpServer {
	nameRe: RegExp;
	what: string;
}

const GUARDED_MCP_SERVERS: GuardedMcpServer[] = [
	{ nameRe: /(?:^|__)(?:github)(?:__|$)/i, what: "GitHub" },
	{ nameRe: /(?:^|__)(?:azure|azmcp|ado|devops)(?:__|$)/i, what: "Azure/Azure DevOps" },
	// Legacy flat naming: github_create_issue, azure_repos_pr_create, …
	{ nameRe: /(^|_)(github|azure|azmcp|ado|devops)(_|$)/i, what: "GitHub/Azure DevOps" },
];

function mcpMutationTool(toolName: string): string | undefined {
	if (!MCP_MUTATION_VERB_RE.test(toolName) || MCP_READ_ONLY_RE.test(toolName)) {
		return undefined;
	}
	for (const { nameRe, what } of GUARDED_MCP_SERVERS) {
		if (nameRe.test(toolName)) {
			return what;
		}
	}
	return undefined;
}

// ── OpenCode settings tamper guard ───────────────────────────────────────────
// The model must not be able to weaken its own permission gates by editing
// opencode.json / permission config or managing auth from the agent.

// Tamper patterns are evaluated per command segment (split on newlines, |, ;,
// &) so that tokens appearing on unrelated lines of a multi-line command can't
// combine into a false match. Segments are built in isSettingsTamper below.
const SETTINGS_TAMPER_PATTERNS: RegExp[] = [
	// Writes to opencode config files — the words must appear within a single
	// path-like token, not merely anywhere in a segment.
	/[\w\/.-]*\bopencode\.json\b/i,
	/[\w\/.-]*\.config\/opencode[\w\/.-]*\.(?:json|ya?ml|toml)\b/i,
	// CLI config/auth commands — matched as command verbs, not bare words.
	/\bopencode\s+(?:auth|config|permission)\b/i,
	// Blanket auto-approval flags on the CLI.
	/\bopencode\s+(?:run\s+)?--auto\b/i,
];

function isSettingsTamper(command: string): boolean {
	// Evaluate each segment independently so regexes cannot span lines or
	// shell separators.
	const segments = command.split(/[\n|;&]+/);
	return segments.some((segment) =>
		SETTINGS_TAMPER_PATTERNS.some((re) => re.test(segment)),
	);
}

// ── PR changelog check ───────────────────────────────────────────────────────

function branchHasChangelogChange(root: string): boolean {
	try {
		const baseCandidates = ["origin/HEAD", "origin/main", "origin/master"];
		for (const base of baseCandidates) {
			const mergeBase = spawnSync(
				"git",
				["merge-base", "HEAD", base],
				{ cwd: root, encoding: "utf8", timeout: 10_000 },
			);
			if (mergeBase.status !== 0 || !mergeBase.stdout.trim()) continue;
			const diff = spawnSync(
				"git",
				["diff", "--name-only", `${mergeBase.stdout.trim()}...HEAD`],
				{ cwd: root, encoding: "utf8", timeout: 10_000 },
			);
			if (diff.status !== 0) continue;
			if (diff.stdout.split("\n").some((f) => /changelog/i.test(f))) {
				return true;
			}
		}
		// Last resort: diff against HEAD~1 (single-commit branches).
		const last = spawnSync("git", ["diff", "--name-only", "HEAD~1"], {
			cwd: root,
			encoding: "utf8",
			timeout: 10_000,
		});
		return (
			last.status === 0 &&
			last.stdout.split("\n").some((f) => /changelog/i.test(f))
		);
	} catch {
		return false;
	}
}

function prBodyIncludesChangelog(command: string): boolean {
	// Handle inline --body "..." with a Changelog section.
	const bodyMatch = command.match(/--body\s+(?:"([^"]*)"|'([^']*)')/);
	const body = bodyMatch?.[1] ?? bodyMatch?.[2] ?? "";
	if (CHANGELOG_SECTION_RE.test(body)) {
		return true;
	}
	// Handle --body-file <path> / -F <path>: read the referenced file.
	const bodyFileMatch = command.match(
		/(?:--body-file|-F)\s+(?:"([^"]*)"|'([^']*)'|(\S+))/,
	);
	const bodyFile =
		bodyFileMatch?.[1] ?? bodyFileMatch?.[2] ?? bodyFileMatch?.[3];
	if (bodyFile) {
		try {
			return CHANGELOG_SECTION_RE.test(
				readFileSync(resolve(workspaceRoot, bodyFile), "utf8"),
			);
		} catch {
			return false;
		}
	}
	return false;
}

// ── Core guard (exported for testing) ────────────────────────────────────────
// Returns a block reason string, or undefined when the call is allowed.

function logBlock(message: string): void {
	// In OpenCode TUI, writing to process.stderr / console.error writes directly
	// to the terminal screen and pollutes the interactive chat prompt input box.
	// We route blocked action logs to the OpenCode app logger instead.
	try {
		(sdkClient as any)?.app?.log?.({
			body: {
				service: "workflow-guard",
				level: "warn",
				message,
			},
		});
	} catch {}
}

export async function guardToolCall(
	toolName: string,
	input: unknown,
	context?: { sessionID?: string },
): Promise<string | undefined> {
	// ── Policy 1: todowrite lifecycle & focus validation ──
	if (toolName === "todowrite") {
		const record = asRecord(input);
		const rawTodos = record?.todos;
		if (Array.isArray(rawTodos)) {
			const existingTodos = context?.sessionID
				? await fetchSessionTodos(context.sessionID)
				: undefined;
			const err = validateTodoLifecycle(rawTodos as TodoItem[], existingTodos);
			if (err) {
				logBlock(`[workflow-guard] ${err}`);
				return err;
			}
		}
		return undefined;
	}

	// ── Policy 1, 7 & 8: edits require active todos, feature branch & workspace boundary ──
	if (EDIT_TOOL_NAMES.has(toolName)) {
		// Workspace boundary check (path traversal guard)
		const record = asRecord(input);
		const target =
			typeof record?.filePath === "string"
				? record.filePath
				: typeof record?.path === "string"
					? record.path
					: typeof input === "string"
						? input
						: "";
		if (target && isPathOutsideWorkspace(target, workspaceRoot)) {
			logBlock(
				`[workflow-guard] blocked ${toolName}: path escapes workspace: ${target}`,
			);
			return `Blocked: file path '${target}' escapes workspace root (${workspaceRoot}). All changes must stay within the workspace.`;
		}
		if (toolName === "apply_patch") {
			const patchText =
				typeof record?.patchText === "string" ? record.patchText : "";
			for (const patchPath of extractPatchPaths(patchText)) {
				if (isPathOutsideWorkspace(patchPath, workspaceRoot)) {
					logBlock(
						`[workflow-guard] blocked apply_patch: patch target escapes workspace: ${patchPath}`,
					);
					return `Blocked: patch targets file '${patchPath}' outside workspace root (${workspaceRoot}).`;
				}
			}
		}

		if (onProtectedBranch(workspaceRoot)) {
			logBlock(
				`[workflow-guard] blocked ${toolName}: on protected branch ${currentGitBranch(workspaceRoot)}`,
			);
			return branchGuardReason();
		}
		const todos = await effectiveTodos(context?.sessionID);
		if (todos !== undefined && !hasActiveTodo(todos)) {
			logBlock(
				`[workflow-guard] blocked ${toolName}: no active todo item (session ${context?.sessionID ?? "?"})`,
			);
			return (
				"Blocked: no active todo item. First break the request down " +
				"with the todowrite tool (create items with status 'pending' " +
				"or 'in_progress'), then work them top to bottom, marking " +
				"each completed via todowrite as you finish it. When every " +
				"item is completed, create a fresh todo list before " +
				"starting new work."
			);
		}
		return undefined;
	}

	const allowLive = process.env.WORKFLOW_GUARD_ALLOW_LIVE === "1";

	// ── Policy 5: MCP tools that mutate GitHub / Azure / DevOps ──
	// MCP calls carry no command string, so the only override is the env var.
	if (!allowLive) {
		const mcpWhat = mcpMutationTool(toolName);
		if (mcpWhat) {
			logBlock(
				`[workflow-guard] blocked MCP tool ${toolName} (${mcpWhat} mutation)`,
			);
			return (
				`Blocked: ${toolName} mutates ${mcpWhat} — a live ` +
				"system. Changes must be made in code unless the user " +
				"explicitly allows live changes. To override, the user must " +
				"restart the agent with WORKFLOW_GUARD_ALLOW_LIVE=1."
			);
		}
	}

	if (!SHELL_TOOL_NAMES.has(toolName)) {
		return undefined;
	}

	const commands = extractCommands(input);
	for (const raw of commands) {
		const command = normalize(raw);

		// ── Policy 7: changes only on feature branches ───────────
		if (GIT_WRITE_RE.test(command) && onProtectedBranch(workspaceRoot)) {
			logBlock(
				`[workflow-guard] blocked git write on protected branch: ${command.slice(0, 120)}`,
			);
			return branchGuardReason();
		}

		// ── Policy 6: block self-modification of approval gates ──
		if (isSettingsTamper(command)) {
			logBlock(
				`[workflow-guard] blocked settings tamper: ${command.slice(0, 120)}`,
			);
			return (
				"Blocked: modifying OpenCode config / permissions / auth " +
				"is not allowed from the agent. The user must change " +
				"permission settings manually in opencode.json or the UI."
			);
		}

		// ── Policy 4: live-system mutations need explicit opt-in ──
		if (!allowLive && !ALLOW_LIVE_MARKER.test(command)) {
			const what = liveMutationIn(command);
			if (what) {
				logBlock(
					`[workflow-guard] blocked ${what}: ${command.slice(0, 120)}`,
				);
				return (
					`Blocked: ${what} targets a live system. Changes must be ` +
					"made in code (IaC, migrations, source) unless the user " +
					"explicitly allows live changes. To override: re-run with " +
					"'# allow-live' appended to the command, or set " +
					"WORKFLOW_GUARD_ALLOW_LIVE=1."
				);
			}
		}

		// ── Policy 2: block git push to main/master ──────────────────
		if (PUSH_TO_MAIN_RE.test(command)) {
			logBlock(
				`[workflow-guard] blocked push to main/master: ${command}`,
			);
			return (
				"Blocked: direct pushes to main/master are not allowed. " +
				"Create a feature branch and open a PR instead."
			);
		}

		// ── Policy 3: PRs must include a changelog ─────────────────────
		if (PR_CREATE_RE.test(command)) {
			const hasChangelog =
				prBodyIncludesChangelog(command) ||
				branchHasChangelogChange(workspaceRoot);
			if (!hasChangelog) {
				logBlock(
					"[workflow-guard] blocked gh pr create: no changelog found",
				);
				return (
					"Blocked: PR must include a changelog. Either update a " +
					"CHANGELOG file in this branch's diff, or include a " +
					"'Changelog:' section in the PR body (--body)."
				);
			}
		}
	}

	return undefined;
}

/** Set the workspace root (used by the plugin and tests). */
export function setWorkspaceRoot(root: string): void {
	workspaceRoot = root;
}

export const WorkflowGuard: Plugin = async (ctx) => {
	// ctx.directory is the directory opencode was started in; ctx.client is
	// the SDK client for the built-in server (used for the session todo
	// list — documented endpoint GET /session/:id/todo).
	setWorkspaceRoot(ctx.directory ?? process.cwd());
	setSdkClient(ctx.client);

	try {
		await (ctx.client as any)?.app?.log?.({
			body: {
				service: "workflow-guard",
				level: "info",
				message: `Workflow Guard plugin initialized for ${ctx.directory ?? process.cwd()}`,
			},
		});
	} catch {}

	return {
		// OpenCode passes the tool args as the SECOND hook parameter
		// (`output.args` — documented in the tools docs, e.g. apply_patch
		// "uses output.args.patchText"; `input` only carries
		// { tool, sessionID, callID }). The fallback covers hypothetical
		// runtimes that put args on the input.
		"tool.execute.before": async (input, output) => {
			const args =
				(output as { args?: unknown } | undefined)?.args ??
				(input as { args?: unknown }).args;
			const reason = await guardToolCall(input.tool, args, {
				sessionID: input.sessionID,
			});
			if (reason !== undefined) {
				// Throwing from the hook blocks the tool call (see the
				// ".env protection" example in the opencode plugin docs).
				throw new Error(`[workflow-guard] ${reason}`);
			}
		},

		// Focus preservation across context compaction (documented in
		// https://opencode.ai/docs/plugins/#compaction-hooks).
		"experimental.session.compacting": async (input, output) => {
			try {
				const sessionID = (input as { sessionID?: string })?.sessionID;
				const todos = await effectiveTodos(sessionID);
				const active = todos?.filter((t) => {
					const s = String(t.status ?? "");
					return s === "pending" || s === "in_progress";
				});
				if (active && active.length > 0) {
					const lines = active.map(
						(t) =>
							`- [${String(t.status) === "in_progress" ? "IN PROGRESS" : "PENDING"}] ${String(t.content ?? "")}`,
					);
					const contextPrompt =
						"## Active Tasks (Sequential Order Required)\n" +
						lines.join("\n") +
						"\nStrict focus rule: complete the in-progress task before starting another.";
					if (Array.isArray(output?.context)) {
						output.context.push(contextPrompt);
					}
				}
			} catch {}
		},
	};
};

// Default export MUST be a V1 PluginModule record.
export default {
	id: "workflow-guard",
	server: WorkflowGuard,
} satisfies PluginModule;
