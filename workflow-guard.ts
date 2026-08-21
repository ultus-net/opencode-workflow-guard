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
 *  2. Git pushes to main/master (incl. refspecs like HEAD:main or :main)
 *     are hard-blocked.
 *  3. PR creation (gh) requires a changelog — either a CHANGELOG update in
 *     the branch's diff or a "Changelog:" section in the PR body.
 *  4. Live-system guard: destructive commands targeting infrastructure,
 *     databases, or remote APIs are blocked unless the USER overrides with
 *     WORKFLOW_GUARD_ALLOW_LIVE=1 in the environment before launch. There
 *     is deliberately no in-command override — the agent cannot grant it
 *     to itself.
 *  5. MCP mutation guard: GitHub / Azure DevOps MCP tools with mutation
 *     verbs in their names are blocked (read-only verbs pass).
 *  6. Settings tamper guard: the agent cannot edit opencode.json /
 *     permission config / the guard's own plugin files — via shell OR via
 *     the file-editing tools — or run `opencode auth` to weaken its gates.
 *  7. Branch guard: on main/master, file mutations and history-changing
 *     git commands are blocked until a feature branch is created.
 *  8. Workspace boundary guard: file mutations cannot escape the workspace
 *     root — via edit tools, patches, or shell redirection/copy commands.
 *  9. Script laundering guard: content written via edit/write/apply_patch
 *     is scanned for destructive commands, so `write deploy.sh` followed by
 *     `bash deploy.sh` cannot smuggle blocked operations past the shell
 *     guards.
 *
 * Known limits (defense in depth, not a sandbox): these guards match on
 * command/file strings. An agent that base64-encodes a payload or invokes
 * an interpreter directly (`python3 -c ...`) can evade pattern matching.
 * Pair this plugin with OS-level isolation (branch protection, containers)
 * for hard guarantees.
 *
 * Install: copy this file into <project>/.opencode/plugins/ or
 * ~/.config/opencode/plugins/ — files there are auto-loaded at startup.
 * Requires opencode >= 1.18 (todo endpoint GET /session/:id/todo).
 */

import { spawnSync, spawn } from "node:child_process";
import { mkdirSync, realpathSync, readFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Plugin, PluginModule } from "@opencode-ai/plugin";

// OpenCode built-in tools (https://opencode.ai/docs/tools/): bash is the
// shell tool. Legacy/alias names are kept for compatibility.
const SHELL_TOOL_NAMES = new Set(["bash", "run_commands", "execute_command", "shell"]);

const PROTECTED_BRANCHES = new Set(["main", "master"]);

let workspaceRoot = process.cwd();
let workspaceRootReal = workspaceRoot;
try {
	workspaceRootReal = realpathSync(workspaceRoot);
} catch {}

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

// Matches a direct push of main|master: "git push origin main",
// "git push main", "git push origin local:main" (refspec), "git push
// origin :main" (branch deletion), "git push origin +HEAD:master" (forced
// refspec). The right-hand side of a refspec must be exactly main/master —
// feature/main-fix or HEAD:main-backup are fine.
const PUSH_TO_MAIN_RE =
	/\bgit\s+push\b[^|;&]*(?:^|\s)\+?[\w./-]*:(?:main|master)(?![\w./-])|\bgit\s+push\b[^|;&]*(?:\s|\/)(?:main|master)(?![\w./-])/;
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

// ── Shell file-mutation heuristic ────────────────────────────────────────────
// The edit/write/apply_patch gates (todo, branch, boundary) are meaningless
// if the same mutations can happen through the shell. These heuristics catch
// the common file-writing shell idioms so the same gates apply. This is a
// heuristic, not a shell parser: exotic redirects can evade it, which is why
// content scanning of edit payloads (script-laundering guard) also exists.

interface ShellMutation {
	kind: "redirect" | "command";
	target?: string;
	what: string;
}

/** Extract file paths mutated by a single shell command segment. */
function shellMutationIn(segment: string): ShellMutation | undefined {
	// Redirection to a file: > file, >> file, 2> file, | tee file
	const redirectMatch = segment.match(
		/(?:^|\s|>)(?:[0-9]*>>?)\s*["']?([^\s>&|;"']+)/,
	);
	if (redirectMatch?.[1]) {
		return {
			kind: "redirect",
			target: redirectMatch[1],
			what: `file redirect to '${redirectMatch[1]}'`,
		};
	}
	const teeMatch = segment.match(/\btee\s+(?:-a\s+)?["']?([^\s;&|"']+)/);
	if (teeMatch?.[1]) {
		return {
			kind: "command",
			target: teeMatch[1],
			what: `tee to '${teeMatch[1]}'`,
		};
	}
	// In-place editing: sed -i file …
	const sedMatch = segment.match(/\bsed\s+(?:-(?:[a-zA-Z]*i[a-zA-Z]*|i\S*)\s+)+[^\s;&|]+/);
	if (sedMatch) {
		// first non-flag token after the -i flags is the script; the file is
		// the LAST token (sed -i 's/x/y/' file)
		const tokens = sedMatch[0]!.split(/\s+/);
		const target = tokens[tokens.length - 1];
		return { kind: "command", target, what: `sed -i on '${target}'` };
	}
	// Copy/move into the workspace: cp/mv/rsync … dest
	const copyMatch = segment.match(
		/\b(?:cp|mv|rsync|install|cpio|scp|wget|curl)\b[^|;&]*?(-o\s+)?(["']?)([^\s;&|"']+)\2?\s*$/,
	);
	if (copyMatch?.[3] && /\b(?:cp|mv|rsync|install)\b/.test(segment)) {
		return {
			kind: "command",
			target: copyMatch[3],
			what: `copy/move to '${copyMatch[3]}'`,
		};
	}
	// git apply / git am (mutates working tree via patch stdin/file)
	if (/\bgit\s+(?:apply|am)\b/.test(segment)) {
		return { kind: "command", what: "git apply/am (patch via shell)" };
	}
	return undefined;
}

/**
 * Mutations via the shell are subject to the same gates as direct edits:
 * todo activity, branch protection (targets inside the workspace) and the
 * workspace boundary (targets must not escape). Returns a block reason.
 */
async function guardShellMutation(
	command: string,
	sessionID: string | undefined,
): Promise<string | undefined> {
	const allowLive = process.env.WORKFLOW_GUARD_ALLOW_LIVE === "1";
	for (const segment of command.split(/[\n|;&]+/)) {
		const mutation = shellMutationIn(segment.trim());
		if (!mutation) continue;
		const target = mutation.target ?? "";
		// git apply/am has no explicit filename target — treat as workspace
		// mutation: subject to todo + branch gates, boundary implicit.
		if (target && isProtectedPath(target)) {
			return PROTECTED_PATH_REASON;
		}
		if (target && isPathOutsideWorkspace(target, workspaceRoot)) {
			// A redirect OUT of the workspace is also a live-system write.
			if (!allowLive) {
				return `Blocked: shell mutation '${mutation.what}' targets a path outside the workspace root (${workspaceRoot}). All changes must stay within the workspace.`;
			}
			continue;
		}
		if (onProtectedBranch(workspaceRoot)) {
			return branchGuardReason();
		}
		const todos = await effectiveTodos(sessionID);
		if (todos !== undefined && !hasActiveTodo(todos)) {
			return (
				"Blocked: shell file mutation with no active todo item. " +
				"Break the request down with todowrite first, then apply " +
				"changes (the same gates apply to shell redirects, tee, " +
				"sed -i, cp/mv and git apply as to the edit tools)."
			);
		}
		return undefined; // one gated mutation per segment is enough
	}
	return undefined;
}

// ── Branch guard ─────────────────────────────────────────────────────────────

// Git global options that change which repository/work-tree a command acts
// on. These must be parsed (not regexed around) so that e.g.
// `git -C /other/repo commit` is gated on /other/repo's branch, not ours.
const GIT_DIR_OPTION_TAKES_VALUE = new Set([
	"-C",
	"--git-dir",
	"--work-tree",
	"-c",
	"--config-env",
	"--namespace",
]);
const GIT_DIR_OPTION_PREFIXED =
	/^(--git-dir=|--work-tree=|--namespace=|-c\S|--config-env=)/;

interface GitInvocation {
	repoDir: string;
	rest: string;
}

/**
 * Parse the leading global options off a `git …` command segment, returning
 * the effective repository directory (-C/--git-dir change it; --work-tree
 * alone does not) and the remainder (subcommand + args). Used so that
 * global flags cannot smuggle a guarded subcommand past the regexes.
 */
function parseGitInvocation(command: string): GitInvocation | undefined {
	if (!/^\s*git\s/.test(command)) return undefined;
	const tokens = command.split(/\s+/);
	let i = 1;
	let repoDir = workspaceRoot;
	let sawDirOption = false;
	while (i < tokens.length) {
		const tok = tokens[i]!;
		if (GIT_DIR_OPTION_TAKES_VALUE.has(tok)) {
			const value = tokens[i + 1];
			if (value === undefined) return { repoDir, rest: "" };
			if (tok === "-C" || tok === "--git-dir") {
				repoDir = resolve(workspaceRoot, value);
				sawDirOption = true;
			}
			i += 2;
			continue;
		}
		if (GIT_DIR_OPTION_PREFIXED.test(tok)) {
			if (tok.startsWith("--git-dir=")) {
				repoDir = resolve(workspaceRoot, tok.slice("--git-dir=".length));
				sawDirOption = true;
			}
			i += 1;
			continue;
		}
		// Bare global flags that take no value.
		if (/^(--version|--help|--no-pager|-p|--paginate|--bare|--literal-pathspecs|--no-optional-locks|--exec-path)$/.test(tok)) {
			i += 1;
			continue;
		}
		break;
	}
	if (!sawDirOption) repoDir = workspaceRoot;
	return { repoDir, rest: tokens.slice(i).join(" ") };
}

/**
 * Rewrite a command so every `git [global-opts] <sub>` becomes plain
 * `git <sub>`, letting the guard regexes match the subcommand regardless of
 * global flags. Non-git segments pass through unchanged.
 */
function normalizeGitCommands(command: string): string {
	return command
		.split("\n")
		.map((line) => {
			const parsed = parseGitInvocation(line);
			return parsed ? `git ${parsed.rest}` : line;
		})
		.join("\n");
}

const GIT_WRITE_RE =
	/\bgit\s+(commit|merge|rebase|cherry-pick|revert|stash\s+pop|apply|am|restore|reset|update-ref|filter-branch)\b|\bgit\s+branch\s+(?:[^|;&]*\s)?-[dDM]\b/;

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
// The ONLY override is the WORKFLOW_GUARD_ALLOW_LIVE=1 environment variable,
// which the user must set before launching the agent. There is deliberately
// no in-command marker: an override the agent can append to its own command
// (or is told about in an error message) is an override the agent WILL use.

interface LivePattern {
	re: RegExp;
	what: string;
}

const LIVE_MUTATION_PATTERNS: LivePattern[] = [
	// Only DESTRUCTIVE operations are blocked. Create/update/apply/set-style
	// commands are allowed — they're normal work and reviewable in diffs.
	// Filesystem destruction
	{ re: /\brm\s+(?:-[a-zA-Z]*[rRfF][a-zA-Z]*\s+)*-[a-zA-Z]*[rRfF][a-zA-Z]*(?:\s|$)/, what: "recursive/forced file deletion (rm -rf)" },
	{ re: /\b(?:sudo\s+)?rm\s+-(?:[a-zA-Z]*[rRfF][a-zA-Z]*\s+){1,2}(?:\/|~)/, what: "forced deletion of system/home paths" },
	{ re: /\bgit\s+clean\s+(?:-[a-zA-Z]*[fdx][a-zA-Z]*)(?:\s|$)/, what: "git clean (untracked file deletion)" },
	{ re: /\bgit\s+push\b[^|;&]*\s\+(?:[\w./-]*:)?/, what: "force push via + refspec" },
	// Infrastructure / orchestration
	{ re: /\bkubectl\s+(delete|drain|cordon)\b/, what: "destructive kubectl command" },
	{ re: /\bkubectl\s+rollout\s+(undo|restart)\b/, what: "destructive kubectl rollout" },
	{ re: /\bhelm\s+(uninstall|rollback|delete)\b/, what: "helm release removal/rollback" },
	{ re: /\b(?:terraform|tofu)\s+destroy\b/, what: "terraform/tofu destroy" },
	{ re: /\bpulumi\s+destroy\b/, what: "pulumi destroy" },
	// Containers
	{ re: /\bdocker\s+(?:container\s+)?(?:rm|prune)\b/, what: "docker container/image removal" },
	{ re: /\bdocker\s+(?:system|image|volume|network)\s+prune\b/, what: "docker prune" },
	{ re: /\bdocker\s+volume\s+rm\b/, what: "docker volume removal" },
	// Cloud CLI deletions
	{ re: /\baz\s+\S+\s+(?:delete|purge)\b/, what: "Azure resource deletion" },
	{ re: /\baz\s+(?:devops|repos|pipelines|boards|artifacts)\s+[\w-]*\s*(?:delete|abandon)\b/, what: "Azure DevOps deletion" },
	{ re: /\baws\s+\S+\s+(?:delete|terminate)-?\w*\b/, what: "AWS resource deletion" },
	{ re: /\bgcloud\s+\S+\s+(?:delete|abandon)\b/, what: "GCP resource deletion" },
	// Hosted repo / PR destruction via CLI
	{ re: /\bgh\s+(?:repo|issue|pr|release|secret|variable)\s+(?:delete|close)\b/, what: "gh destructive command" },
	// Database destruction via CLI clients (insert/update/create are allowed)
	{ re: /\b(?:psql|mysql|mariadb|mongosh|mongo|redis-cli|sqlite3)\b[^|;&]*\b(?:drop|delete|truncate|flushall|flushdb)\b/i, what: "destructive database command" },
	{ re: /\b(?:npx|pnpm\s+exec|yarn)\s+prisma\s+migrate\s+reset\b/, what: "prisma migrate reset (database wipe)" },
	{ re: /\bprisma\s+migrate\s+reset\b/, what: "prisma migrate reset (database wipe)" },
	// Destructive remote HTTP calls (DELETE only; POST/PUT/PATCH are normal API work)
	{ re: /\bcurl\b(?=[^|;&]*(?:(?<!\S)(?:-X|--request)\s*=?\s*DELETE))(?=[^|;&]*https?:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]))/, what: "remote HTTP DELETE" },
	// Destructive git operations
	{ re: /\bgit\s+push\b[^|;&]*(?:--force\b|--force-with-lease\b|\s-f\b)/, what: "force push" },
];

function liveMutationIn(command: string): string | undefined {
	for (const { re, what } of LIVE_MUTATION_PATTERNS) {
		if (re.test(command)) {
			return what;
		}
	}
	return undefined;
}

// ── Secret content scan ──────────────────────────────────────────────────────
// Common credential shapes that must never end up committed to a repo. This
// list is intentionally conservative — it aims to catch obvious accidents
// (env-file contents, keys copied into source) rather than every secret on
// earth. False positives return an actionable error.

interface SecretPattern {
	re: RegExp;
	what: string;
}

const SECRET_PATTERNS: SecretPattern[] = [
	{ re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, what: "private key material" },
	{ re: /\bAKIA[0-9A-Z]{16}\b/, what: "AWS access key ID" },
	{ re: /\bASIA[0-9A-Z]{16}\b/, what: "AWS temporary session credential" },
	{ re: /\bghp_[A-Za-z0-9]{36}\b/, what: "GitHub personal access token" },
	{ re: /\bgithub_pat_[A-Za-z0-9_]{82}\b/, what: "GitHub fine-grained PAT" },
	{ re: /\bgho_[A-Za-z0-9]{36}\b/, what: "GitHub OAuth token" },
	{ re: /\bghu_[A-Za-z0-9]{36}\b/, what: "GitHub user-to-server token" },
	{ re: /\bghs_[A-Za-z0-9]{36}\b/, what: "GitHub server-to-server token" },
	{ re: /\bghr_[A-Za-z0-9]{36}\b/, what: "GitHub refresh token" },
	{ re: /\bsk-[A-Za-z0-9]{20,}\b/, what: "OpenAI-style API key" },
	{ re: /\bog-[A-Za-z0-9]{20,}\b/, what: "OpenCode/legacy API key" },
	{ re: /\bAIza[0-9A-Za-z_-]{35}\b/, what: "Google API key" },
	{ re: /\bywq[A-Za-z0-9_-]{44,}\b/, what: "Slack token (xoxp/xoxb/xoxa family)" },
	{ re: /\bywq[A-Za-z0-9_-]{10,}\b/, what: "Slack-style token" },
	// Explicit env-style assignments are a common accident in .env files.
	{ re: /(?:^|\s)(?:AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)\s*=\s*\S+/, what: "AWS credential assignment" },
	{ re: /(?:^|\s)(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENAI_KEY)\s*=\s*\S+/, what: "LLM API key assignment" },
];

function secretIn(content: string): string | undefined {
	for (const { re, what } of SECRET_PATTERNS) {
		if (re.test(content)) return what;
	}
	return undefined;
}

/**
 * Extract executable-looking content from file-edit tool input (write/edit
 * payloads, apply_patch texts). Scanned for destructive patterns so that
 * writing a script and executing it cannot launder a blocked command.
 */
function extractEditContent(input: unknown): string[] {
	const record = asRecord(input);
	if (!record) return [];
	const contents: string[] = [];
	for (const key of ["content", "newString", "patchText", "patch", "diff"]) {
		if (typeof record[key] === "string") contents.push(record[key] as string);
	}
	// apply_patch in some runtimes is an array of file ops
	if (Array.isArray(record.changes)) {
		for (const change of record.changes) {
			const r = asRecord(change);
			if (r && typeof r.content === "string") contents.push(r.content);
		}
	}
	return contents;
}

// ── MCP mutation tool guard ──────────────────────────────────────────────────
// MCP tools bypass the shell entirely, so they need their own name-based
// matching. OpenCode exposes MCP tools with names like `mcp__<server>__<tool>`;
// some runtimes use plain `<server>_<tool>` names instead, so both forms are
// matched. Read-only tool names (get/list/search/show/query/describe/…) are
// always allowed; mutating names are blocked unless explicitly allowed.

const MCP_MUTATION_VERB_RE =
	/(?:^|_)(?:create|update|delete|remove|merge|push|close|edit|set|fork|trigger|cancel|rerun|add|assign|approve|complete|abandon)(?:_|$)/;
const MCP_READ_ONLY_RE =
	/(?:^|_)(?:get|list|search|show|query|describe|find|read|status|diff|log)(?:_|$)/;

// Guarded servers. Matched as whole tokens after splitting on
// non-alphanumerics, so `azure-devops` → {azure, devops}, `gh` → {gh}, etc.
const GUARDED_MCP_SERVERS = new Set([
	"github",
	"gh",
	"azure",
	"azmcp",
	"ado",
	"devops",
	"azuredevops",
]);

function mcpMutationTool(toolName: string): string | undefined {
	if (!MCP_MUTATION_VERB_RE.test(toolName) || MCP_READ_ONLY_RE.test(toolName)) {
		return undefined;
	}
	const tokens = toolName.toLowerCase().split(/[^a-z0-9]+/);
	if (tokens.some((t) => GUARDED_MCP_SERVERS.has(t))) {
		return "GitHub/Azure DevOps";
	}
	return undefined;
}

// ── OpenCode settings tamper guard ───────────────────────────────────────────
// The model must not be able to weaken its own permission gates by editing
// opencode.json / permission config, tampering with the guard's own plugin
// files, or managing auth from the agent. This is enforced in BOTH the
// shell guard (below) and the file-edit tools (via isProtectedPath), because
// an agent that can `edit` a config file directly doesn't need the shell.

/**
 * True when a filesystem path targets OpenCode's own configuration, plugin,
 * or auth state — anything the agent could modify to weaken the guard.
 * Checked against the path resolved from the workspace root.
 */
function isProtectedPath(targetPath: string): boolean {
	if (!targetPath) return false;
	const resolved = resolve(workspaceRoot, targetPath);
	const base = basename(resolved);
	const lower = resolved.toLowerCase();
	return (
		// opencode.json / opencode.jsonc anywhere (project config)
		/^opencode\.jsonc?$/i.test(base) ||
		// anything under a .opencode directory (project plugins, agents)
		lower.includes(`${"/"}.opencode/`) ||
		// anything under ~/.config/opencode (global config, plugins, ui)
		lower.includes("/.config/opencode/") ||
		lower.includes("/.config/opencode.json")
	);
}

/**
 * Strip shell quote-concatenation and escape sequences that exist only to
 * break up a literal string: open''code.json -> opencode.json,
 * open""code -> opencode, open\c\ode -> opencode. Applied to each segment
 * before pattern matching so evasion requires more than quoting.
 */
function normalizeShellEvasion(text: string): string {
	return text
		.replace(/'([^']*)'/g, "$1") // open''code -> opencode (quoted content kept)
		.replace(/"([^"]*)"/g, "$1")
		.replace(/\\(.)/g, "$1"); // open\c\ode -> opencode
}

/**
 * Collapse shell glob wildcards on the final path component so that
 * `opencode.jso?` or `opencode.*` still match the protected name.
 */
function normalizeGlobPathEvasion(text: string): string {
	return text
		.replace(/opencode\.jso[?]/gi, "opencode.json")
		.replace(/opencode\.[?*]/gi, "opencode.json");
}

// Tamper patterns are evaluated per command segment (split on newlines, |, ;,
// &) so that tokens appearing on unrelated lines of a multi-line command can't
// combine into a false match. Patterns that target config PATHS require a
// write verb or redirect, so merely READING a config file (cat, less, grep)
// is allowed — only modification attempts are blocked.
const SETTINGS_TAMPER_PATTERNS: RegExp[] = [
	// Shell writes to opencode config paths — write verb/redirect required.
	/(?:^|\s)(?:sed\s+-i|tee|mv|cp|rm|chmod|chown|ln|install|truncate|dd)\s+[^|;&]*?(?:[\w\/.~-]*opencode\.jsonc?|[\w\/.~-]*\.config\/opencode|[\w\/.~-]*\.opencode\/)/i,
	/>\s*["']?[\w\/.~-]*(?:opencode\.jsonc?|\.config\/opencode|\.opencode\/)/i,
	// Editing the guard plugin itself or its TUI companion (any file,
	// not just config) — self-protection.
	/(?:^|\s)(?:sed\s+-i|tee|mv|cp|rm|chmod|chown|truncate|dd)\s+[^|;&]*?[\w\/.~-]*\.config\/opencode\/(?:plugins|ui)\//i,
	/>\s*["']?[\w\/.~-]*\.config\/opencode\/(?:plugins|ui)\//i,
	// CLI config/auth commands — matched as command verbs, not bare words.
	/\bopencode\s+(?:auth|config|permission)\b/i,
	// Blanket auto-approval flags on the CLI.
	/\bopencode\s+(?:run\s+)?--auto\b/i,
];

const PROTECTED_PATH_REASON =
	"Blocked: modifying OpenCode config / permissions / auth / the guard " +
	"plugin itself is not allowed from the agent. The user must change " +
	"these manually in opencode.json or the UI.";

function isSettingsTamper(command: string): boolean {
	// Evaluate each segment independently so regexes cannot span lines or
	// shell separators. Normalize evasion before matching.
	const segments = command.split(/[\n|;&]+/).map((s) =>
		normalizeGlobPathEvasion(normalizeShellEvasion(s)),
	);
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

// ── Post-edit verification gate ─────────────────────────────────────────────
// The guard currently blocks edits before they happen, but never verifies the
// result. Agents routinely mark the final todo "completed" without ever
// running the test suite. VERIFY_COMMAND (env) or an auto-detected `npm test`
// is run after every edit/write/patch, and todowrite is blocked from marking
// its last task completed while verification is failing.

let lastVerify: { passed: boolean; command: string; output: string } | undefined;
let verifyInProgress = false;

// Sensitive environment variables scrubbed from agent shells by the
// shell.env hook. Prefix matches (AWS_*, KUBE*) and exact names are both
// listed; the exec-check RE handles the prefix family.
const SENSITIVE_ENV_KEYS = [
	"GITHUB_TOKEN",
	"GH_TOKEN",
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"OPENAI_KEY",
	"KUBECONFIG",
	"NPM_TOKEN",
	"DOCKER_AUTH",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GCLOUD_AUTH",
	"AZURE_CREDENTIALS",
	"SLACK_TOKEN",
];
const SENSITIVE_ENV_RE = /^(AWS_|KUBE|OPENAI|ANTHROPIC|GH_|GITHUB_|GOOGLE_|GCP_|AZURE_|SLACK_|NPM_|DOCKER_|KUBECONFIG)/;

function detectVerifyCommand(root: string): string | undefined {
	if (process.env.WORKFLOW_GUARD_VERIFY !== undefined) {
		const cmd = process.env.WORKFLOW_GUARD_VERIFY.trim();
		return cmd || undefined; // empty string = "disabled"
	}
	try {
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
			scripts?: Record<string, string>;
		};
		if (pkg.scripts?.test) return "npm test";
	} catch {}
	return undefined;
}

async function runVerify(command: string, root: string): Promise<{ passed: boolean; output: string }> {
	return new Promise((resolve) => {
		const child = spawn(command, { cwd: root, shell: true, encoding: "utf8" } as never);
		let output = "";
		child.stdout?.on("data", (d) => (output += d));
		child.stderr?.on("data", (d) => (output += d));
		child.on("close", (code) => resolve({ passed: code === 0, output }));
		child.on("error", () => resolve({ passed: false, output: "(spawn failed)" }));
	});
}

function recordVerifyResult(command: string, result: { passed: boolean; output: string }): void {
	lastVerify = { command, passed: result.passed, output: result.output.slice(-4000) };
}
// Every block/allow decision is appended as a JSON line to a durable file so
// developers can reconstruct why the agent was (or was not) allowed. This
// complements client.app.log() (in-app, undocumented durability) with a real
// on-disk log the user can review.
const AUDIT_DIR = join(
	process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
	"opencode",
	"workflow-guard",
);
const AUDIT_FILE = join(AUDIT_DIR, "workflow-guard.jsonl");

interface AuditEntry {
	ts: string;
	sessionID?: string;
	tool: string;
	decision: "allow" | "block";
	reason?: string;
	input?: unknown;
}

function audit(entry: AuditEntry): void {
	try {
		mkdirSync(AUDIT_DIR, { recursive: true });
		appendFileSync(AUDIT_FILE, JSON.stringify(entry) + "\n", "utf8");
	} catch {
		// Logging must never break the guard.
	}
}

function logDecision(
	tool: string,
	input: unknown,
	context: { sessionID?: string } | undefined,
	reason: string | undefined,
): void {
	audit({
		ts: new Date().toISOString(),
		sessionID: context?.sessionID,
		tool,
		decision: reason ? "block" : "allow",
		reason,
		input: summarizeInput(input),
	});
}

function summarizeInput(input: unknown): unknown {
	const record = asRecord(input);
	if (!record) return typeof input === "string" ? input.slice(0, 200) : input;
	if (typeof record.command === "string") return { command: record.command.slice(0, 200) };
	if (typeof record.filePath === "string") return { filePath: record.filePath };
	if (typeof record.path === "string") return { path: record.path };
	if (typeof record.patchText === "string") return { patchText: record.patchText.slice(0, 200) };
	return { keys: Object.keys(record) };
}

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

async function guardToolCallImpl(
	toolName: string,
	input: unknown,
	context?: { sessionID?: string },
): Promise<string | undefined> {
	// ── Policy 1: todowrite lifecycle & focus validation ──
	if (toolName === "todowrite") {
		const record = asRecord(input);
		const rawTodos = record?.todos;
		if (Array.isArray(rawTodos)) {
			const newTodos = rawTodos as TodoItem[];
			const existingTodos = context?.sessionID
				? await fetchSessionTodos(context.sessionID)
				: undefined;
			const err = validateTodoLifecycle(newTodos, existingTodos);
			if (err) {
				logBlock(`[workflow-guard] ${err}`);
				return err;
			}

			// Final-completion gate (Policy 10): when EVERY task is being marked
			// done and the workspace has an active verify command, the latest
			// verification must be passing — otherwise the edit that fixed the
			// final task may have silently broken the build.
			const allDone =
				newTodos.length > 0 &&
				newTodos.every((t) => {
					const s = String(t.status ?? "");
					return s === "completed" || s === "cancelled";
				});
			if (allDone && lastVerify && !lastVerify.passed) {
				const tail = lastVerify.output.slice(-500);
				const reason =
					`Blocked todowrite: all tasks marked done but verification is failing ` +
					`(${lastVerify.command}). Fix the failure before finishing; ` +
					`output tail: ${tail}`;
				logBlock(`[workflow-guard] ${reason}`);
				return reason;
			}
		}
		return undefined;
	}

	// ── Policies 1, 6, 7, 8 & 9: edit/write/patch gates ──
	if (EDIT_TOOL_NAMES.has(toolName)) {
		const allowLive = process.env.WORKFLOW_GUARD_ALLOW_LIVE === "1";
		const record = asRecord(input);
		const target =
			typeof record?.filePath === "string"
				? record.filePath
				: typeof record?.path === "string"
					? record.path
					: typeof input === "string"
						? input
						: "";

		// Settings tamper via edit tools (P0.2): editing opencode config or
		// the guard's own plugin files is blocked even via the edit tools.
		if (target && isProtectedPath(target)) {
			logBlock(`[workflow-guard] blocked ${toolName}: protected path ${target}`);
			return PROTECTED_PATH_REASON;
		}
		if (toolName === "apply_patch") {
			const patchText =
				typeof record?.patchText === "string" ? record.patchText : "";
			for (const patchPath of extractPatchPaths(patchText)) {
				if (isProtectedPath(patchPath)) {
					logBlock(
						`[workflow-guard] blocked apply_patch: protected path ${patchPath}`,
					);
					return PROTECTED_PATH_REASON;
				}
				if (isPathOutsideWorkspace(patchPath, workspaceRoot)) {
					logBlock(
						`[workflow-guard] blocked apply_patch: patch target escapes workspace: ${patchPath}`,
					);
					return `Blocked: patch targets file '${patchPath}' outside workspace root (${workspaceRoot}).`;
				}
			}
		}

		// Workspace boundary check (path traversal guard)
		if (target && isPathOutsideWorkspace(target, workspaceRoot)) {
			logBlock(
				`[workflow-guard] blocked ${toolName}: path escapes workspace: ${target}`,
			);
			return `Blocked: file path '${target}' escapes workspace root (${workspaceRoot}). All changes must stay within the workspace.`;
		}

		// Secret-content scan (Policy 12): common credential material must
		// never be written into the repo. The agent often has access to env
		// vars the user does NOT want committed; block at the write step.
		for (const content of extractEditContent(input)) {
			const secret = secretIn(content);
			if (secret) {
				logBlock(
					`[workflow-guard] blocked ${toolName}: payload contains ${secret}`,
				);
				return (
					`Blocked: payload appears to contain a ${secret}. ` +
					"Secrets must not be committed to the repository. Store them " +
					"in a secret manager or environment file excluded from git, " +
					"and reference them by name instead."
				);
			}
		}

		// Script-laundering guard (P0.5): file payloads that contain
		// destructive commands or tamper instructions are blocked, so an
		// agent cannot smuggle a blocked command into a script file and run
		// it through the shell.
		if (!allowLive) {
			for (const content of extractEditContent(input)) {
				const normalizedContent = normalizeGitCommands(content);
				const what = liveMutationIn(normalizedContent);
				if (what) {
					logBlock(
						`[workflow-guard] blocked ${toolName}: payload contains ${what}`,
					);
					return (
						`Blocked: the file you are writing contains a ${what}. ` +
						"Script files are not a way to smuggle destructive commands " +
						"past the shell guard. Only the user can allow live mutations " +
						"(WORKFLOW_GUARD_ALLOW_LIVE=1)."
					);
				}
			}
			for (const content of extractEditContent(input)) {
				if (isSettingsTamper(content)) {
					logBlock(
						`[workflow-guard] blocked ${toolName}: payload tampers with settings`,
					);
					return PROTECTED_PATH_REASON;
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
				"explicitly allows live changes. Only the user can override " +
				"this, via the WORKFLOW_GUARD_ALLOW_LIVE=1 environment " +
				"variable set before launching the agent."
			);
		}
	}

	if (!SHELL_TOOL_NAMES.has(toolName)) {
		return undefined;
	}

	const commands = extractCommands(input);
	for (const raw of commands) {
		const command = normalize(raw);
		// Rewrite `git [global-opts] <sub>` to `git <sub>` so global flags
		// cannot smuggle a guarded subcommand past the regexes.
		const normalizedCommand = normalizeGitCommands(command);
		const gitInvocation = parseGitInvocation(command);
		const effectiveRoot = gitInvocation?.repoDir ?? workspaceRoot;

		// ── Policy 7: changes only on feature branches ───────────
		if (GIT_WRITE_RE.test(normalizedCommand) && onProtectedBranch(effectiveRoot)) {
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
			return PROTECTED_PATH_REASON;
		}

		// ── Policies 1, 7 & 8: shell file mutations get the same gates as edits ──
		const shellMutationReason = await guardShellMutation(
			command,
			context?.sessionID,
		);
		if (shellMutationReason) {
			logBlock(
				`[workflow-guard] blocked shell mutation: ${command.slice(0, 120)}`,
			);
			return shellMutationReason;
		}

		// ── Policy 4: live-system mutations (env var is the ONLY override) ──
		if (!allowLive) {
			const what = liveMutationIn(normalizedCommand);
			if (what) {
				logBlock(
					`[workflow-guard] blocked ${what}: ${command.slice(0, 120)}`,
				);
				return (
					`Blocked: ${what} targets a live system. Changes must be ` +
					"made in code (IaC, migrations, source) unless the user " +
					"explicitly allows live changes. Only the user can override " +
					"this, via the WORKFLOW_GUARD_ALLOW_LIVE=1 environment " +
					"variable set before launching the agent."
				);
			}
		}

		// ── Policy 2: block git push to main/master ──────────────────
		if (PUSH_TO_MAIN_RE.test(normalizedCommand)) {
			logBlock(
				`[workflow-guard] blocked push to main/master: ${command}`,
			);
			return (
				"Blocked: direct pushes to main/master are not allowed. " +
				"Create a feature branch and open a PR instead."
			);
		}

		// ── Policy 3: PRs must include a changelog ─────────────────────
		if (PR_CREATE_RE.test(normalizedCommand)) {
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

/**
 * Public guard entry point. Audits every decision (block or allow) to a
 * durable JSONL file before returning.
 */
export async function guardToolCall(
	toolName: string,
	input: unknown,
	context?: { sessionID?: string },
): Promise<string | undefined> {
	const reason = await guardToolCallImpl(toolName, input, context);
	logDecision(toolName, input, context, reason);
	return reason;
}

/** Set the workspace root (used by the plugin and tests). */
export function setWorkspaceRoot(root: string): void {
	workspaceRoot = root;
	try {
		workspaceRootReal = realpathSync(root);
	} catch {
		workspaceRootReal = root;
	}
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

		// Post-edit verification: run the verify command after every successful
		// edit/write/patch so test failures surface while the agent can still
		// fix them. Runs in the background — failures are checked when the
		// agent tries to mark the final todo completed (below), not here.
		"tool.execute.after": async (input) => {
			if (!EDIT_TOOL_NAMES.has(input.tool)) return;
			if (verifyInProgress) return;
			const command = detectVerifyCommand(workspaceRoot);
			if (!command) return;
			verifyInProgress = true;
			const result = await runVerify(command, workspaceRoot);
			recordVerifyResult(command, result);
			verifyInProgress = false;
			audit({
				ts: new Date().toISOString(),
				sessionID: (input as { sessionID?: string }).sessionID,
				tool: input.tool,
				decision: result.passed ? "allow" : "block",
				reason: result.passed
					? `verify OK (${command})`
					: `verify FAILED (${command})`,
				input: { verifyOutputTail: result.output.slice(-500) },
			});
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

		// Shell env scrub: sensitive credentials must not leak into agent
		// shells by default. The hook only documents overwrite, so the
		// sensitive entries are emptied; the agent cannot carry live
		// credentials unless the user explicitly allows it elsewhere.
		"shell.env": async (input, output) => {
			try {
				const env = (output as { env?: Record<string, string> }).env;
				if (env && typeof env === "object") {
					for (const key of SENSITIVE_ENV_KEYS) {
						if (key in env) env[key] = "";
					}
					for (const key of Object.keys(env)) {
						if (SENSITIVE_ENV_RE.test(key)) env[key] = "";
					}
				}
			} catch {}
		},

		// Command-channel audit: `command.executed` events (documented) are
		// logged so developers can audit what slash/user commands ran. The
		// guard's enforcement happens in tool.execute.before; this is
		// deliberately informational only (event handlers that throw can
		// destabilize a session).
		event: async ({ event }: { event: { type?: string; properties?: unknown } }) => {
			if (event?.type !== "command.executed") return;
			audit({
				ts: new Date().toISOString(),
				sessionID: (event.properties as { sessionID?: string })?.sessionID,
				tool: "command.executed",
				decision: "allow",
				input: {
					command: (event.properties as { command?: unknown })?.command ?? "(unknown)",
				},
			});
		},
	};
};

// Default export MUST be a V1 PluginModule record.
export default {
	id: "workflow-guard",
	server: WorkflowGuard,
} satisfies PluginModule;
