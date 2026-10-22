#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse, modify, applyEdits } from "jsonc-parser";

const PACKAGE_NAME = "opencode-workflow-guard";
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const SERVER_SPEC = `${PACKAGE_NAME}@${PACKAGE_VERSION}`;
const TUI_SPEC = SERVER_SPEC;
const LEGACY_TUI_SPEC = "opencode-workflow-guard/tui";

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

function matchesPackageSpec(entry, spec) {
	const value = Array.isArray(entry) ? entry[0] : entry;
	return typeof value === "string" && (value === spec || value.startsWith(`${spec}@`));
}
function preparePluginUpdate(path, schema, spec, legacySpec) {
	const source = existsSync(path) ? readFileSync(path, "utf8") : `{
  "$schema": "${schema}"
}\n`;
	const errors = [];
	const config = parse(source, errors, { allowTrailingComma: true, disallowComments: false });
	if (errors.length > 0 || !config || typeof config !== "object" || Array.isArray(config)) {
		throw new Error(`Cannot update invalid config: ${path}`);
	}
	if (config.plugin !== undefined && !Array.isArray(config.plugin)) {
		throw new Error(`Cannot update ${path}: "plugin" must be an array`);
	}
	const plugins = config.plugin ?? [];
	const hasSpec = plugins.some((entry) => matchesPackageSpec(entry, PACKAGE_NAME));
	const updatedPlugins = legacySpec
		? plugins.filter((entry) => !matchesPackageSpec(entry, legacySpec))
		: plugins;
	if (updatedPlugins.length !== plugins.length) {
		if (!hasSpec) updatedPlugins.push(spec);
		return applyEdits(source, modify(source, ["plugin"], updatedPlugins, {
			formattingOptions: { insertSpaces: true, tabSize: 2 },
		}));
	}
	if (hasSpec) return undefined;
	return applyEdits(source, modify(source, ["plugin", plugins.length], spec, {
		formattingOptions: { insertSpaces: true, tabSize: 2 },
	}));
}

const USAGE = `Usage:
  opencode-workflow-guard setup
  opencode-workflow-guard policies --print [--format 2.0|next]`;

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
} else if (process.argv[2] !== "setup" || process.argv.length > 3) {
	console.error(USAGE);
	process.exitCode = 1;
} else {
	try {
		const base = join(configHome(), "opencode");
		const serverPath = existingConfig(base, "opencode");
		const tuiPath = existingConfig(base, "tui");
		const serverUpdate = preparePluginUpdate(serverPath, "https://opencode.ai/config.json", SERVER_SPEC);
		const tuiUpdate = preparePluginUpdate(tuiPath, "https://opencode.ai/tui.json", TUI_SPEC, LEGACY_TUI_SPEC);
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
