#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { preparePluginUpdate, PACKAGE_NAME } from "../src/lib/config-writer.mjs";

const PACKAGE_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const SERVER_SPEC = `${PACKAGE_NAME}@${PACKAGE_VERSION}`;
const TUI_SPEC = SERVER_SPEC;
const LEGACY_TUI_SPEC = "opencode-workflow-guard/tui";

const USAGE = `Usage:
  opencode-workflow-guard setup [--major 1|2]
  opencode-workflow-guard policies --print [--format 2.0|next]

setup writes \`plugins\` for OpenCode 2 (the default) and \`plugin\` for OpenCode 1.
An existing config's key wins unless --major is passed.`;

function configHome() {
	return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

function existingConfig(base, name) {
	const json = join(base, name + ".json");
	const jsonc = join(base, name + ".jsonc");
	if (existsSync(json) && existsSync(jsonc)) throw new Error(`Cannot choose between both ${json} and ${jsonc}; remove the unused config first.`);
	return existsSync(json) ? json : existsSync(jsonc) ? jsonc : json;
}

function restoreConfig(path, previous) {
	if (previous === undefined) rmSync(path, { force: true });
	else writeFileSync(path, previous);
}

/**
 * Static policy posture. Prints to stdout only.
 *
 * A plugin that writes another tool's configuration has moved the static rails
 * back inside the thing they are meant to outlive. So: emit, never install.
 */
async function runPolicies() {
	const args = process.argv.slice(3);
	let print = false;
	let format = "2.0";
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--print") print = true;
		else if (arg === "--format") {
			format = args[++i];
			if (format !== "2.0" && format !== "next") throw new Error(`Unknown --format '${format}'. Use 2.0 or next.`);
		} else if (arg.startsWith("--format=")) {
			format = arg.slice("--format=".length);
			if (format !== "2.0" && format !== "next") throw new Error(`Unknown --format '${format}'. Use 2.0 or next.`);
		} else throw new Error(`Unknown argument '${arg}'.`);
	}
	if (!print) throw new Error("Refusing to write config. Pass --print and place the block yourself.");
	const { renderPolicyPosture } = await import(new URL("../src/lib/policy-posture.ts", import.meta.url).href);
	process.stdout.write(renderPolicyPosture({ format }));
}

if (process.argv[2] === "policies") {
	try {
		await runPolicies();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		console.error(USAGE);
		process.exitCode = 1;
	}
} else if (process.argv[2] !== "setup") {
	console.error(USAGE);
	process.exitCode = 1;
} else {
	try {
		const args = process.argv.slice(3);
		let explicitMajor;
		for (let i = 0; i < args.length; i++) {
			const arg = args[i];
			const raw = arg === "--major" ? args[++i] : arg.startsWith("--major=") ? arg.slice("--major=".length) : undefined;
			if (raw === undefined) throw new Error(`Unknown argument '${arg}'.`);
			if (raw !== "1" && raw !== "2") throw new Error(`Unknown --major '${raw}'. Use 1 or 2.`);
			explicitMajor = Number(raw);
		}
		const base = join(configHome(), "opencode");
		const serverPath = existingConfig(base, "opencode");
		const tuiPath = existingConfig(base, "tui");
		const serverUpdate = preparePluginUpdate(serverPath, "https://opencode.ai/config.json", SERVER_SPEC, undefined, explicitMajor);
		// `tui.json` keeps the singular `plugin` key on both majors: OpenCode 2
		// reads that key and migrates it into `cli.json.plugins`.
		const tuiUpdate = preparePluginUpdate(tuiPath, "https://opencode.ai/tui.json", TUI_SPEC, LEGACY_TUI_SPEC, explicitMajor, "plugin");
		const serverBefore = existsSync(serverPath) ? readFileSync(serverPath, "utf8") : undefined;
		const tuiBefore = existsSync(tuiPath) ? readFileSync(tuiPath, "utf8") : undefined;
		mkdirSync(base, { recursive: true });
		try {
			if (serverUpdate !== undefined) writeFileSync(serverPath, serverUpdate);
			if (tuiUpdate !== undefined) writeFileSync(tuiPath, tuiUpdate);
		} catch (error) {
			try {
				restoreConfig(serverPath, serverBefore);
				restoreConfig(tuiPath, tuiBefore);
			} catch (rollbackError) {
				throw new Error(`Setup failed and config rollback also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`, { cause: error });
			}
			throw error;
		}
		console.log(`Workflow Guard configured in ${serverPath} and ${tuiPath}.`);
		console.log("Restart OpenCode to load both plugins.");
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
