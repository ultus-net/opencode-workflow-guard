/**
 * Workflow Guard Plugin for OpenCode (hooks-only — no prompt rules)
 *
 * Deterministic enforcement via the `tool.execute.before` plugin hook
 * (https://opencode.ai/docs/plugins/). Throwing from the hook blocks the
 * tool call outright.
 *
 *  1. Task list gate: file-editing tools (edit/write/patch) are blocked
 *     until the workspace has a task list (TASKS.md / TODO.md / PLAN.md /
 *     .opencode/plan.md) containing at least one unchecked item ("- [ ]").
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
 *
 * Install: copy this file into <project>/.opencode/plugins/ or
 * ~/.config/opencode/plugins/ — files there are auto-loaded at startup.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";

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

// ── Task-list gate ───────────────────────────────────────────────────────────

// OpenCode file-mutation tools: `edit`, `write`, `patch` (the `edit`
// permission covers all three per the permissions docs).
const EDIT_TOOL_NAMES = new Set(["edit", "write", "patch"]);
const TASK_LIST_FILES = ["TASKS.md", "TODO.md", "PLAN.md", ".opencode/plan.md"];
const UNCHECKED_TASK_RE = /^\s*[-*]\s+\[ \]\s+\S/m;

function findActiveTaskList(root: string): string | undefined {
	for (const name of TASK_LIST_FILES) {
		const path = resolve(root, name);
		try {
			const content = readFileSync(path, "utf8");
			if (UNCHECKED_TASK_RE.test(content)) {
				return name;
			}
		} catch {
			// File missing/unreadable — try the next candidate.
		}
	}
	return undefined;
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

export function guardToolCall(toolName: string, input: unknown): string | undefined {
	// ── Policy 1 & 7: edits require a task list + feature branch ──
	// Exception: creating/updating the task list file itself.
	if (EDIT_TOOL_NAMES.has(toolName)) {
		const record = asRecord(input);
		const target =
			typeof record?.filePath === "string"
				? record.filePath
				: typeof record?.path === "string"
					? record.path
					: typeof input === "string"
						? input
						: "";
		const isTaskListEdit = TASK_LIST_FILES.some((name) =>
			resolve(workspaceRoot, target).endsWith(name),
		);
		if (!isTaskListEdit && onProtectedBranch(workspaceRoot)) {
			console.error(
				`[workflow-guard] blocked ${toolName}: on protected branch ${currentGitBranch(workspaceRoot)}`,
			);
			return branchGuardReason();
		}
		if (!isTaskListEdit && !findActiveTaskList(workspaceRoot)) {
			console.error(
				`[workflow-guard] blocked ${toolName}: no active task list`,
			);
			return (
				"Blocked: no active task list found. First create " +
				"TASKS.md (or TODO.md / PLAN.md / .opencode/plan.md) in the " +
				"workspace root with the request broken down as '- [ ]' " +
				"checkbox items, then work through them top to bottom."
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
			console.error(
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
			console.error(
				`[workflow-guard] blocked git write on protected branch: ${command.slice(0, 120)}`,
			);
			return branchGuardReason();
		}

		// ── Policy 6: block self-modification of approval gates ──
		if (isSettingsTamper(command)) {
			console.error(
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
				console.error(
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
			console.error(
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
				console.error(
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
	// ctx.directory is the directory opencode was started in.
	setWorkspaceRoot(ctx.directory ?? process.cwd());

	return {
		"tool.execute.before": async (input) => {
			const reason = guardToolCall(input.tool, input.args);
			if (reason !== undefined) {
				// Throwing from the hook blocks the tool call (see the
				// ".env protection" example in the opencode plugin docs).
				throw new Error(`[workflow-guard] ${reason}`);
			}
		},
	};
};

export default WorkflowGuard;




