import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getCleanEnv, normalize } from "./utils.ts";
import { getProjectConfig } from "./state.ts";
import { normalizeGitCommands } from "../policies/git.ts";
import { liveMutationIn } from "../policies/destructive.ts";
import { isSettingsTamper } from "../policies/tamper.ts";

export function detectVerifyCommand(root: string): string | undefined {
	if (process.env.WORKFLOW_GUARD_VERIFY !== undefined) {
		const cmd = process.env.WORKFLOW_GUARD_VERIFY.trim();
		return cmd || undefined;
	}
	const cfg = getProjectConfig(root);
	if (typeof cfg.verifyCommand === "string") {
		const cmd = cfg.verifyCommand.trim();
		return cmd || undefined;
	}
	try {
		const pkgPath = join(root, "package.json");
		if (existsSync(pkgPath)) {
			const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
				scripts?: Record<string, string>;
			};
			if (pkg.scripts?.test) return "npm test";
			if (pkg.scripts?.typecheck) return "npm run typecheck";
			if (pkg.scripts?.check) return "npm run check";
			if (pkg.scripts?.build) return "npm run build";
		}
	} catch {}

	if (existsSync(join(root, "Cargo.toml"))) {
		return "cargo test";
	}
	if (existsSync(join(root, "go.mod"))) {
		return "go test ./...";
	}
	if (
		existsSync(join(root, "pytest.ini")) ||
		existsSync(join(root, "pyproject.toml")) ||
		existsSync(join(root, "setup.py"))
	) {
		return "pytest";
	}
	if (existsSync(join(root, "deno.json")) || existsSync(join(root, "deno.jsonc"))) {
		return "deno test";
	}

	return undefined;
}

/**
 * Truncates and snips verification stdout/stderr for token efficiency.
 * When a test suite or compiler passes, verbose log lines are trimmed to a
 * concise summary. When it fails, failure context, error markers, and stack
 * traces are prioritized.
 */
export function snipVerifyOutput(output: string, passed: boolean, maxLines = 40): string {
	if (!output) return "(no output)";
	const lines = output.trim().split("\n");
	if (lines.length <= maxLines) return output.trim();

	if (passed) {
		const head = lines.slice(0, 5).join("\n");
		const tail = lines.slice(-15).join("\n");
		return `${head}\n... [${lines.length - 20} lines omitted - all tests passing] ...\n${tail}`;
	}

	const errorLines: string[] = [];
	for (const line of lines) {
		if (/(?:fail|error|exception|panic|assert|reject|expected|received|err:)/i.test(line)) {
			errorLines.push(line);
		}
	}

	const head = lines.slice(0, 5).join("\n");
	const tail = lines.slice(-20).join("\n");
	const errorSummary = errorLines.slice(-15).join("\n");

	return [
		head,
		`\n--- [Verification Failed: ${lines.length} total lines captured] ---`,
		errorSummary ? `Key Failures:\n${errorSummary}` : "",
		`Output Tail:\n${tail}`,
	]
		.filter(Boolean)
		.join("\n");
}

export function getCurrentGitCommitHash(root: string): string | undefined {
	try {
		const res = spawnSync("git", ["rev-parse", "HEAD"], {
			cwd: root,
			encoding: "utf8",
			timeout: 5_000,
		});
		if (res.status === 0 && res.stdout.trim()) {
			return res.stdout.trim();
		}
	} catch {}
	return undefined;
}

export function getGitStatusSummary(root: string): string | undefined {
	try {
		const res = spawnSync("git", ["status", "--porcelain"], {
			cwd: root,
			encoding: "utf8",
			timeout: 5_000,
		});
		if (res.status === 0) {
			return res.stdout.trim();
		}
	} catch {}
	return undefined;
}

export function getGitWorktreeFingerprint(root: string): string | undefined {
	try {
		// Index listing captures the exact staged/tracked content (blob hashes);
		// a worktree-vs-index diff captures unstaged edits; untracked file
		// contents cover files git does not yet track. Together these bind the
		// fingerprint to file contents regardless of whether HEAD exists, so
		// freshly initialized (commitless) repositories are covered too.
		const staged = spawnSync("git", ["ls-files", "--stage", "-z"], {
			cwd: root,
			encoding: "utf8",
			timeout: 5_000,
		});
		const unstaged = spawnSync("git", ["diff", "--no-ext-diff", "--"], {
			cwd: root,
			encoding: "utf8",
			timeout: 5_000,
		});
		const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
			cwd: root,
			encoding: "utf8",
			timeout: 5_000,
		});
		if (staged.status !== 0 || unstaged.status !== 0 || untracked.status !== 0) return undefined;
		const hash = createHash("sha256").update(staged.stdout).update(unstaged.stdout);
		for (const file of untracked.stdout.split("\0").filter(Boolean).sort()) {
			hash.update("\0" + file + "\0");
			try {
				hash.update(readFileSync(join(root, file)));
			} catch {
				return undefined;
			}
		}
		return hash.digest("hex");
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
