/**
 * Static policy posture for OpenCode 2.
 *
 * Three enforcement seats exist, and this module feeds the only one a
 * repository cannot lift. `ctx.permission.hook("evaluate")` and
 * `execute.before` run inside the plugin, so removing the plugin removes them.
 * Static policies are configuration the host evaluates itself.
 *
 * Two host shapes exist and they are not interchangeable:
 *
 * - **OpenCode 2.0.x** reads `experimental.policies` as
 *   `{ action, resource, effect }` with `effect` limited to `allow`/`deny`, and
 *   matches `resource` against the composite string `<permission action>:<resource>`
 *   (`opencode.config.policy` in the 2.0.15 binary). A deny there surfaces as
 *   "Blocked by configuration policy".
 * - **Newer hosts** document a top-level `policies` array whose entries use
 *   `action: "tool.use"` with the same composite `resource` string.
 *
 * The invariants are identical in both shapes; only the envelope differs. This
 * module emits the shape the caller asks for and defaults to the qualified
 * 2.0.x shape.
 *
 * The plugin never writes another tool's configuration. The caller prints the
 * block and the operator decides where it lands, because a plugin that can
 * install its own static rails has just moved them back inside the plugin.
 */

/** Static invariants: each one holds for every session, with no runtime input. */
export interface StaticInvariant {
	/** Stable id, used by tests and documentation. */
	id: string;
	/** Host permission action the rule applies to. */
	action: string;
	/** Resources denied for that action, before the `<action>:` prefix. */
	resources: readonly string[];
	/** Why this cannot be left to a runtime hook. */
	reason: string;
}

/**
 * The invariants, in the order they are emitted.
 *
 * Every entry is a denial. A posture that grants access would be a second,
 * weaker policy engine living in a config file, and the plugin already owns
 * that job.
 */
export const STATIC_INVARIANTS: readonly StaticInvariant[] = [
	{
		id: "protected-trunk-push",
		action: "shell",
		resources: [
			// The host matches the whole command string, so `git push * main`
			// covers `git push origin main` and `git push -f origin main`, while
			// the refspec forms need their own entries.
			"git push * main",
			"git push * master",
			"git push * HEAD:main",
			"git push * HEAD:master",
		],
		reason:
			"Pushing to protected trunk must stay blocked even when the plugin is absent or disabled. The runtime git policy already refuses this; the static rule removes the dependency on it. A whole-string glob cannot see a compound command line or an exotic refspec, so this is a floor, not a sandbox: the plugin seat covers the rest.",
	},
	{
		id: "live-control-plane-write",
		action: "edit",
		resources: [
			// No `~/` here. On 2.0.x, `~` and `$HOME` are expanded only for the
			// `permissions` key, not for `experimental.policies`, so a tilde
			// resource would never match an absolute path. A leading `*/` is
			// version-independent and covers every home directory.
			"*/.config/opencode/*",
			"/etc/opencode/*",
			"*/Library/Application Support/opencode/*",
		],
		reason:
			"An agent that can edit the live control plane can rewrite the rules that constrain it, including the plugin list. The tamper policy is a runtime check; this rule is a configuration-level one.",
	},
	{
		id: "secret-material-read",
		action: "read",
		resources: ["*/.ssh/*", "*id_rsa*"],
		reason:
			"Private keys should never enter a model context, regardless of which session or role asks. The secret policy depends on the plugin being loaded.",
	},
	{
		id: "external-directory-widening",
		action: "external_directory",
		resources: ["*"],
		reason:
			"`external_directory` defaults to allow, so a foreign read needs no approval. Denying it statically is what keeps the write boundary a boundary rather than an advisory. This is the strict posture: drop this rule if cross-repository reads are part of normal work.",
	},
	{
		id: "code-mode-surface",
		action: "execute",
		resources: ["*"],
		reason:
			"Code Mode wraps tools behind a single `execute` surface, and its nested calls reach the tool layer on a path this guard does not evaluate. Denying `execute` removes that surface where the host asserts the action. On 2.0.x the host never asserts `execute`, so this rule is inert there and the plugin's read-only pruning plus `execute.before` remain the only coverage.",
	},
];

export type PolicyPostureFormat = "2.0" | "next";

export interface StaticPolicyRule {
	action: string;
	resource: string;
	effect: "deny";
}

export interface PolicyPosture {
	format: PolicyPostureFormat;
	/** Rules with the `<action>:<resource>` composite resource the host matches. */
	rules: StaticPolicyRule[];
	/** Config fragment, ready to print. Never written by the plugin. */
	config: Record<string, unknown>;
	/** Human-readable rationale per invariant, for the printed header. */
	rationale: Array<{ id: string; reason: string }>;
}

/**
 * Compose one rule. The host matches `resource` against `<action>:<resource>`,
 * so the action name is part of the string, not a separate field.
 */
function ruleFor(invariant: StaticInvariant, resource: string): StaticPolicyRule {
	return { action: invariant.action, resource, effect: "deny" };
}

function rulesFor(invariants: readonly StaticInvariant[]): StaticPolicyRule[] {
	return invariants.flatMap((invariant) => invariant.resources.map((resource) => ruleFor(invariant, resource)));
}

/**
 * Envelope a rule list for the target host.
 *
 * `2.0` uses the `permission` action inside `experimental.policies`, because
 * that is what the 2.0.x config schema accepts and what its evaluator compares.
 * `next` uses the documented top-level `policies` array with `tool.use`.
 */
function envelope(
	format: PolicyPostureFormat,
	rules: readonly StaticPolicyRule[],
): Record<string, unknown> {
	if (format === "2.0") {
		return {
			experimental: {
				policies: rules.map((rule) => ({
					action: "permission",
					resource: `${rule.action}:${rule.resource}`,
					effect: rule.effect,
				})),
			},
		};
	}
	return {
		policies: rules.map((rule) => ({
			action: "tool.use",
			resource: `${rule.action}:${rule.resource}`,
			effect: rule.effect,
		})),
	};
}

export function buildPolicyPosture(options?: { format?: PolicyPostureFormat }): PolicyPosture {
	const format = options?.format ?? "2.0";
	const rules = rulesFor(STATIC_INVARIANTS);
	return {
		format,
		rules,
		config: envelope(format, rules),
		rationale: STATIC_INVARIANTS.map((invariant) => ({ id: invariant.id, reason: invariant.reason })),
	};
}

function commentLines(lines: readonly string[]): string {
	return lines
		.flatMap((line) => line.split("\n"))
		.map((line) => (line.trim() ? `// ${line}` : "//"))
		.join("\n");
}

/**
 * Render the posture as JSONC.
 *
 * The header states precedence and residual risk, because the file that
 * carries these rules is also the file an operator will trim. A trimmed rule
 * that was never explained looks like cruft, and cruft gets deleted.
 */
export function renderPolicyPosture(options?: { format?: PolicyPostureFormat }): string {
	const posture = buildPolicyPosture(options);
	const header = commentLines([
		"Workflow Guard static policy posture. Generated, never installed automatically.",
		"",
		`Target: OpenCode ${posture.format === "2.0" ? "2.0.x (experimental.policies, action \"permission\")" : "newer (top-level policies, action \"tool.use\")"}.`,
		"",
		"Precedence, highest first: managed preferences and Console policies, then /etc/opencode,",
		"then ~/.config/opencode, then project opencode.json(c). Later rules win within one",
		"ruleset, so keep these denies after any broad allow you add.",
		"",
		"Residual risk: policies are configuration. They do not sandbox plugin code, and any",
		"process that can write the file that carries them can remove them. Place this block",
		"in the system or global config, not in a project file.",
		"",
		"Every rule below is a deny. Nothing here grants access; runtime decisions stay with",
		"the plugin's permission-evaluate and execute-before seats.",
		"",
		...posture.rationale.flatMap(({ id, reason }) => [`${id}: ${reason}`, ""]),
	]);
	return `${header}\n${JSON.stringify(posture.config, null, 2)}\n`;
}
