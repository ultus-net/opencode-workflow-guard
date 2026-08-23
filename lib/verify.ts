import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
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
