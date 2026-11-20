import { spawn } from "node:child_process";
import { basename } from "node:path";
import { shellHasSudoWrapper, splitShellSegments, TRANSPARENT_PREFIX, unwrapShellWords } from "../lib/shell.ts";

// AI agents frequently run dangerous package manager flags (e.g. npm audit fix --force,
// npm install -g, pip install --force-reinstall, agent-driven publish) that introduce
// breaking changes, downgrade packages insecurely, or execute arbitrary code.

const PACKAGE_HYGIENE_PATTERNS: Array<{ regex: RegExp; name: string; advice: string }> = [
	{
		regex: /\bnpm\s+audit\s+fix\s+--force\b/i,
		name: "destructive npm audit fix --force",
		advice: "Run 'npm audit' or update dependencies individually in package.json. '--force' introduces breaking major version downgrades.",
	},
	{
		regex: /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add)\s+-[a-zA-Z]*g\b/i,
		name: "global package installation",
		advice: "Install packages locally as devDependencies (--save-dev) or execute with npx/bunx rather than polluting global machine state.",
	},
	{
		regex: /\bpip\s+install\s+(?:--upgrade\s+)?--force-reinstall\b/i,
		name: "destructive pip force reinstall",
		advice: "Specify exact versions in requirements.txt or pyproject.toml instead of force reinstalling.",
	},
	{
		regex: /\b(?:npm|yarn|pnpm|bun)\s+publish\b/i,
		name: "direct package publish from agent subshell",
		advice: "Package publishing must be managed by automated release workflows or explicit user release commands.",
	},
];

export function checkPackageHygiene(command: string): { isViolating: boolean; name?: string; advice?: string } {
	for (const { regex, name, advice } of PACKAGE_HYGIENE_PATTERNS) {
		if (regex.test(command)) {
			return { isViolating: true, name, advice };
		}
	}
	return { isViolating: false };
}

// AI agents running in non-interactive terminal subshells hang indefinitely when an
// interactive prompt (vim, nano, less, top, sudo, npm init without -y, apt without -y,
// git rebase -i) waits for TTY input. Every one of those names is judged at command
// position, because the same word in an argument is data: `echo top`, a grep pattern
// like `grep -n 'sudo'`, or a printf string must not read as a hang. Process monitors
// and pagers already work that way; the patterns below follow the same rule.

const INTERACTIVE_EDITORS = new Set(["nano", "vi", "vim", "emacs", "pico", "joe", "micro"]);
const EDITOR_ADVICE = "Use the edit, write, or apply_patch tools instead of interactive terminal editors.";
const SUDO_NAME = "sudo with password prompt";
const SUDO_ADVICE = "Avoid sudo in agent sessions; run commands directly or request user execution.";

// Anchored on the command word, so a `git rebase -i` inside a grep pattern stays data.
const INTERACTIVE_VERB_PATTERNS: Array<{ regex: RegExp; name: string; advice: string }> = [
	{
		regex: /^git\s+rebase\s+-[a-zA-Z]*i/i,
		name: "git interactive rebase",
		advice: "Use non-interactive git commands or explicit cherry-pick/merge sequences.",
	},
	{
		regex: /^git\s+add\s+-[a-zA-Z]*p/i,
		name: "git interactive patch",
		advice: "Use git add <file> or git apply rather than interactive patch selection.",
	},
	{
		regex: /^npm\s+init\b(?!\s+(?:-y|--yes|--force))\b/i,
		name: "npm init without non-interactive flag",
		advice: "Add -y or --yes flag: npm init -y",
	},
	{
		regex: /^(?:apt|apt-get)\s+(?:install|remove|purge|upgrade|dist-upgrade)\b(?!\s+(?:-y|--yes|--assume-yes))\b/i,
		name: "apt command without non-interactive flag",
		advice: "Add -y flag to avoid interactive confirmation prompts (e.g. apt-get install -y <pkg>).",
	},
	{
		regex: /^(?:yum|dnf)\s+(?:install|remove|upgrade)\b(?!\s+-y)\b/i,
		name: "yum/dnf command without non-interactive flag",
		advice: "Add -y flag to avoid interactive confirmation prompts (e.g. dnf install -y <pkg>).",
	},
];

const MONITOR_ADVICE = "Use ps aux, uptime, or batch flags (e.g. top -b -n 1) instead of interactive monitors.";
const PAGER_ADVICE = "Use cat, head, or grep with non-interactive pipes instead of interactive pagers.";
// Monitor tokens are only interactive when they are the command of a
// segment: a `top` in an argument (a secret name, a grep pattern, `echo
// top`) is data, not the monitor. Wrappers are stripped first, so `sudo top`
// and `timeout 5 top` are still caught, and `eval top` / `sh -c top` recurse
// like the pager check. `top` in batch mode stays allowed. Indirection that
// this does not model (`watch top`, `xargs top`, `man top`, shell loop bodies
// such as `while true; do top; done`) is a known, documented limitation.
const INTERACTIVE_MONITORS = new Set(["top", "htop", "btop", "atop", "glances"]);
const TOP_BATCH_FLAG_RE = /(?:^|\s)(?:--batch|-[A-Za-z]*b[A-Za-z]*)(?:\s|$)/i;

function containsMonitorCommand(command: string, depth = 0): boolean {
	if (depth >= 16) return false;
	for (const segment of splitShellSegments(command)) {
		const words = unwrapShellWords(segment);
		while (words[0] === "--") words.shift();
		const executable = basename(words[0] ?? "").toLowerCase();
		const candidate = executable === "busybox" ? basename(words[1] ?? "").toLowerCase() : executable;
		if (INTERACTIVE_MONITORS.has(candidate)) {
			// Batch mode is the monitor's own flag, not a wrapper's (e.g. `sudo -b
			// top` backgrounds sudo; it does not put `top` in batch mode).
			const monitorIndex = executable === candidate ? 0 : 1;
			if (candidate === "top" && TOP_BATCH_FLAG_RE.test(words.slice(monitorIndex + 1).join(" "))) continue;
			return true;
		}
		if (executable === "eval" && words.length > 1 && containsMonitorCommand(words.slice(1).join(" "), depth + 1)) return true;
		if (/^(?:ba|z|da|k)?sh$/i.test(executable)) {
			const commandFlag = words.findIndex((word, index) => index > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(word));
			if (commandFlag >= 0 && words[commandFlag + 1] && containsMonitorCommand(words[commandFlag + 1]!, depth + 1)) return true;
		}
	}
	return false;
}

function checkProcessMonitorCommand(command: string): { isInteractive: boolean; name?: string; advice?: string } {
	return containsMonitorCommand(command)
		? { isInteractive: true, name: "interactive process monitor", advice: MONITOR_ADVICE }
		: { isInteractive: false };
}

function containsPagerCommand(command: string, depth = 0): boolean {
	if (depth >= 16) return false;
	for (const segment of splitShellSegments(command)) {
		const words = unwrapShellWords(segment);
		while (words[0] === "--") words.shift();
		const executable = basename(words[0] ?? "");
		if (/^(?:less|more|most)$/i.test(executable)) return true;
		if (executable === "eval" && words.length > 1 && containsPagerCommand(words.slice(1).join(" "), depth + 1)) return true;
		if (executable === "busybox" && /^(?:less|more)$/i.test(words[1] ?? "")) return true;
		if (/^(?:ba|z|da|k)?sh$/i.test(executable)) {
			const commandFlag = words.findIndex((word, index) => index > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(word));
			if (commandFlag >= 0 && words[commandFlag + 1] && containsPagerCommand(words[commandFlag + 1]!, depth + 1)) return true;
		}
	}
	return false;
}

function containsInteractivePattern(command: string, depth = 0): { name: string; advice: string } | undefined {
	if (depth >= 16) return undefined;
	for (const segment of splitShellSegments(command)) {
		// Unwrapping strips `sudo` before the command word, so ask the unwrapper.
		if (shellHasSudoWrapper(segment)) return { name: SUDO_NAME, advice: SUDO_ADVICE };
		const words = unwrapShellWords(segment);
		while (words.length > 0 && (words[0] === "--" || TRANSPARENT_PREFIX.has(words[0]!))) words.shift();
		if (words[0] === "sudo") return { name: SUDO_NAME, advice: SUDO_ADVICE };
		const executable = basename(words[0] ?? "").toLowerCase();
		const busybox = executable === "busybox";
		const candidate = busybox ? basename(words[1] ?? "").toLowerCase() : executable;
		if (INTERACTIVE_EDITORS.has(candidate)) return { name: "interactive text editor", advice: EDITOR_ADVICE };
		const commandText = words.slice(busybox ? 1 : 0).join(" ");
		for (const { regex, name, advice } of INTERACTIVE_VERB_PATTERNS) {
			if (regex.test(commandText)) return { name, advice };
		}
		if (executable === "eval" && words.length > 1) {
			const nested = containsInteractivePattern(words.slice(1).join(" "), depth + 1);
			if (nested) return nested;
		}
		if (/^(?:ba|z|da|k)?sh$/i.test(executable)) {
			const commandFlag = words.findIndex((word, index) => index > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(word));
			if (commandFlag >= 0 && words[commandFlag + 1]) {
				const nested = containsInteractivePattern(words[commandFlag + 1]!, depth + 1);
				if (nested) return nested;
			}
		}
	}
	return undefined;
}

export function checkInteractiveTtyCommand(command: string): { isInteractive: boolean; name?: string; advice?: string } {
	const monitor = checkProcessMonitorCommand(command);
	if (monitor.isInteractive) return monitor;
	if (containsPagerCommand(command)) {
		return { isInteractive: true, name: "terminal pager", advice: PAGER_ADVICE };
	}
	const pattern = containsInteractivePattern(command);
	if (pattern) return { isInteractive: true, ...pattern };
	return { isInteractive: false };
}

/**
 * Escapes strings safely for interpolation into AppleScript string literals.
 * Replaces newlines/CRs with spaces, escapes backslashes first, then double quotes.
 */
export function escapeAppleScriptString(str: string): string {
	return str
		.replace(/[\r\n]+/g, " ")
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"');
}

/**
 * Dispatches a native OS desktop notification (macOS osascript or Linux notify-send)
 * for events that explicitly require the user's attention.
 * Non-blocking, fails gracefully.
 */
export function sendDesktopNotification(title: string, message: string): void {
	if (process.env.WORKFLOW_GUARD_NOTIFY === "0") return;

	try {
		if (process.platform === "darwin") {
			const safeTitle = escapeAppleScriptString(title);
			const safeMsg = escapeAppleScriptString(message.slice(0, 150));
			const child = spawn(
				"osascript",
				["-e", `display notification "${safeMsg}" with title "${safeTitle}"`],
				{ stdio: "ignore", detached: true },
			);
			child.on("error", () => {});
			child.unref();
		} else if (process.platform === "linux") {
			const safeTitle = title.replace(/[\r\n\0]/g, " ");
			const safeMsg = message.slice(0, 150).replace(/[\0]/g, "");
			const child = spawn("notify-send", [safeTitle, safeMsg], {
				stdio: "ignore",
				detached: true,
			});
			child.on("error", () => {});
			child.unref();
		}
	} catch {}
}
