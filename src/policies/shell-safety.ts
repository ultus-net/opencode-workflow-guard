import { spawn } from "node:child_process";

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
// git rebase -i) waits for TTY input. Process monitors are handled separately in
// checkProcessMonitorCommand because `top` can run in a safe batch mode, while the
// other monitors cannot.

const INTERACTIVE_COMMAND_PATTERNS: Array<{ regex: RegExp; name: string; advice: string }> = [
	{
		regex: /\b(?:nano|vim?|emacs|pico|joe|micro)\b/i,
		name: "interactive text editor",
		advice: "Use the edit, write, or apply_patch tools instead of interactive terminal editors.",
	},
	{
		regex: /\b(?:less|more|most)\b/i,
		name: "terminal pager",
		advice: "Use cat, head, or grep with non-interactive pipes instead of interactive pagers.",
	},
	{
		regex: /\bsudo\b/i,
		name: "sudo with password prompt",
		advice: "Avoid sudo in agent sessions; run commands directly or request user execution.",
	},
	{
		regex: /\bgit\s+rebase\s+-[a-zA-Z]*i/i,
		name: "git interactive rebase",
		advice: "Use non-interactive git commands or explicit cherry-pick/merge sequences.",
	},
	{
		regex: /\bgit\s+add\s+-[a-zA-Z]*p/i,
		name: "git interactive patch",
		advice: "Use git add <file> or git apply rather than interactive patch selection.",
	},
	{
		regex: /\bnpm\s+init\b(?!\s+(?:-y|--yes|--force))\b/i,
		name: "npm init without non-interactive flag",
		advice: "Add -y or --yes flag: npm init -y",
	},
	{
		regex: /\b(?:apt|apt-get)\s+(?:install|remove|purge|upgrade|dist-upgrade)\b(?!\s+(?:-y|--yes|--assume-yes))\b/i,
		name: "apt command without non-interactive flag",
		advice: "Add -y flag to avoid interactive confirmation prompts (e.g. apt-get install -y <pkg>).",
	},
	{
		regex: /\b(?:yum|dnf)\s+(?:install|remove|upgrade)\b(?!\s+-y)\b/i,
		name: "yum/dnf command without non-interactive flag",
		advice: "Add -y flag to avoid interactive confirmation prompts (e.g. dnf install -y <pkg>).",
	},
];

const MONITOR_ADVICE = "Use ps aux, uptime, or batch flags (e.g. top -b -n 1) instead of interactive monitors.";
// Process monitoring tokens are matched on whitespace/segment boundaries so that
// an unrelated word such as `desktop`, a hyphenated filename like `top-level-dir`,
// or a quoted argument like `echo "top"` is not mistaken for the `top` command.
const ALWAYS_INTERACTIVE_MONITOR_RE = /(?:^|[;&|\s])(?:htop|btop|atop|glances)(?:$|[;&|\s])/i;
const TOP_COMMAND_RE = /(?:^|[;&|\s])top(?:$|[;&|\s])/i;
const TOP_BATCH_FLAG_RE = /(?:^|\s)(?:--batch|-[A-Za-z]*b[A-Za-z]*)(?:\s|$)/i;

function checkProcessMonitorCommand(command: string): { isInteractive: boolean; name?: string; advice?: string } {
	for (const segment of command.split(/[;&|\n]+/)) {
		if (ALWAYS_INTERACTIVE_MONITOR_RE.test(segment)) {
			return { isInteractive: true, name: "interactive process monitor", advice: MONITOR_ADVICE };
		}
		if (TOP_COMMAND_RE.test(segment) && !TOP_BATCH_FLAG_RE.test(segment)) {
			return { isInteractive: true, name: "interactive process monitor", advice: MONITOR_ADVICE };
		}
	}
	return { isInteractive: false };
}

export function checkInteractiveTtyCommand(command: string): { isInteractive: boolean; name?: string; advice?: string } {
	const monitor = checkProcessMonitorCommand(command);
	if (monitor.isInteractive) return monitor;
	for (const { regex, name, advice } of INTERACTIVE_COMMAND_PATTERNS) {
		if (regex.test(command)) {
			return { isInteractive: true, name, advice };
		}
	}
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
