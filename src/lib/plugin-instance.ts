/**
 * Process-local plugin instance registry.
 *
 * OpenCode 2 merges plugin arrays instead of replacing them, so naming the same
 * package in both the global and the project config loads the same entrypoint
 * twice under two ids. Two instances register duplicate hooks and duplicate
 * tool definitions: every tool call is evaluated and audited twice, and the two
 * instances can disagree about `effectiveRoot` in the same tick, which primes
 * the process-global workspace latch from two roots.
 *
 * The first instance for a (module path, workspace root) key owns enforcement.
 * A later instance with the same key stays inert and records a warn-level
 * duplicate so the misconfiguration is visible in the audit trail. Different
 * workspace roots are legitimate (concurrent loops share one process) and get
 * independent keys.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { audit } from "./audit.ts";

export interface PluginInstanceInfo {
	/** Stable key: resolved module path plus resolved workspace root. */
	key: string;
	modulePath: string;
	workspaceRoot: string;
	/** True when this key already had an active instance in this process. */
	duplicate: boolean;
}

interface ActiveInstance {
	modulePath: string;
	workspaceRoot: string;
	registrations: number;
}

// Deliberately process-global, not module-global: OpenCode can load the same
// package twice from two distinct paths (a cache copy plus a source checkout),
// and each copy evaluates this module separately. A `Symbol.for` slot on
// `globalThis` gives both copies one registry so the duplicate stays visible
// even when the module instances differ.
const INSTANCE_REGISTRY = Symbol.for("opencode-workflow-guard.plugin-instances.v1");
const globalRegistry = globalThis as unknown as Record<symbol, Map<string, ActiveInstance> | undefined>;
const activeInstances: Map<string, ActiveInstance> =
	globalRegistry[INSTANCE_REGISTRY] ?? (globalRegistry[INSTANCE_REGISTRY] = new Map());

/** Resolved path of the loaded plugin module; the stable half of the key. */
export function loadedPluginModulePath(moduleUrl: string = import.meta.url): string {
	const lexical = (() => {
		try {
			return fileURLToPath(moduleUrl);
		} catch {
			return moduleUrl;
		}
	})();
	try {
		return realpathSync(lexical);
	} catch {
		return lexical;
	}
}

function canonicalRoot(root: string): string {
	try {
		return realpathSync(resolve(root));
	} catch {
		return resolve(root);
	}
}

export function pluginInstanceKey(modulePath: string, workspaceRoot: string): string {
	return `${canonicalRoot(workspaceRoot)}::${modulePath}`;
}

/**
 * Register one setup call. A duplicate key is journaled at warn level and the
 * caller must stay inert: returning early is what makes the load count one
 * policy decision per tool call instead of two.
 */
export function registerPluginInstance(options: {
	modulePath?: string;
	workspaceRoot: string;
}): PluginInstanceInfo {
	const modulePath = options.modulePath ?? loadedPluginModulePath();
	const workspaceRoot = canonicalRoot(options.workspaceRoot);
	const key = pluginInstanceKey(modulePath, workspaceRoot);
	const existing = activeInstances.get(key);
	if (existing) {
		existing.registrations++;
		audit({
			ts: new Date().toISOString(),
			tool: "plugin.instance",
			decision: "allow",
			phase: "event",
			reason: "duplicate_plugin_load",
			input: { instanceKey: key, modulePath, workspaceRoot, registrations: existing.registrations },
		});
		return { key, modulePath, workspaceRoot, duplicate: true };
	}
	activeInstances.set(key, { modulePath, workspaceRoot, registrations: 1 });
	audit({
		ts: new Date().toISOString(),
		tool: "plugin.instance",
		decision: "allow",
		phase: "event",
		reason: "plugin_loaded",
		input: { instanceKey: key, modulePath, workspaceRoot },
	});
	return { key, modulePath, workspaceRoot, duplicate: false };
}

/** Drop one registration. The key is reusable once every registration is gone. */
export function releasePluginInstance(key: string): void {
	const existing = activeInstances.get(key);
	if (!existing) return;
	existing.registrations--;
	if (existing.registrations <= 0) activeInstances.delete(key);
}

/** Test seam: forget every live instance so fixtures can re-register. */
export function resetPluginInstancesForTesting(): void {
	activeInstances.clear();
}
