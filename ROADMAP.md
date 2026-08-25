# Roadmap

Proposed additions are limited to deterministic mechanisms that add coverage beyond the current workflow guard.

## Research Record and Repeat Protocol

This roadmap came from a broad coding-agent ecosystem research pass completed on August 25, 2026. The work was not limited to familiar projects or feature summaries: candidate agents were selected using direct GitHub popularity and recent-activity metadata, OpenRouter weekly rankings were used only as a separate model/ecosystem-adoption signal, and the results were deduplicated against agents already reviewed. The pass covered Gemini CLI, OpenHands, Goose, Aider, Continue, Crush, Qwen Code, and Kilo, while retaining prior research on OpenCode, Codex, Cline, and Roo Code for comparison.

For mechanisms that survived the initial scan, conclusions were checked against primary implementation or documentation sources rather than relying on README claims. Relevant OpenCode behavior was checked against the installed 1.18.21 plugin type surface before proposing integration points. The research distinguished capabilities the current API can support from useful ideas that must remain deferred, and kept only deterministic mechanisms that add coverage rather than duplicating existing workflow-guard policies. A separate review then challenged the resulting claims and corrected two overstatements: OpenCode's `tool.execute.after` does not provide a documented success discriminator, and Aider's remote-interference protection specifically covers the case where local HEAD equals the current `origin/<branch>` tip rather than all previously pushed commits. The source list at the end of this document preserves the evidence used for the proposals.

When this ecosystem-research task is requested again, do a fresh full pass rather than treating this document as a shortcut or merely checking whether these existing proposals still look reasonable. Re-run candidate discovery and popularity/activity checks, inspect current primary sources and implementation for both newly discovered and previously reviewed relevant agents, re-check the installed/current OpenCode API surface, deduplicate only after examining the fresh candidate set, and independently review factual and compatibility claims before updating the roadmap. Existing research is prior context, not a substitute for re-verification. If the user explicitly asks for a narrower delta/update scan, that narrower scope may be used instead.

## Targeted Post-Edit Validation

- Implemented: configured file-scoped validators run after a digest proves a direct edit changed the target, with bounded execution and adversarial path/concurrency coverage. Final whole-project verification remains authoritative.
- Project configuration pairs file patterns with explicit deterministic validator commands rather than inferring language tools or installing them globally.
- Matching validators run through `tool.execute.after` when before/after filesystem digests prove the targeted file changed, providing fast feedback without replacing final verification.
- Timeout, output-limit, credential-scrubbing, failure, path-matching, shell-metacharacter, and concurrent-mutation behavior has regression coverage.

## Concurrent File Claims

- Implemented: lightweight process-local file claims detect two active sessions or subagents editing the same canonical file concurrently.
- Claims reuse workflow-guard process state rather than requiring an external coordination database.
- Direct edit/write/apply_patch claims block conflicting sessions for the tool-call lifetime and are released after the call. Session idle/deletion provides stale-claim cleanup when a call's after hook is missed. Shell writers remain outside this bounded claim mechanism.
- Keep worktree isolation as the preferred mechanism for substantial parallel mutations.

## Stale-Write Protection

- Implemented: successful reads record per-session fingerprints for existing regular files, and direct `edit`/`write` calls fail closed unless the same session observed the current canonical file state.
- Fingerprints combine filesystem identity, size, nanosecond mtime, and SHA-256 content rather than relying on timestamps alone. Canonical paths make symlink aliases converge, while replacement and deletion/recreation invalidate the observation.
- OpenCode's tool lifecycle invokes `tool.execute.after` for completed tool results while failures use the error path, so only successful reads seed observations. Parent/subagent sessions intentionally do not share fingerprints.
- This remains optimistic concurrency rather than an atomic compare-and-write: `apply_patch`, shell writers, and external changes in the interval between the before-hook comparison and OpenCode's write are outside this bounded mechanism. Concurrent File Claims separately protect overlapping direct mutations between guarded sessions.

## Durable Recovery Checkpoints

- Implemented: opt-in root-session recovery checkpoints use private reachable Git objects, preserve untracked/staged state, and refuse restoration when session or workspace interference makes recovery unsafe.
- Checkpoints are created only for genuine root-session user runs; subagents and synthetic continuation messages do not replace the run checkpoint.
- Private reachable Git objects preserve tracked, staged, and untracked state without polluting the user's stash list.
- Restoration is provenance- and interference-sensitive and remains recovery-only; it does not weaken workspace, Git, verification, or review gates.

### Recovery Follow-up

- Implemented: checkpoint restoration preserves the primary restore error and surfaces a secondary compensating-rollback failure in the returned diagnostic. Fault-injection coverage exercises the dual-failure path while the recovery ref remains retained for manual recovery.

## Local Operational Telemetry

- Implemented: audit decisions are durable local JSONL records, and completed after-hook observations carry session/call correlation and execution duration. Raw command and patch bodies are not persisted; they are represented by byte count and SHA-256 fingerprint so repeated inputs can be correlated without retaining credentials or source payloads.
- Implemented: P2/P3 review findings are durable per-project local SQLite follow-ups with explicit open/resolved state and are surfaced to agents during context compaction. Review summaries containing P2/P3 findings are recorded automatically when the secondary review is accepted.
- Add bounded retention/rotation for audit JSONL and recovery checkpoint metadata so long-lived installations do not grow indefinitely.
- Add durable verification-result history, including failed runs, rather than retaining only the latest passing cache entry.
- Evaluate supported tool-result/failure lifecycle signals in future OpenCode APIs so success and failure can be correlated with the existing decision/after-hook records. The current `tool.execute.after` API has no success discriminator, so telemetry deliberately does not label these observations as successes.

## Repeated Tool-Failure Detection

- Evaluate bounded tracking of equivalent tool failures when OpenCode exposes enough supported failure lifecycle data to identify retry loops reliably.
- Prefer deterministic thresholds and actionable recovery feedback over prompt-based advice.
- Avoid treating distinct failures as a loop or preventing legitimate iterative debugging.
- Do not duplicate OpenCode's built-in `doom_loop` permission, which already covers three consecutive identical tool calls; this proposal is only about repeated equivalent failures whose invocations are not identical.

## Dynamic Shell Expansion Hardening

- Implemented: shell execution and configured verification fail closed on quote-aware detection of command/process substitution, IFS-based token construction, ambiguous carriage-return/Unicode whitespace, and malformed quote/escape boundaries that literal command normalization cannot faithfully classify.
- Adversarial coverage includes `$()` and backticks, process substitution, IFS construction, carriage returns, Unicode whitespace, malformed quote/token boundaries, and quoted inert literals.
- Use Claude Code's Bash security parser and regression corpus as a reference for syntax classes, not as a parser to transplant. Prefer deterministic fail-closed handling at hard policy boundaries when expansion would require executing shell semantics to discover the effective command.
- Preserve the current sequential hard-policy checks: an allow decision from a narrower rule must never bypass later destructive-command, secret, tamper, workspace, or Git checks.
- Keep configured verification exit codes literal. Do not import interactive command semantics that reinterpret nonzero statuses for tools such as `grep`, `rg`, `diff`, or `test`.

## Managed Deployment Hardening

- Document an enterprise deployment profile that installs workflow-guard alongside OpenCode's administrator-controlled managed settings (`/etc/opencode/` on Linux, the corresponding managed locations on macOS/Windows).
- Use managed OpenCode settings for controls the host already enforces well, such as permissions and provider policy, while keeping workflow invariants in the plugin rather than creating a second configuration-precedence system.
- Evaluate a startup diagnostic that reports whether the expected guard and managed policy are active. Keep this diagnostic observational unless OpenCode exposes a supported way to establish plugin provenance/trust.
- Treat Codex's `allow_managed_hooks_only` as the reference governance model, not as a capability OpenCode currently has: managed configuration precedence does not itself prove that untrusted project plugins cannot run.

## Deferred: Hard Completion Gate

Claude Code hook collections demonstrate useful `Stop` hooks that refuse completion while compiler or verification failures remain. OpenCode's current V1 plugin API does not expose an equivalent blockable lifecycle hook: `event`/`session.idle` return `Promise<void>`, while `experimental.text.complete` exposes text mutation but no supported decision channel.

- Do not emulate a hard completion gate by depending on undocumented exceptions from `experimental.text.complete` or `session.idle`.
- Continue using the existing all-done todo verification gate and bounded `session.idle` continuation for unfinished owned todos.
- Revisit this proposal when the OpenCode plugin API exposes a supported pre-stop/pre-idle hook with explicit block/continue semantics.
- When available, bind completion to the existing verification evidence and Git/worktree fingerprint rather than creating a second verification state model.
- When available, also consider rejecting completion after an unrecovered tool failure, following Roo Code's current-turn completion invariant. Do not duplicate the existing todo finalization gate.

## Not Planned

- Generic destructive-command and secret-file hooks: existing workflow-guard policies already provide stronger coverage.
- Skill auto-activation, architectural prompt injection, and memory/handoff prompts: these are context-routing mechanisms rather than deterministic safety invariants.
- Generic full-project verification after every edit: this duplicates finalization verification at substantially higher cost.
- Language-specific validator heuristics baked into the plugin: validators should be explicitly configured by the project.

## Sources

Scan selection used direct GitHub repository metadata for coding-agent popularity and recent activity, with OpenRouter's weekly rankings as a separate model/ecosystem-adoption signal rather than an agent leaderboard. On August 25, 2026, the active unreviewed set included Gemini CLI (~106.7k stars), OpenHands (~85.0k), Goose (~53.4k), Continue (~35.6k), Crush (~27.7k), Qwen Code (~27.3k), and Kilo (~27.0k), all pushed within the preceding day; Aider (~48.5k) was retained as an established comparison despite its latest push being May 22, 2026. Previously reviewed OpenCode, Codex, Cline, and Roo Code remained in the deduplication set.

- OpenCode configuration and managed settings (current docs, updated August 25, 2026): https://opencode.ai/docs/config/
- OpenCode permissions, including the built-in `doom_loop` permission: https://opencode.ai/docs/permissions/
- OpenCode plugin lifecycle hooks: https://opencode.ai/docs/plugins/
- Codex lifecycle hooks: https://developers.openai.com/codex/hooks
- Codex managed-hook configuration (`allow_managed_hooks_only`): https://github.com/openai/codex/blob/main/docs/config.md
- Roo Code completion interception (`AttemptCompletionTool`): https://github.com/RooCodeInc/Roo-Code/blob/main/src/core/tools/AttemptCompletionTool.ts
- Cline SDK plugin hooks and hook-policy documentation: https://docs.cline.bot/sdk/plugins
- Cline SDK deterministic ignored-file guard (`beforeTool` returning `skip`): https://github.com/cline/cline/blob/main/sdk/examples/plugins/gitignore-read-files-guard.ts
- Cline SDK checkpoint hooks: https://github.com/cline/cline/blob/main/sdk/packages/core/src/hooks/checkpoint-hooks.ts
- Cline SDK loop detection and mistake tracking: https://github.com/cline/cline/blob/main/sdk/packages/core/src/runtime/safety/loop-detection.ts and https://github.com/cline/cline/blob/main/sdk/packages/core/src/runtime/safety/mistake-tracker.ts
- Qwen Code prior-read enforcement (session read plus filesystem fingerprint freshness): https://github.com/QwenLM/qwen-code/blob/8be07151f69641520e9cf692c8190bf094d25588/packages/core/src/tools/priorReadEnforcement.ts
- Kilo Code optimistic edit concurrency (`writeIfUnchanged` against the bytes read after approval): https://github.com/Kilo-Org/kilocode/blob/193a0b5e77a85c04d6c443e6a41da6d0489e4480/packages/core/src/tool/edit.ts
- Crush read-before-edit freshness enforcement: https://github.com/charmbracelet/crush/blob/5be6a3380a0d57e9342fcd3cf815ee841f648558/internal/agent/tools/edit.go
- Aider provenance- and interference-sensitive undo: https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/commands.py
- Claude Code Bash security parser and adversarial shell syntax handling (reviewed at `6f6f12b37f529488b10e53928dd5508bb93535c7`): https://github.com/tanbiralam/claude-code/blob/6f6f12b37f529488b10e53928dd5508bb93535c7/src/tools/BashTool/bashSecurity.ts
- Claude Code hook permission precedence and command exit semantics (same reviewed revision): https://github.com/tanbiralam/claude-code/blob/6f6f12b37f529488b10e53928dd5508bb93535c7/src/services/tools/toolHooks.ts and https://github.com/tanbiralam/claude-code/blob/6f6f12b37f529488b10e53928dd5508bb93535c7/src/tools/BashTool/commandSemantics.ts
- OpenRouter weekly rankings (usage through August 24, 2026; used as an ecosystem-adoption signal, not an agent-quality ranking): https://openrouter.ai/rankings?view=week
