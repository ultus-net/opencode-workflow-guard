#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, modify, applyEdits } from "jsonc-parser";

const SERVER_SPEC = "opencode-workflow-guard";
const TUI_SPEC = "opencode-workflow-guard";
const LEGACY_TUI_SPEC = "opencode-workflow-guard/tui";

function configHome() {
	return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

function existingConfig(base, name) {
	const json = join(base, name + ".json");
	const jsonc = join(base, name + ".jsonc");
	return existsSync(json) ? json : existsSync(jsonc) ? jsonc : json;
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
	const matches = (entry, target) => entry === target || (Array.isArray(entry) && entry[0] === target);
	if (!legacySpec) {
		if (plugins.some((entry) => matches(entry, spec))) return undefined;
		return applyEdits(source, modify(source, ["plugin", plugins.length], spec, {
			formattingOptions: { insertSpaces: true, tabSize: 2 },
		}));
	}
	const updatedPlugins = plugins.filter((entry) => !matches(entry, legacySpec));
	if (!updatedPlugins.some((entry) => matches(entry, spec))) updatedPlugins.push(spec);
	if (updatedPlugins.length === plugins.length && updatedPlugins.every((entry, index) => entry === plugins[index])) return undefined;
	return applyEdits(source, modify(source, ["plugin"], updatedPlugins, {
		formattingOptions: { insertSpaces: true, tabSize: 2 },
	}));
}

if (process.argv[2] !== "setup" || process.argv.length > 3) {
	console.error("Usage: opencode-workflow-guard setup");
	process.exitCode = 1;
} else {
	try {
		const base = join(configHome(), "opencode");
		const serverPath = existingConfig(base, "opencode");
		const tuiPath = existingConfig(base, "tui");
		const serverUpdate = preparePluginUpdate(serverPath, "https://opencode.ai/config.json", SERVER_SPEC);
		const tuiUpdate = preparePluginUpdate(tuiPath, "https://opencode.ai/tui.json", TUI_SPEC, LEGACY_TUI_SPEC);
		mkdirSync(base, { recursive: true });
		if (serverUpdate !== undefined) writeFileSync(serverPath, serverUpdate);
		if (tuiUpdate !== undefined) writeFileSync(tuiPath, tuiUpdate);
		console.log(`Workflow Guard configured in ${serverPath} and ${tuiPath}.`);
		console.log("Restart OpenCode to load both plugins.");
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
