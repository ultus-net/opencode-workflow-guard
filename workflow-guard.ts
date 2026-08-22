/**
 * Workflow Guard Plugin for OpenCode (hooks-only - no prompt rules)
 *
 * Deterministic enforcement via the `tool.execute.before` plugin hook
 * (https://opencode.ai/docs/plugins/). Throwing from the hook blocks the
 * tool call outright.
 *
 *  1. Task gate: file-editing tools (edit/write/apply_patch) are blocked
 *     until the session's NATIVE todo list (the built-in `todowrite` tool,
 *     https://opencode.ai/docs/tools/#todowrite) has at least one active
 *     item (pending/in_progress). Once every item is completed/cancelled,
 *     edits block again - forcing a fresh breakdown per request. Subagent
 *     sessions (todowrite is denied for them by default) inherit the todo
 *     list of their parent session.
 *  2. Git pushes to main/master (incl. refspecs like HEAD:main or :main)
 *     are hard-blocked.
 *  3. PR creation (gh) requires a changelog - either a CHANGELOG update in
 *     the branch's diff or a "Changelog:" section in the PR body.
 *  4. Live-system guard: destructive commands targeting infrastructure,
 *     databases, or remote APIs are blocked unless the USER overrides with
 *     WORKFLOW_GUARD_ALLOW_LIVE=1 in the environment before launch. There
 *     is deliberately no in-command override - the agent cannot grant it
 *     to itself.
 *  5. MCP mutation guard: GitHub / Azure DevOps MCP tools with mutation
 *     verbs in their names are blocked (read-only verbs pass).
 *  6. Settings tamper guard: the agent cannot edit opencode.json /
 *     permission config / the guard's own plugin files - via shell OR via
 *     the file-editing tools - or run `opencode auth` to weaken its gates.
 *  7. Branch guard: on main/master, file mutations and history-changing
 *     git commands are blocked until a feature branch is created.
 *  8. Workspace boundary guard: file mutations cannot escape the workspace
 *     root - via edit tools, patches, or shell redirection/copy commands.
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
 * ~/.config/opencode/plugins/ - files there are auto-loaded at startup.
 * Requires opencode >= 1.18 (todo endpoint GET /session/:id/todo).
 */

import { spawnSync, spawn } from "node:child_process";
import { mkdirSync, realpathSync, readFileSync, appendFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { tool, type Plugin, type PluginModule } from "@opencode-ai/plugin";

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

function shellWords(command: string): string[] {
	return (command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map((word) =>
		word.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2"),
	);
}

function splitShellSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (const char of command) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			current += char;
			escaped = true;
			continue;
		}
		if (char === "'" || char === '"') {
			if (!quote) quote = char;
			else if (quote === char) quote = undefined;
			current += char;
			continue;
		}
		if (!quote && /[\n|;&]/.test(char)) {
			if (current.trim()) segments.push(current.trim());
			current = "";
			continue;
		}
		current += char;
	}
	if (current.trim()) segments.push(current.trim());
	return segments;
}

/** Remove common command wrappers while preserving the underlying invocation. */
function unwrapShellWords(command: string): string[] {
	const words = shellWords(command.trim());
	let i = 0;
	while (i < words.length) {
		if (words[i] === "command") {
			i++;
			continue;
		}
		if (words[i] === "sudo") {
			i++;
			const valueOptions = new Set(["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-C", "--close-from", "-R", "--chroot", "-D", "--chdir"]);
			while (i < words.length && words[i]!.startsWith("-")) {
				const option = words[i++]!;
				if (valueOptions.has(option) && i < words.length) i++;
			}
			continue;
		}
		if (words[i] === "env") {
			i++;
			const valueOptions = new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]);
			while (i < words.length) {
				const word = words[i]!;
				if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
					i++;
					continue;
				}
				if (!word.startsWith("-")) break;
				i++;
				if (valueOptions.has(word) && i < words.length) i++;
			}
			continue;
		}
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) {
			i++;
			continue;
		}
		break;
	}
	return words.slice(i);
}

function unwrapShellCommand(command: string): string {
	return unwrapShellWords(command).join(" ");
}

// Matches a direct push of main|master: "git push origin main",
// "git push main", "git push origin local:main" (refspec), "git push
// origin :main" (branch deletion), "git push origin +HEAD:master" (forced
// refspec). The right-hand side of a refspec must be exactly main/master -
// feature/main-fix or HEAD:main-backup are fine.
const PUSH_TO_MAIN_RE =
	/\bgit\s+push\b[^|;&]*(?:^|\s)\+?[\w./-]*:(?:main|master)(?![\w./-])|\bgit\s+push\b[^|;&]*(?:\s|\/)(?:main|master)(?![\w./-])/;
const CHANGELOG_SECTION_RE = /^\s*(?:#{1,6}\s*)?changelog\s*(?::|$)/im;

function hasPrCreateInvocation(command: string): boolean {
	return splitShellSegments(command)
		.some((seg) => {
			const trimmed = unwrapShellCommand(seg);
			return (
				/^gh\b[^|;&]*\bpr\s+create\b/.test(trimmed) ||
				/^az\b[^|;&]*\brepos\s+pr\s+create\b/.test(trimmed)
			);
		});
}

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
// usually empty - the gate then falls back to the parent session's list
// (sessions expose parentID) so delegated work stays gated on the
// orchestrator's breakdown.

const ACTIVE_TODO_STATUSES = new Set(["pending", "in_progress"]);

export interface TodoItem {
	content?: unknown;
	status?: unknown;
}

// Minimal structural type for the SDK client (documented endpoints
// GET /session/:id/todo, GET /session/:id, POST /tui/show-toast). Kept structural -
// not the generated SDK types - so the plugin tolerates SDK minor-version drift.
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
 * Todos governing a session: its own list, or - when it has none (typically
 * subagents, which cannot todowrite) - the nearest ancestor session's list.
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

async function effectiveTodoOwnerSessionID(
	sessionID: string | undefined,
): Promise<string | undefined> {
	if (!sessionID) return undefined;
	const seen = new Set<string>();
	let current: string | undefined = sessionID;
	while (current && !seen.has(current)) {
		seen.add(current);
		const todos = await fetchSessionTodos(current);
		if (todos === undefined) return sessionID;
		if (todos.length > 0) return current;
		current = await fetchParentSessionID(current);
	}
	return sessionID;
}

function hasActiveTodo(todos: TodoItem[]): boolean {
	return todos.some((todo) => ACTIVE_TODO_STATUSES.has(String(todo.status ?? "")));
}

/**
 * Validates todo discipline rules:
 *  1. Focus rule: max one task 'in_progress' at a time.
 *  2. Task lifecycle: active tasks cannot silently vanish without being marked
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

	// Rule 2: No silent task deletion while active work remains
	if (existingTodos && existingTodos.length > 0) {
		const activeExisting = existingTodos.filter((t) => {
			const s = String(t.status ?? "");
			return s === "pending" || s === "in_progress";
		});
		if (activeExisting.length > 0) {
			const newContentCounts = new Map<string, number>();
			for (const todo of newTodos) {
				const content = String(todo.content ?? "").trim();
				newContentCounts.set(content, (newContentCounts.get(content) ?? 0) + 1);
			}
			const missing = activeExisting.find((todo) => {
				const content = String(todo.content ?? "").trim();
				const remaining = newContentCounts.get(content) ?? 0;
				if (remaining === 0) return true;
				newContentCounts.set(content, remaining - 1);
				return false;
			});
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
	if (resolved !== root && !resolved.startsWith(normalizedRoot)) {
		return true;
	}
	// Verify symlink resolution against workspaceRootReal
	try {
		const real = realpathSync(resolved);
		const realRoot = workspaceRootReal.endsWith("/") ? workspaceRootReal : workspaceRootReal + "/";
		if (real !== workspaceRootReal && !real.startsWith(realRoot)) {
			return true;
		}
	} catch {
		// Target does not exist yet (e.g. creating new file). Check closest existing ancestor directory.
		let curr = resolved;
		while (curr && curr !== "/" && curr !== ".") {
			const parent = resolve(curr, "..");
			if (parent === curr) break;
			curr = parent;
			try {
				const realParent = realpathSync(curr);
				const realRoot = workspaceRootReal.endsWith("/") ? workspaceRootReal : workspaceRootReal + "/";
				if (realParent !== workspaceRootReal && !realParent.startsWith(realRoot)) {
					return true;
				}
				break;
			} catch {}
		}
	}
	return false;
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
		if (/^\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)$/.test(redirectMatch[1])) {
			return undefined;
		}
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
	const transfer = filesystemTransferInfo(segment);
	if (transfer?.destination) {
		return {
			kind: "command",
			target: transfer.destination,
			what: `copy/move/link to '${transfer.destination}'`,
		};
	}
	// Common single-target filesystem mutations. Flags are tolerated; the
	// final operand is the target for these forms.
	const fsMutationMatch = segment.match(
		/\b(?:touch|mkdir|rm|unlink|rmdir|ln)\b[^|;&]*\s+["']?([^\s;&|"']+)["']?\s*$/,
	);
	if (fsMutationMatch?.[1] && !fsMutationMatch[1].startsWith("-")) {
		return {
			kind: "command",
			target: fsMutationMatch[1],
			what: `filesystem mutation of '${fsMutationMatch[1]}'`,
		};
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

function simpleFilesystemMutations(segment: string): ShellMutation[] {
	const words = shellWords(unwrapShellCommand(segment));
	const command = words[0];
	if (!command || !new Set(["touch", "mkdir", "rm", "unlink", "rmdir"]).has(command)) {
		return [];
	}
	return words
		.slice(1)
		.filter((word) => !word.startsWith("-"))
		.map((target) => ({
			kind: "command" as const,
			target,
			what: `filesystem mutation of '${target}'`,
		}));
}

function filesystemTransferInfo(
	segment: string,
): { sources: string[]; destination?: string } | undefined {
	const words = shellWords(unwrapShellCommand(segment));
	if (!words[0] || !new Set(["cp", "mv", "ln"]).has(words[0])) return undefined;
	const operands: string[] = [];
	let targetDirectory: string | undefined;
	for (let i = 1; i < words.length; i++) {
		const word = words[i]!;
		if (word === "-t" || word === "--target-directory") {
			targetDirectory = words[++i];
			continue;
		}
		if (word.startsWith("--target-directory=")) {
			targetDirectory = word.slice("--target-directory=".length);
			continue;
		}
		if (word.startsWith("-")) continue;
		operands.push(word);
	}
	if (targetDirectory) return { sources: operands, destination: targetDirectory };
	return {
		sources: operands.slice(0, -1),
		destination: operands.at(-1),
	};
}

function secretSourceInFilesystemCommand(segment: string): string | undefined {
	const transfer = filesystemTransferInfo(segment);
	if (!transfer) return undefined;
	for (const source of transfer.sources) {
		if (isSecretPath(source)) return source;
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
	let hasMutation = false;
	for (const segment of command.split(/[\n|;&]+/)) {
		const secretSource = secretSourceInFilesystemCommand(segment);
		if (secretSource) {
			return `Blocked: shell command would copy, move, or link sensitive file '${secretSource}' under a non-secret name.`;
		}
		const simpleMutations = simpleFilesystemMutations(segment);
		const fallbackMutation = shellMutationIn(segment.trim());
		const mutations = simpleMutations.length > 0
			? simpleMutations
			: fallbackMutation
				? [fallbackMutation]
				: [];
		for (const mutation of mutations) {
			hasMutation = true;
			const secret = secretIn(segment);
			if (secret) {
				return `Blocked: shell file mutation payload appears to contain a ${secret}. Secrets must not be written to disk from agent commands.`;
			}
			const target = mutation.target ?? "";
			// git apply/am has no explicit filename target - treat as workspace
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
		}
	}
	if (hasMutation) {
		recordMutation(await effectiveTodoOwnerSessionID(sessionID));
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
const GIT_GLOBAL_BOOLEAN_OPTIONS = new Set([
	"--version",
	"--help",
	"--no-pager",
	"-p",
	"--paginate",
	"--bare",
	"--literal-pathspecs",
	"--glob-pathspecs",
	"--noglob-pathspecs",
	"--icase-pathspecs",
	"--no-optional-locks",
	"--exec-path",
]);

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
	const tokens = unwrapShellWords(command);
	if (tokens[0] !== "git") return undefined;
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
		if (GIT_GLOBAL_BOOLEAN_OPTIONS.has(tok)) {
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
	return splitShellSegments(command)
		.map((segment) => {
			const parsed = parseGitInvocation(segment);
			return parsed ? `git ${parsed.rest}` : segment;
		})
		.join(" ; ");
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
		// Not a repo (or worktree without .git dir) - no gate.
	}
	if (result.status === 0) return ""; // detached HEAD - treat as unprotected
	return undefined;
}

// ── Project-level configuration (.opencode/workflow-guard.json) ───────────────

export interface ProjectConfig {
	protectedBranches?: string[];
	verifyCommand?: string;
	requireReview?: boolean;
	requireDocumentation?: boolean;
}

let cachedProjectConfig: ProjectConfig | undefined;

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

export function isReviewRequired(root: string): boolean {
	if (process.env.WORKFLOW_GUARD_REQUIRE_REVIEW === "1") return true;
	const cfg = cachedProjectConfig ?? loadProjectConfig(root);
	return cfg.requireReview === true;
}

function onProtectedBranch(root: string): boolean {
	const branch = currentGitBranch(root);
	if (!branch) return false;
	const cfg = cachedProjectConfig ?? loadProjectConfig(root);
	const customBranches = Array.isArray(cfg.protectedBranches)
		? cfg.protectedBranches
		: [];
	const allProtected = new Set([...PROTECTED_BRANCHES, ...customBranches]);
	return allProtected.has(branch);
}

function branchGuardReason(): string {
	return (
		"Blocked: the workspace is on a protected branch. " +
		"Create a feature branch first - e.g. " +
		"`git switch -c feat/description` - and make all changes there, " +
		"then open a PR. Direct changes on protected branches are not allowed."
	);
}

// ── Merged / Closed PR branch check (GitHub & Azure DevOps) ──────────────────

export function isBranchAlreadyMergedOrClosed(
	root: string,
	branch: string,
): { merged: boolean; reason?: string } {
	if (!branch || PROTECTED_BRANCHES.has(branch)) {
		return { merged: false };
	}

	// 1. Check local / remote git ancestors: is branch already fully merged into main/master?
	for (const base of ["origin/HEAD", "origin/main", "origin/master", "main", "master"]) {
		const check = spawnSync("git", ["merge-base", "--is-ancestor", branch, base], {
			cwd: root,
			encoding: "utf8",
			timeout: 5_000,
		});
		if (check.status === 0) {
			const unmerged = spawnSync("git", ["rev-list", `${base}..${branch}`, "--count"], {
				cwd: root,
				encoding: "utf8",
				timeout: 5_000,
			});
			if (unmerged.status === 0 && unmerged.stdout.trim() === "0") {
				return {
					merged: true,
					reason: `Branch '${branch}' is already merged into '${base}'. Create a fresh feature branch for new changes.`,
				};
			}
		}
	}

	// 2. Check GitHub PR state if gh CLI is present
	try {
		const ghRes = spawnSync(
			"gh",
			["pr", "list", "--head", branch, "--state", "all", "--json", "number,state,title", "--limit", "1"],
			{ cwd: root, encoding: "utf8", timeout: 8_000 },
		);
		if (ghRes.status === 0 && ghRes.stdout.trim()) {
			const prs = JSON.parse(ghRes.stdout.trim());
			if (Array.isArray(prs) && prs.length > 0) {
				const pr = prs[0];
				if (pr && (pr.state === "MERGED" || pr.state === "CLOSED")) {
					return {
						merged: true,
						reason: `Branch '${branch}' is associated with an already ${pr.state.toLowerCase()} GitHub PR (#${pr.number}: ${pr.title ?? ""}). Create a fresh feature branch for new changes.`,
					};
				}
			}
		}
	} catch {}

	// 3. Check Azure DevOps PR state if az CLI is present
	try {
		const azRes = spawnSync(
			"az",
			["repos", "pr", "list", "--source-branch", branch, "--status", "all", "--query", "[0].{id:pullRequestId, status:status, title:title}", "-o", "json"],
			{ cwd: root, encoding: "utf8", timeout: 8_000 },
		);
		if (azRes.status === 0 && azRes.stdout.trim()) {
			const pr = JSON.parse(azRes.stdout.trim());
			if (pr && typeof pr === "object" && (pr.status === "completed" || pr.status === "abandoned")) {
				return {
					merged: true,
					reason: `Branch '${branch}' is associated with an already ${pr.status} Azure DevOps PR (#${pr.id}: ${pr.title ?? ""}). Create a fresh feature branch for new changes.`,
				};
			}
		}
	} catch {}

	return { merged: false };
}

// ── Merge conflict pre-flight check ──────────────────────────────────────────

export function checkMergeConflicts(root: string): {
	hasConflicts: boolean;
	baseBranch?: string;
	reason?: string;
} {
	const candidates = ["origin/HEAD", "origin/main", "origin/master", "main", "master"];
	for (const base of candidates) {
		const mergeBaseRes = spawnSync("git", ["merge-base", "HEAD", base], {
			cwd: root,
			encoding: "utf8",
			timeout: 5_000,
		});
		if (mergeBaseRes.status !== 0 || !mergeBaseRes.stdout.trim()) continue;
		const mergeBase = mergeBaseRes.stdout.trim();

		const treeRes = spawnSync("git", ["merge-tree", mergeBase, "HEAD", base], {
			cwd: root,
			encoding: "utf8",
			timeout: 10_000,
		});
		if (treeRes.status === 0 && treeRes.stdout.includes("<<<<<<<")) {
			return {
				hasConflicts: true,
				baseBranch: base,
				reason: `Branch has merge conflicts with base branch '${base}'. Rebase or merge '${base}' to resolve all conflicts before opening a PR or handing off.`,
			};
		}
	}
	return { hasConflicts: false };
}

// ── Base branch freshness pre-flight check ───────────────────────────────────

const GIT_BRANCH_CREATE_RE =
	/\bgit\s+(?:checkout\s+-b|switch\s+(?:-c|--create))\b/;

export function checkBranchBaseIsUpToDate(root: string): {
	isBehind: boolean;
	count?: number;
	baseRef?: string;
	reason?: string;
} {
	for (const base of ["origin/HEAD", "origin/main", "origin/master"]) {
		const res = spawnSync("git", ["rev-list", `HEAD..${base}`, "--count"], {
			cwd: root,
			encoding: "utf8",
			timeout: 5_000,
		});
		if (res.status === 0 && res.stdout.trim()) {
			const count = parseInt(res.stdout.trim(), 10);
			if (!isNaN(count) && count > 0) {
				return {
					isBehind: true,
					count,
					baseRef: base,
					reason: `Local base branch is ${count} commit(s) behind remote (${base}). Run 'git pull' or 'git fetch' on main before creating a fresh feature branch to prevent upstream conflicts.`,
				};
			}
		}
	}
	return { isBehind: false };
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
	// commands are allowed - they're normal work and reviewable in diffs.
	// Filesystem destruction: block rm -rf on system paths, allow workspace cleanup
	{ re: /\brm\s+(?:-[a-zA-Z]*[rRfF][a-zA-Z]*\s+)*-[a-zA-Z]*[rRfF][a-zA-Z]*\s+(?:\/|~|\*)/, what: "recursive/forced deletion of system/home paths" },
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
	{ re: /\b(?:curl|wget)\b[^;&]*\|\s*(?:bash|sh|zsh)\b/, what: "remote download piped directly to a shell" },
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
// list is intentionally conservative - it aims to catch obvious accidents
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
	{ re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, what: "Slack token (xox family)" },
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
 * or auth state - anything the agent could modify to weaken the guard.
 * Checked against the path resolved from the workspace root.
 */
export function isProtectedPath(targetPath: string): boolean {
	if (!targetPath) return false;
	const resolved = resolve(workspaceRoot, targetPath);
	const matches = (path: string): boolean => {
		const base = basename(path);
		const lower = path.toLowerCase();
		return (
		// opencode.json / opencode.jsonc anywhere (project config)
		/^opencode\.jsonc?$/i.test(base) ||
		// workflow-guard.json / workflow-guard.jsonc anywhere
		/^workflow-guard\.jsonc?$/i.test(base) ||
		// anything under a .opencode directory (project plugins, agents)
		lower.includes(`${"/"}.opencode/`) ||
		// anything under ~/.config/opencode (global config, plugins, ui)
		lower.includes("/.config/opencode/") ||
		lower.includes("/.config/opencode.json")
		);
	};
	if (matches(resolved)) return true;
	try {
		return matches(realpathSync(resolved));
	} catch {
		let ancestor = resolve(resolved, "..");
		while (ancestor !== resolve(ancestor, "..")) {
			try {
				const realAncestor = realpathSync(ancestor);
				return matches(resolve(realAncestor, relative(ancestor, resolved)));
			} catch {
				ancestor = resolve(ancestor, "..");
			}
		}
		return false;
	}
}

// ── Sensitive file READ guard (.env*, keys, credentials, kubeconfig) ─────────
// Reading live secrets into model context leaks credentials. Read-only fixtures
// (.env.example, .env.sample, .env.template) are safe and permitted.

const SAFE_ENV_FIXTURE_RE =
	/\.env\.(example|sample|template|dist|schema)(\.[\w-]+)*$/i;

export function isSecretPath(targetPath: string): boolean {
	if (!targetPath) return false;
	const resolved = resolve(workspaceRoot, targetPath);
	const matches = (path: string): boolean => {
	const base = basename(path).toLowerCase();
	const full = path.toLowerCase();

	// Safe fixtures
	if (SAFE_ENV_FIXTURE_RE.test(base)) {
		return false;
	}

	// .env files (e.g. .env, .env.local, .env.prod, .env.secret)
	if (/^\.env(?:\.|$)/i.test(base)) {
		return true;
	}

	// SSH & TLS key material
	if (
		/^(id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.|$)/i.test(base) ||
		/\.(pem|key|pkcs12|pfx|p12)$/i.test(base)
	) {
		return true;
	}

	// Cloud / cluster / service account credentials
	if (
		/kubeconfig/i.test(base) ||
		full.includes("/.kube/config") ||
		/^(service[-_]?account|client[-_]?secret).*\.json$/i.test(base) ||
		/credentials\.json$/i.test(base) ||
		full.includes("/.aws/credentials") ||
		full.includes("/.docker/config.json") ||
		base === ".netrc" ||
		base === ".git-credentials"
	) {
		return true;
	}

	return false;
	};
	if (matches(resolved)) return true;
	try {
		return matches(realpathSync(resolved));
	} catch {
		return false;
	}
}

const SECRET_READ_COMMAND_RE =
	/(?:^|\s)(?:cat|head|tail|less|more|grep|awk|sed|od|hexdump|strings|base64|xxd|nl|sort|uniq|view|nano|vim?)\s+[^|;&]*?(?:["']?)([\w\/.~-]*\.(?:pem|key|pfx|p12)|[\w\/.~-]*\.env(?:\.[\w-]+)*|[\w\/.~-]*id_(?:rsa|dsa|ecdsa|ed25519)[\w.-]*|[\w\/.~-]*kubeconfig[\w.-]*|[\w\/.~-]*(?:service[-_]?account|credentials|client[-_]?secret)[\w.-]*\.json)(?:["']?)/i;
const SIMPLE_FILE_READ_COMMAND_RE =
	/(?:^|\s)(?:cat|head|tail|less|more|od|hexdump|strings|base64|xxd|nl|view|nano|vim?)\s+(?:-\S+\s+)*["']?([^\s|;&"']+)/i;

function secretFileReadIn(segment: string): string | undefined {
	const match = segment.match(SECRET_READ_COMMAND_RE);
	if (match?.[1] && isSecretPath(match[1])) {
		return match[1];
	}
	const simpleMatch = segment.match(SIMPLE_FILE_READ_COMMAND_RE);
	if (simpleMatch?.[1] && isSecretPath(simpleMatch[1])) return simpleMatch[1];
	return undefined;
}

// ── Interpreter inline evasion scanner ───────────────────────────────────────
// Extracts inline script payloads (python -c, node -e, perl -e, ruby -e,
// powershell -enc, base64 | sh) so the live-mutation and settings-tamper
// scanners can inspect the actual script content.

export function extractInterpreterPayload(segment: string): string[] {
	const payloads: string[] = [];
	const inlineMatch = segment.match(
		/\b(?:python3?|node|perl|ruby|osascript)\s+(?:-[a-zA-Z]*[ce]\s+)(?:"([^"]*)"|'([^']*)')/i,
	);
	if (inlineMatch?.[1] || inlineMatch?.[2]) {
		payloads.push(inlineMatch[1] ?? inlineMatch[2] ?? "");
	}
	const psMatch = segment.match(
		/\b(?:powershell|pwsh)\s+(?:-[a-zA-Z]*enc[a-zA-Z]*\s+)([A-Za-z0-9+/=]+)/i,
	);
	if (psMatch?.[1]) {
		try {
			const buf = Buffer.from(psMatch[1], "base64");
			payloads.push(buf.toString("utf8"), buf.toString("utf16le"));
		} catch {}
	}
	const b64PipeMatch = segment.match(
		/echo\s+["']?([A-Za-z0-9+/=]{4,})["']?\s*\|\s*base64\s+(?:-[a-zA-Z]*d[a-zA-Z]*|--decode)\s*\|\s*(?:bash|sh|zsh)/i,
	);
	if (b64PipeMatch?.[1]) {
		try {
			const buf = Buffer.from(b64PipeMatch[1], "base64");
			payloads.push(buf.toString("utf8"), buf.toString("utf16le"));
		} catch {}
	}
	return payloads;
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
// is allowed - only modification attempts are blocked.
const SETTINGS_TAMPER_PATTERNS: RegExp[] = [
	// Shell writes to opencode config paths - write verb/redirect required.
	/(?:^|\s)(?:sed\s+-i|tee|mv|cp|rm|chmod|chown|ln|install|truncate|dd)\s+[^|;&]*?(?:[\w\/.~-]*opencode\.jsonc?|[\w\/.~-]*\.config\/opencode|[\w\/.~-]*\.opencode\/)/i,
	/>\s*["']?[\w\/.~-]*(?:opencode\.jsonc?|\.config\/opencode|\.opencode\/)/i,
	// Editing the guard plugin itself or its TUI companion (any file,
	// not just config) - self-protection.
	/(?:^|\s)(?:sed\s+-i|tee|mv|cp|rm|chmod|chown|truncate|dd)\s+[^|;&]*?[\w\/.~-]*\.config\/opencode\/(?:plugins|ui)\//i,
	/>\s*["']?[\w\/.~-]*\.config\/opencode\/(?:plugins|ui)\//i,
	// CLI config/auth commands - matched as command verbs, not bare words.
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

// ── Documentation review & synchronization check (Policy 21) ─────────────────

export function branchHasDocumentationChange(root: string): boolean {
	try {
		const baseCandidates = ["origin/HEAD", "origin/main", "origin/master", "main", "master"];
		for (const base of baseCandidates) {
			const mergeBase = spawnSync("git", ["merge-base", "HEAD", base], {
				cwd: root,
				encoding: "utf8",
				timeout: 5_000,
			});
			if (mergeBase.status !== 0 || !mergeBase.stdout.trim()) continue;
			const diff = spawnSync(
				"git",
				["diff", "--name-only", `${mergeBase.stdout.trim()}...HEAD`],
				{ cwd: root, encoding: "utf8", timeout: 8_000 },
			);
			if (diff.status !== 0) continue;
			const files = diff.stdout.split("\n").filter(Boolean);
			if (
				files.some(
					(f) =>
						/\.md$/i.test(f) ||
						f.startsWith("docs/") ||
						f.toLowerCase() === "readme.md",
				)
			) {
				return true;
			}
		}
		const last = spawnSync("git", ["diff", "--name-only", "HEAD~1"], {
			cwd: root,
			encoding: "utf8",
			timeout: 5_000,
		});
		if (last.status === 0) {
			const files = last.stdout.split("\n").filter(Boolean);
			return files.some(
				(f) =>
					/\.md$/i.test(f) ||
					f.startsWith("docs/") ||
					f.toLowerCase() === "readme.md",
			);
		}
		return false;
	} catch {
		return false;
	}
}

export function isDocumentationRequired(root: string): boolean {
	if (process.env.WORKFLOW_GUARD_REQUIRE_DOCS === "1") return true;
	const cfg = cachedProjectConfig ?? loadProjectConfig(root);
	return cfg.requireDocumentation === true;
}

function prBodyIncludesChangelog(command: string): boolean {
	// Handle inline --body / --description / -d / -b "..." with a Changelog section.
	const bodyMatch = command.match(
		/(?:--body|--description|-d|-b)(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s|;&]+))/,
	);
	const body = bodyMatch?.[1] ?? bodyMatch?.[2] ?? bodyMatch?.[3] ?? "";
	if (CHANGELOG_SECTION_RE.test(body)) {
		return true;
	}
	// Handle --body-file <path> / --description-file <path> / -F <path>: read the referenced file.
	const bodyFileMatch = command.match(
		/(?:--body-file|--description-file|-F)(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s|;&]+))/,
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

// ── Secondary Agent Review Spoke ─────────────────────────────────────────────
// Supports multi-agent accountability and code review quality gates before PR
// or final delivery. Ties into the `code-review-and-quality` and
// `doubt-driven-development` agent skills with a structured evaluation rubric.

let lastReview:
	| {
			passed: boolean;
			reviewer: string;
			summary: string;
			timestamp: number;
			targetSessionID?: string;
			workspace?: string;
	  }
	| undefined;
const sessionReviews = new Map<string, NonNullable<typeof lastReview>>();

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

/**
 * Builds a structured, adversarial review rubric prompt for a secondary review agent
 * or subagent (combining `code-review-and-quality` and `doubt-driven-development`).
 */
export function buildReviewRubric(diffText: string, taskPrompt?: string): string {
	return [
		"# Secondary Review Agent Quality Gate",
		"",
		"Evaluate this code change independently with fresh context across these 5 core axes:",
		"",
		"### 1. Test Integrity & Truthfulness (CRITICAL)",
		"- Are test assertions testing real behavioral outcomes rather than trivial passes (e.g. `expect(true).toBe(true)`)?",
		"- Were existing tests disabled, bypassed, or weakened?",
		"- Are edge cases and error paths covered?",
		"",
		"### 2. Task Completeness & Intent Alignment",
		"- Does the implementation genuinely satisfy the user request without shortcut stubs (`// TODO`, `throw new Error('not implemented')`)?",
		"- Does it introduce regressions in surrounding code?",
		"",
		"### 3. Code Cleanliness & Hygiene",
		"- Is there any orphaned dead code, commented-out code blocks, or temporary debugging logs?",
		"- Is the logic straightforward and free of unnecessary cognitive complexity?",
		"",
		"### 4. Security & Safety Boundaries",
		"- Are there any hardcoded secrets, unprotected tokens, or unvalidated user inputs?",
		"- Does the code respect workspace confinement and safe environment practices?",
		"",
		"### 5. Platform & Architecture Fit (GitHub & Azure DevOps)",
		"- Does the change fit established repository patterns and CI/CD pipelines?",
		"",
		taskPrompt ? `### User Request / Context:\n${taskPrompt}\n` : "",
		"### Code Diff Under Review:",
		"```diff",
		diffText.slice(0, 30_000),
		"```",
		"",
		"Provide your verdict: `[APPROVE]` or `[REQUEST_CHANGES]` with concise, actionable findings.",
	].join("\n");
}

// ── Core guard (exported for testing) ────────────────────────────────────────
// Returns a block reason string, or undefined when the call is allowed.

// ── Post-edit verification gate ─────────────────────────────────────────────
// The guard blocks edits before they happen, and validates verification evidence
// before final completion. When the agent attempts to mark all tasks completed/cancelled,
// the guard ensures fresh verification has passed since the most recent mutation.

let lastMutationTimestamp = 0;
const sessionMutationTimestamps = new Map<string, number>();
let lastVerify: {
	passed: boolean;
	command: string;
	output: string;
	timestamp: number;
	durationMs?: number;
} | undefined;
const sessionVerifyResults = new Map<string, NonNullable<typeof lastVerify>>();

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

export function resetVerifyState(): void {
	lastMutationTimestamp = 0;
	lastVerify = undefined;
	sessionMutationTimestamps.clear();
	sessionVerifyResults.clear();
}

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

export function getCleanEnv(): Record<string, string> {
	const env: Record<string, string> = { ...(process.env as Record<string, string>) };
	for (const key of SENSITIVE_ENV_KEYS) {
		delete env[key];
	}
	for (const key of Object.keys(env)) {
		if (SENSITIVE_ENV_RE.test(key)) {
			delete env[key];
		}
	}
	return env;
}

function detectVerifyCommand(root: string): string | undefined {
	if (process.env.WORKFLOW_GUARD_VERIFY !== undefined) {
		const cmd = process.env.WORKFLOW_GUARD_VERIFY.trim();
		return cmd || undefined; // empty string = "disabled"
	}
	const cfg = cachedProjectConfig ?? loadProjectConfig(root);
	if (typeof cfg.verifyCommand === "string") {
		const cmd = cfg.verifyCommand.trim();
		return cmd || undefined;
	}
	try {
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
			scripts?: Record<string, string>;
		};
		if (pkg.scripts?.test) return "npm test";
	} catch {}
	return undefined;
}

export async function runVerify(
	command: string,
	root: string,
	timeoutMs = 30_000,
): Promise<{ passed: boolean; output: string; durationMs: number }> {
	const start = Date.now();
	const allowLive = process.env.WORKFLOW_GUARD_ALLOW_LIVE === "1";

	// Guard against privileged execution of destructive commands or settings tampering in verify scripts
	if (!allowLive) {
		const normalized = normalizeGitCommands(normalize(command));
		const liveCheck = liveMutationIn(normalized);
		if (liveCheck) {
			return {
				passed: false,
				output: `Verification command blocked: contains live destructive command (${liveCheck})`,
				durationMs: 0,
			};
		}
		if (isSettingsTamper(command)) {
			return {
				passed: false,
				output: "Verification command blocked: contains settings tamper command",
				durationMs: 0,
			};
		}
	}

	return new Promise((resolve) => {
		let output = "";
		let timer: NodeJS.Timeout | undefined;
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, {
				cwd: root,
				shell: true,
				env: getCleanEnv(),
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (err: any) {
			return resolve({
				passed: false,
				output: `(spawn failed: ${err?.message ?? "unknown error"})`,
				durationMs: Date.now() - start,
			});
		}

		timer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {}
			resolve({
				passed: false,
				output: output + `\n(Verification timed out after ${Math.round(timeoutMs / 1000)}s)`,
				durationMs: Date.now() - start,
			});
		}, timeoutMs);

		child.stdout?.on("data", (d) => {
			output += d.toString();
			if (output.length > 50_000) output = output.slice(-50_000);
		});
		child.stderr?.on("data", (d) => {
			output += d.toString();
			if (output.length > 50_000) output = output.slice(-50_000);
		});
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			resolve({ passed: code === 0, output, durationMs: Date.now() - start });
		});
		child.on("error", (err) => {
			if (timer) clearTimeout(timer);
			resolve({ passed: false, output: `(spawn failed: ${err.message})`, durationMs: Date.now() - start });
		});
	});
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

export function getAuditFilePath(): string {
	return AUDIT_FILE;
}

export function getRecentAuditEntries(limit = 10): AuditEntry[] {
	try {
		if (!existsSync(AUDIT_FILE)) return [];
		const lines = readFileSync(AUDIT_FILE, "utf8").trim().split("\n");
		const entries: AuditEntry[] = [];
		for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
			const line = lines[i]?.trim();
			if (line) {
				try {
					entries.push(JSON.parse(line));
				} catch {}
			}
		}
		return entries;
	} catch {
		return [];
	}
}

export interface AuditEntry {
	ts: string;
	sessionID?: string;
	tool: string;
	decision: "allow" | "block";
	reason?: string;
	input?: unknown;
	evidence?: {
		mutation?: boolean;
		targetPath?: string;
		verification?: {
			command: string;
			passed: boolean;
			fresh: boolean;
			durationMs?: number;
		};
		allowLive?: boolean;
	};
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
	evidence?: AuditEntry["evidence"],
): void {
	audit({
		ts: new Date().toISOString(),
		sessionID: context?.sessionID,
		tool,
		decision: reason ? "block" : "allow",
		reason,
		input: summarizeInput(input),
		evidence,
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
	// ── Policy 17: Secret file READ guard (.env*, keys, kubeconfig, credentials) ──
	if (toolName === "read") {
		const record = asRecord(input);
		const target =
			typeof record?.filePath === "string"
				? record.filePath
				: typeof record?.path === "string"
					? record.path
					: typeof input === "string"
						? input
						: "";
		if (target && isSecretPath(target)) {
			logBlock(`[workflow-guard] blocked read: secret file ${target}`);
			return (
				`Blocked: reading sensitive credential/secret file '${target}' is not permitted. ` +
				"Reference environment variables by name or inspect safe templates (e.g. .env.example) instead."
			);
		}
		return undefined;
	}

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
			// done, run verification on-demand if a verify command is configured.
			// This replaces the old background-per-edit approach with a single
			// verification run at finalization time.
			const allDone =
				newTodos.length > 0 &&
				newTodos.every((t) => {
					const s = String(t.status ?? "");
					return s === "completed" || s === "cancelled";
				});
			if (allDone) {
				// Conflict-free mergeability gate before task completion/handoff
				const conflictCheck = checkMergeConflicts(workspaceRoot);
				if (conflictCheck.hasConflicts) {
					const reason = `Blocked todowrite: ${conflictCheck.reason}`;
					logBlock(`[workflow-guard] ${reason}`);
					return reason;
				}

				const command = detectVerifyCommand(workspaceRoot);
				if (command) {
					const sessionID = context?.sessionID;
					const verifyResult = sessionID
						? sessionVerifyResults.get(sessionID)
						: lastVerify;
					const mutationTimestamp = sessionID
						? (sessionMutationTimestamps.get(sessionID) ?? 0)
						: lastMutationTimestamp;
					const isFresh =
						verifyResult !== undefined &&
						verifyResult.passed &&
						verifyResult.command === command &&
						verifyResult.timestamp >= mutationTimestamp;

					if (!isFresh) {
						const result = await runVerify(command, workspaceRoot);
						recordVerifyResult(command, result, sessionID);
						if (!result.passed) {
							const tail = result.output.slice(-500);
							const reason =
								`Blocked todowrite: all tasks marked done but verification is failing ` +
								`(${command}). Fix the failure before finishing; ` +
								`output tail: ${tail}`;
							logBlock(`[workflow-guard] ${reason}`);
							return reason;
						}
					}
				}
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
		if (target && isSecretPath(target) && !allowLive) {
			logBlock(`[workflow-guard] blocked ${toolName}: secret file path ${target}`);
			return (
				`Blocked: modifying secret file '${target}' directly is not permitted. ` +
				"Store credentials in environment variables or safe secret stores instead."
			);
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
				if (isSecretPath(patchPath) && !allowLive) {
					logBlock(
						`[workflow-guard] blocked apply_patch: secret file path ${patchPath}`,
					);
					return `Blocked: modifying secret file '${patchPath}' directly is not permitted.`;
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
		// it through the shell. We scan line-by-line and skip comment lines
		// to reduce false positives on documentation.
		if (!allowLive) {
			for (const content of extractEditContent(input)) {
				const lines = content.split("\n");
				for (const line of lines) {
					// Skip comment lines (bash, js, python, etc.)
					const trimmed = line.trim();
					if (trimmed.startsWith("#") || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
						continue;
					}
					const normalizedContent = normalizeGitCommands(line);
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
		recordMutation(await effectiveTodoOwnerSessionID(context?.sessionID));
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
				`Blocked: ${toolName} mutates ${mcpWhat} - a live ` +
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
		const gitInvocations = splitShellSegments(command)
			.map((segment) => parseGitInvocation(segment.trim()))
			.filter((invocation): invocation is GitInvocation => invocation !== undefined);
		const effectiveRoot = gitInvocations[0]?.repoDir ?? workspaceRoot;

		// Workspace boundary check for external git repo targets
		for (const invocation of gitInvocations) {
			const normalizedInvocation = `git ${invocation.rest}`;
			if (
				isPathOutsideWorkspace(invocation.repoDir, workspaceRoot) &&
				!allowLive &&
				(GIT_WRITE_RE.test(normalizedInvocation) || /\bgit\s+push\b/.test(normalizedInvocation))
			) {
				logBlock(`[workflow-guard] blocked git mutation on repository outside workspace: ${invocation.repoDir}`);
				return `Blocked: git command targets repository '${invocation.repoDir}' outside workspace root (${workspaceRoot}). All changes must stay within the workspace.`;
			}
		}

		// ── Policy 7: changes only on feature branches ───────────
		for (const invocation of gitInvocations) {
			if (GIT_WRITE_RE.test(`git ${invocation.rest}`) && onProtectedBranch(invocation.repoDir)) {
				logBlock(
					`[workflow-guard] blocked git write on protected branch: ${command.slice(0, 120)}`,
				);
				return branchGuardReason();
			}
		}

		// Check if creating a fresh branch while local base is behind remote
		if (GIT_BRANCH_CREATE_RE.test(normalizedCommand)) {
			const behindCheck = checkBranchBaseIsUpToDate(effectiveRoot);
			if (behindCheck.isBehind) {
				logBlock(
					`[workflow-guard] blocked branch creation: base is behind remote ${behindCheck.baseRef}`,
				);
				return `Blocked: ${behindCheck.reason}`;
			}
		}

		// ── Policy 6: block self-modification of approval gates ──
		if (isSettingsTamper(command)) {
			logBlock(
				`[workflow-guard] blocked settings tamper: ${command.slice(0, 120)}`,
			);
			return PROTECTED_PATH_REASON;
		}

		// ── Policy 17: Secret file reads via shell (cat .env, grep id_rsa, etc.) ──
		if (!allowLive) {
			for (const segment of command.split(/[\n|;&]+/)) {
				const secretFile = secretFileReadIn(segment.trim());
				if (secretFile) {
					logBlock(
						`[workflow-guard] blocked shell read of secret file: ${secretFile}`,
					);
					return (
						`Blocked: reading sensitive credential/secret file '${secretFile}' via shell is not permitted. ` +
						"Reference environment variables by name or inspect safe templates (e.g. .env.example) instead."
					);
				}
			}
		}

		// ── Policy 18: Interpreter inline evasion scanner ────────
		if (!allowLive) {
			for (const payload of extractInterpreterPayload(command)) {
				const normPayload = normalizeGitCommands(normalize(payload));
				const liveCheck = liveMutationIn(normPayload);
				if (liveCheck) {
					logBlock(
						`[workflow-guard] blocked interpreter payload containing ${liveCheck}`,
					);
					return `Blocked: inline interpreter script contains a ${liveCheck}. Interpreter payloads cannot smuggle live destructive commands past the guard.`;
				}
				if (isSettingsTamper(payload)) {
					logBlock(
						`[workflow-guard] blocked interpreter payload with settings tamper`,
					);
					return PROTECTED_PATH_REASON;
				}
			}
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
			const what = liveMutationIn(normalizedCommand) ?? liveMutationIn(command);
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
		// ── Policy 20: block push from protected or already-merged branches ──
		for (const invocation of gitInvocations) {
			if (!/\bgit\s+push\b/.test(`git ${invocation.rest}`)) continue;
			if (onProtectedBranch(invocation.repoDir)) {
				logBlock(`[workflow-guard] blocked push from protected branch: ${command}`);
				return branchGuardReason();
			}
			const branch = currentGitBranch(invocation.repoDir);
			if (branch) {
				const mergedStatus = isBranchAlreadyMergedOrClosed(
					invocation.repoDir,
					branch,
				);
				if (mergedStatus.merged) {
					logBlock(
						`[workflow-guard] blocked push to merged/closed branch: ${branch}`,
					);
					return `Blocked: ${mergedStatus.reason}`;
				}
			}
		}

		// ── Policy 3: PRs must include a changelog (GitHub & Azure DevOps) ──
		if (hasPrCreateInvocation(raw)) {
			const isAz = /\baz\s+repos\s+pr\s+create\b/.test(normalizedCommand);
			const prTool = isAz ? "az repos pr create" : "gh pr create";
			const descFlag = isAz ? "--description" : "--body";

			// Policy 19: Conflict-free mergeability gate before opening PR
			const conflictCheck = checkMergeConflicts(workspaceRoot);
			if (conflictCheck.hasConflicts) {
				logBlock(`[workflow-guard] blocked ${prTool}: merge conflicts detected`);
				return `Blocked: ${conflictCheck.reason}`;
			}

			// Policy 20: Check if branch is already merged/closed
			const branch = currentGitBranch(workspaceRoot);
			if (branch) {
				const mergedStatus = isBranchAlreadyMergedOrClosed(
					workspaceRoot,
					branch,
				);
				if (mergedStatus.merged) {
					logBlock(
						`[workflow-guard] blocked ${prTool}: branch already merged/closed`,
					);
					return `Blocked: ${mergedStatus.reason}`;
				}
			}

			if (isReviewRequired(workspaceRoot)) {
				const review = context?.sessionID
					? (sessionReviews.get(context.sessionID) ?? getLastReviewResult())
					: getLastReviewResult();
				const reviewMatchesContext =
					review?.passed === true &&
					(!review.workspace || review.workspace === workspaceRoot) &&
					(!review.targetSessionID || review.targetSessionID === context?.sessionID);
				if (!reviewMatchesContext) {
					logBlock(`[workflow-guard] blocked ${prTool}: review approval required`);
					return (
						`Blocked: PR creation requires a passing review approval. ` +
						"Invoke a secondary review subagent to record an approval using the record_review tool first."
					);
				}
			}

			// Policy 21: Documentation review & update check
			if (isDocumentationRequired(workspaceRoot)) {
				const hasDocChange = branchHasDocumentationChange(workspaceRoot);
				if (!hasDocChange) {
					logBlock(`[workflow-guard] blocked ${prTool}: documentation update required`);
					return (
						`Blocked: PR requires documentation updates (Policy 21). ` +
						"Update README.md or relevant documentation in docs/ before opening a PR."
					);
				}
			}

			const branchChangelog = branchHasChangelogChange(workspaceRoot);
			const prSegments = splitShellSegments(raw)
				.filter((segment) => hasPrCreateInvocation(segment));
			const hasChangelog =
				branchChangelog ||
				prSegments.every((segment) => prBodyIncludesChangelog(segment));
			if (!hasChangelog) {
				const isAz = /\baz\s+repos\s+pr\s+create\b/.test(normalizedCommand);
				const prTool = isAz ? "az repos pr create" : "gh pr create";
				const descFlag = isAz ? "--description" : "--body";
				logBlock(
					`[workflow-guard] blocked ${prTool}: no changelog found`,
				);
				return (
					`Blocked: PR must include a changelog. Either update a ` +
					`CHANGELOG file in this branch's diff, or include a ` +
					`'Changelog:' section in the PR description (${descFlag}).`
				);
			}
		}

		const hasGitMutation = gitInvocations.some((invocation) => {
			const normalizedInvocation = `git ${invocation.rest}`;
			return (
				GIT_WRITE_RE.test(normalizedInvocation) ||
				/\bgit\s+(?:switch|checkout)\b/.test(normalizedInvocation)
			);
		});
		if (hasGitMutation) {
			recordMutation(await effectiveTodoOwnerSessionID(context?.sessionID));
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
	const allowLive = process.env.WORKFLOW_GUARD_ALLOW_LIVE === "1";
	const isMutation = EDIT_TOOL_NAMES.has(toolName);
	const record = asRecord(input);
	const targetPath =
		typeof record?.filePath === "string"
			? record.filePath
			: typeof record?.path === "string"
				? record.path
				: undefined;
	logDecision(toolName, input, context, reason, {
		mutation: isMutation,
		targetPath,
		allowLive,
		verification: lastVerify
			? {
					command: lastVerify.command,
					passed: lastVerify.passed,
					fresh: lastVerify.timestamp >= lastMutationTimestamp,
					durationMs: lastVerify.durationMs,
				}
			: undefined,
	});
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

async function showBlockToast(message: string): Promise<void> {
	try {
		await sdkClient?.tui?.showToast?.({
			body: {
				title: "Workflow Guard Blocked",
				message: message.slice(0, 180),
				variant: "warning",
			},
		});
	} catch {}
}

export const WorkflowGuard: Plugin = async (ctx) => {
	// Honor worktree if present (e.g. opencode worktrees or devcontainers)
	// so worktree plugins cannot punch through boundary gates.
	const effectiveRoot = ctx.worktree || ctx.directory || process.cwd();
	setWorkspaceRoot(effectiveRoot);
	setSdkClient(ctx.client);
	reloadProjectConfig(effectiveRoot);

	try {
		await (ctx.client as any)?.app?.log?.({
			body: {
				service: "workflow-guard",
				level: "info",
				message: `Workflow Guard plugin initialized for ${effectiveRoot}`,
			},
		});
	} catch {}

	return {
		// Custom inspection and review tools registered in OpenCode
		tool: {
			guard_status: tool({
				description:
					"Inspect active guardrails, current branch protection, and verification/review status.",
				args: {},
				execute: async () => {
					const branch = currentGitBranch(workspaceRoot) ?? "unknown";
					const isProtected = onProtectedBranch(workspaceRoot);
					const lastV = getLastVerifyResult();
					const lastR = getLastReviewResult();
					const lastMut = getLastMutationTimestamp();
					const cfg = loadProjectConfig(workspaceRoot);
					return JSON.stringify(
						{
							workspaceRoot,
							branch,
							onProtectedBranch: isProtected,
							lastMutationTimestamp: lastMut,
							lastVerify: lastV
								? {
										command: lastV.command,
										passed: lastV.passed,
										fresh: lastV.timestamp >= lastMut,
									}
								: null,
							lastReview: lastR
								? {
										reviewer: lastR.reviewer,
										passed: lastR.passed,
										summary: lastR.summary,
									}
								: null,
							projectConfig: {
								protectedBranches: cfg.protectedBranches ?? ["main", "master"],
								verifyCommand: detectVerifyCommand(workspaceRoot) ?? null,
								requireReview: isReviewRequired(workspaceRoot),
								requireDocumentation: isDocumentationRequired(workspaceRoot),
							},
						},
						null,
						2,
					);
				},
			}),
			guard_audit: tool({
				description:
					"View recent audit entries recorded by opencode-workflow-guard.",
				args: {
					limit: tool.schema
						.number()
						.optional()
						.describe("Maximum entries to return (default 10)"),
				},
				execute: async (args) => {
					const limit =
						typeof args?.limit === "number" ? Math.min(args.limit, 50) : 10;
					return JSON.stringify(getRecentAuditEntries(limit), null, 2);
				},
			}),
			guard_why: tool({
				description:
					"Simulate and explain whether a specific tool call or command would be blocked by guardrails.",
				args: {
					tool: tool.schema
						.string()
						.describe("Tool name (e.g. bash, edit, write, read, apply_patch)"),
					input: tool.schema
						.record(tool.schema.string(), tool.schema.any())
						.optional()
						.describe("Tool input arguments"),
				},
				execute: async (args) => {
					const reason = await guardToolCallImpl(args.tool, args.input ?? {});
					return reason
						? `BLOCKED: ${reason}`
						: "ALLOWED: Satisfies all current guardrails.";
				},
			}),
			record_review: tool({
				description:
					"Record a secondary reviewer agent's approval or critique of the current changes.",
				args: {
					reviewer: tool.schema
						.string()
						.describe("Identifier/name of the reviewer subagent"),
					summary: tool.schema
						.string()
						.describe("Review findings summary across the 5 core review axes"),
					passed: tool.schema
						.boolean()
						.describe("True if change is approved, false if changes requested"),
				},
				execute: async (args, toolContext) => {
					const parentSessionID = await fetchParentSessionID(toolContext.sessionID);
					if (!parentSessionID) {
						return "[workflow-guard] Review rejected: record_review must be called from a secondary/subagent session.";
					}
					recordReviewResult(
						args.reviewer,
						args.summary,
						args.passed,
						parentSessionID,
						toolContext.worktree || toolContext.directory,
					);
					return args.passed
						? `[workflow-guard] Review recorded as APPROVED by ${args.reviewer}.`
						: `[workflow-guard] Review recorded as CHANGES REQUESTED by ${args.reviewer}.`;
				},
			}),
		},

		// OpenCode passes the tool args as the SECOND hook parameter
		// (`output.args` - documented in the tools docs, e.g. apply_patch
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
				await showBlockToast(reason);
				throw new Error(`[workflow-guard] ${reason}`);
			}
		},

		// Post-edit verification: run the verify command when the agent
		// attempts to finalize the todo list (all tasks completed), not on
		// every edit. This avoids running tests on intermediate broken states
		// and reduces performance overhead.
		"tool.execute.after": async (input) => {
			return;
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
		// When a scrubbed variable is present, we log a warning so the agent
		// knows auth failures may be due to scrubbing, not their code.
		"shell.env": async (input, output) => {
			try {
				const env = (output as { env?: Record<string, string> }).env;
				if (env && typeof env === "object") {
					const scrubbed: string[] = [];
					for (const key of SENSITIVE_ENV_KEYS) {
						if (key in env && env[key] !== "") {
							env[key] = "";
							scrubbed.push(key);
						}
					}
					for (const key of Object.keys(env)) {
						if (SENSITIVE_ENV_RE.test(key) && env[key] !== "") {
							env[key] = "";
							scrubbed.push(key);
						}
					}
					if (scrubbed.length > 0) {
						try {
							await (sdkClient as any)?.app?.log?.({
								body: {
									service: "workflow-guard",
									level: "warn",
									message: `Scrubbed sensitive env vars: ${scrubbed.join(", ")}. Auth failures may be due to this.`,
								},
							});
						} catch {}
					}
				}
			} catch {}
		},

		// Command & permission event audit trail: journal user commands,
		// permission requests, and session creations.
		event: async ({
			event,
		}: { event: { type?: string; properties?: unknown } }) => {
			if (
				event?.type === "command.executed" ||
				event?.type === "permission.updated" ||
				event?.type === "permission.replied" ||
				event?.type === "session.created"
			) {
				audit({
					ts: new Date().toISOString(),
					sessionID: (event.properties as { sessionID?: string })?.sessionID,
					tool: event.type ?? "event",
					decision: "allow",
					input: summarizeInput(event.properties),
				});
			}
		},
	};
};

// Default export MUST be a V1 PluginModule record.
export default {
	id: "workflow-guard",
	server: WorkflowGuard,
} satisfies PluginModule;
