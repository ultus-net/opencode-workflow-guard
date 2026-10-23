/**
 * Config writing for `opencode-workflow-guard setup`.
 *
 * Split out of the bin script so the key-selection rules are testable without
 * writing a live config. The bin stays a thin wrapper.
 *
 * Which key the target host reads:
 *
 * - OpenCode 1.x reads the singular `plugin` key.
 * - OpenCode 2.x reads only the plural `plugins` key. The 2.0.10 config schema
 *   drops a singular `plugin` key without an error
 *   (`Schema.decodeUnknownSync(Config.Info)` returns an object with no `plugin`
 *   field), so writing the wrong key produces a config that looks configured
 *   and loads nothing.
 *
 * `--major` states the target explicitly. Without it, the existing config
 * decides: a `plugins` key means 2.x, a `plugin` key means 1.x. A fresh config
 * defaults to 2, because this package's host dependency is pinned to a 2.x
 * release.
 *
 * `tui.json` is the exception. Its schema is singular `plugin` on both majors:
 * OpenCode 2 reads `tui.json` with that key and migrates it into
 * `cli.json.plugins`. Writing `plugins` there on 2.x produces a file the TUI
 * schema ignores, so the TUI plugin silently never loads. Callers pass
 * `key` to pin the TUI array's key independently of the server config.
 *
 * Evidence for that migration, since no TUI schema is vendored here: the
 * installed 2.0.15 binary's cli-config migration step reads
 * `join(config, "tui.json")`, decodes it with a schema whose only plugin field
 * is singular `plugin`, and emits `plugins` into `cli.json`. The unit tests
 * therefore pin the writer's key choice; the host behavior itself is
 * host-version-dependent and is re-checked by `npm run test:install`.
 */

import { existsSync, readFileSync } from "node:fs";
import { applyEdits, modify, parse } from "jsonc-parser";

export const PACKAGE_NAME = "opencode-workflow-guard";

/** Which plugin array key the target OpenCode major reads. */
export function pluginKeyFor(config, explicitMajor) {
	const major = explicitMajor ?? (config.plugins !== undefined ? 2 : config.plugin !== undefined ? 1 : 2);
	return major === 1 ? "plugin" : "plugins";
}

export function matchesPackageSpec(entry, spec) {
	const value = Array.isArray(entry) ? entry[0] : entry;
	return typeof value === "string" && (value === spec || value.startsWith(`${spec}@`));
}

/**
 * Prepare an updated config document adding `spec` to the target's plugin
 * array, removing a `legacySpec` entry when one is supplied.
 *
 * Returns `undefined` when the document already names the package, so an
 * unchanged config is never rewritten. Throws on an unparseable document or a
 * non-array plugin key rather than clobbering a config it does not understand.
 */
export function preparePluginUpdate(path, schema, spec, legacySpec, explicitMajor, key) {
	const source = existsSync(path)
		? readFileSync(path, "utf8")
		: `{
  "$schema": "${schema}"
}\n`;
	const errors = [];
	const config = parse(source, errors, { allowTrailingComma: true, disallowComments: false });
	if (errors.length > 0 || !config || typeof config !== "object" || Array.isArray(config)) {
		throw new Error(`Cannot update invalid config: ${path}`);
	}
	const targetKey = key ?? pluginKeyFor(config, explicitMajor);
	if (config[targetKey] !== undefined && !Array.isArray(config[targetKey])) {
		throw new Error(`Cannot update ${path}: "${targetKey}" must be an array`);
	}
	const plugins = config[targetKey] ?? [];
	const hasSpec = plugins.some((entry) => matchesPackageSpec(entry, PACKAGE_NAME));
	const updatedPlugins = legacySpec
		? plugins.filter((entry) => !matchesPackageSpec(entry, legacySpec))
		: plugins;
	if (updatedPlugins.length !== plugins.length) {
		if (!hasSpec) updatedPlugins.push(spec);
		return applyEdits(source, modify(source, [targetKey], updatedPlugins, {
			formattingOptions: { insertSpaces: true, tabSize: 2 },
		}));
	}
	if (hasSpec) return undefined;
	return applyEdits(source, modify(source, [targetKey, plugins.length], spec, {
		formattingOptions: { insertSpaces: true, tabSize: 2 },
	}));
}
