import { basename } from "node:path";
import { splitShellSegments, unwrapShellWords } from "../lib/shell.ts";

/**
 * Agent-delegation boundary.
 *
 * A shell-spawned agent CLI runs outside this session's hooks: its edits,
 * pushes, verification runs, and live-system calls never reach the guard. The
 * host's `task` tool is the governed path to a subagent, because the guard hooks
 * `execute.before` there and enforces role confinement, todo inheritance, and
 * the mutation budget. This policy refuses the shell path, not delegation.
 *
 * Detection is command-position only. `grep claude CHANGELOG.md` and prose that
 * quotes a launcher stay allowed. Wrappers (`env`, `sudo`, `timeout`,
 * `command`), a chained segment, a grouping subshell, and an inline interpreter
 * payload are unwrapped first.
 */

export const DELEGATION_REASON =
	"Blocked: spawning another AI agent CLI from a shell is not allowed. " +
	"The spawned agent runs outside this session's workflow guard, so its file " +
	"mutations, git history changes, and live-system calls are not checked by " +
	"the policies above it. Delegate through the host's task tool so the " +
	"guard's hooks still apply, or ask the user to run the delegated agent.";

// Package and executable names for the agent CLIs an agent must not spawn.
// The value is the name reported in the block reason.
const AGENT_CLI_BASENAMES = new Map<string, string>([
	["claude", "claude"],
	["claude-code", "claude"],
	["codex", "codex"],
	["gemini", "gemini"],
	["gemini-cli", "gemini"],
	["aider", "aider"],
	["aider-chat", "aider"],
]);

// Node package runners that install and execute an agent CLI in one step.
// `npx claude-code` delegates exactly like `claude` does.
const NODE_RUNNERS = new Set(["npx", "bunx", "pnpx"]);

function executableName(word: string): string {
	return basename(word).toLowerCase();
}

function packageName(word: string): string {
	// `claude-code@latest` and `@scope/pkg` both reduce to the package name.
	return executableName(word.replace(/@[^/]*$/, ""));
}

function npxAgentIn(words: readonly string[]): string | undefined {
	let i = 1;
	while (i < words.length) {
		const word = words[i]!;
		if (word === "-p" || word === "--package") {
			const named = AGENT_CLI_BASENAMES.get(packageName(words[i + 1] ?? ""));
			if (named) return named;
			i += 2;
			continue;
		}
		if (word.startsWith("-")) {
			i += 1;
			continue;
		}
		return AGENT_CLI_BASENAMES.get(packageName(word));
	}
	return undefined;
}

function agentCliIn(words: readonly string[]): string | undefined {
	if (words.length === 0) return undefined;
	const executable = executableName(words[0]!);
	const direct = AGENT_CLI_BASENAMES.get(executable);
	if (direct) return direct;
	// `opencode run` is a delegated agent turn. Its other verbs are read-only
	// or covered by the settings-tamper policy, so they are not this policy.
	if (executable === "opencode") {
		return words.slice(1).some((word) => word === "run") ? "opencode run" : undefined;
	}
	if (NODE_RUNNERS.has(executable)) return npxAgentIn(words);
	return undefined;
}

export function delegationSpawnIn(command: string): string | undefined {
	for (const segment of splitShellSegments(command)) {
		const found = agentCliIn(unwrapShellWords(segment));
		if (found) return found;
	}
	return undefined;
}
