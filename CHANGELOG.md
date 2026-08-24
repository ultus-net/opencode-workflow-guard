# Changelog

## 1.5.0

### Minor Changes

- 9da1ed5: Add durable local project memory with SQLite full-text retrieval, explicit human-readable repository promotion, provenance, supersession, and bounded freshness-aware compaction context.
- 9da1ed5: Add an opt-in Socratic learning prototype with adaptive checkpoints and a local evidence-based learner profile.

### Patch Changes

- 9da1ed5: Clarify todo replacement-list semantics and report all detected PR preflight failures in one actionable block.

## 1.4.1

### Patch Changes

- 717d986: Harden workspace boundary mutator scanning, review fingerprinting, and OpenCode 1.18.21 package entrypoints:

    - Expose native `./server` and `./tui` package entrypoints in `package.json`, removing the ambiguous `./ui` export that npm parsed as GitHub shorthand.
    - Add `dd of=` and `truncate` to recognized workspace file mutations under Policy 8.
    - Scan every destination in multi-redirection commands rather than only the first redirect match.
    - Preserve TTY hang protections for interactive monitors while permitting batch top commands (`top -b -n 1`).
    - Bind secondary review approvals to worktree SHA-256 diff fingerprints covering staged, unstaged, and untracked file content.
    - Clarify command-level guardrails vs OS kernel sandboxing in documentation.

- dc1b33c: Consolidate process-monitor detection into one token-scoped check, make the review
  fingerprint commit-independent (index blob hashes + worktree-vs-index diff + untracked contents), and
  evaluate the boundary fallback lazily only when specific detectors miss.

- Harden shell, Git, secret-file, interpreter, and destructive-command parsing against option and quoting evasions; make CI/release failures propagate instead of reporting false success.
- Keep deterministic OpenCode package/load E2E checks required while making external-provider model probes explicitly opt-in.

## 1.4.0

### Minor Changes

- d9e3d65: Harden shell command parsing with subshell/grouping and multi-wrapper unwrapping, block low-level disk wipes, reverse shell sockets, and recursive root/home permission clobbering, add lockfile synchronization and manifest drift pre-flight checks before PR creation, enforce subagent read-only role confinement (reviewer/planner/advisor), add subagent mutation budget protection, isolate subagent worktree boundaries in tool hooks, add multi-ecosystem compiler/test verification auto-detection, and introduce P0-P3 severity ranking and blocker gates for secondary review.

## 1.3.8

### Patch Changes

- 78571e3: Exclude `GITHUB_TOKEN` and `GH_TOKEN` from `SENSITIVE_ENV_RE` so GitHub CLI (`gh`) and Git subshells preserve authorization and do not prompt for login.

## 1.3.7

### Patch Changes

- b8f9d32: Fix TUI plugin failing to load when installed via npm: move `@opentui/solid` from devDependencies to dependencies so it is installed automatically alongside the package. OpenCode resolves the `./ui` entrypoint's imports from the config directory's `node_modules`, not its own runtime, so the package must declare the dependency itself.

## 1.3.6

### Patch Changes

- 63338ad: Stop stripping GITHUB_TOKEN/GH_TOKEN from shell env to prevent gh CLI login prompts

## 1.3.5

### Patch Changes

- 3584fc9: Add exports map to package.json for seamless plugin + TUI loading

## 1.3.4

### Patch Changes

- 2e0f0be: Streamline README with punchy 4-pillar summary, documentation index table, and clean repository tree.

## 1.3.3

### Patch Changes

- 6e7373f: Fix release workflow git tag push & GitHub Releases generation, and exempt automated changeset release PRs from changelog gate.
- 7c4cfe6: Security hardening and parser fixes:
    - Catch global option flags before subcommands in `SETTINGS_TAMPER_PATTERNS` (`opencode --dir . auth ...`)
    - Target-specific destination extraction in `outsideWritePathInPayload` avoiding false positives on data payloads containing path strings
    - Strip comments and trailing commas in `loadProjectConfig` so `.jsonc` configuration files parse reliably

## 1.3.2

### Patch Changes

- 7c5df68: Harden workspace boundary and secret-read policies against shell evasion patterns:
    - Expand `~`, `~user`, `$HOME`, and fail closed on indeterminate `$VARIABLE` references in boundary targets
    - Support `&>`, `&>>`, `>&`, `>>&`, and attached redirects in shell mutation parsing while filtering fd duplication (`2>&1`, `>&2`)
    - Generic `tee` flag skipping (`-a`, `--append`, `-ai`, `--`) and multi-target boundary validation
    - Enforce external-repository confinement on `GIT_DIR=` and `GIT_WORK_TREE=` environment assignments
    - Scan inline interpreter payloads (`python -c`, `node -e`, `bash -c`, `sh -c`, `zsh -c`) for secret-file reads and out-of-workspace writes
- 591959b: Security hardening and operational optimizations:
    - Sanitize desktop notifications against AppleScript command injection on macOS
    - Redact multiline secret value continuations completely in `.env` schema masking
    - Bounded tail buffering in `getRecentAuditEntries` to prevent memory spikes on long-lived logs
    - Sanitize base reference inputs in `guard_review_rubric`

## 1.3.1

### Patch Changes

- 52e33f0: **GitHub Releases now created on publish.** The Release workflow passes `createGithubReleases: true` to `@changesets/action`, so each merged version PR publishes to npm, pushes the git tag, and opens the matching GitHub Release automatically. Previously npm publishes succeeded (1.2.1, 1.3.0) but tags/Releases were only created locally on the CI runner and never pushed, leaving the GitHub Releases page stale at v1.1.5. Those two versions still need a one-time manual `gh release create` backfill.

## 1.3.0

### Minor Changes

- 56a26be: **Completion claims vs evidence (Policy 24, observability).** A new `experimental.text.complete` hook compares the assistant's final wrap-up text against recorded verification evidence. When the response asserts completion or passing tests but the session's verification is failing, stale (mutations after the verify run), or missing entirely, the mismatch is journaled to the audit trail and logged at warn level. This is observability, not gating — responses are never blocked — but confident wrap-ups can no longer silently contradict the evidence trail.

    **Honest tool descriptions.** A new `tool.definition` hook enriches the `todowrite` tool description with the finalization-gate note (fresh verification evidence required after the last mutation), so the model is not surprised by blocks at completion time. Other tools are untouched and the enrichment is idempotent.

### Patch Changes

- 8fd23c0: **Policy 8 boundary fix.** Removed the `WORKFLOW_GUARD_ALLOW_LIVE` bypass from the external `git -C <repo>` workspace-boundary check. The docs and `guardShellMutation` have always stated the boundary has no allow-live override; the orchestrator's external-git branch was the one inconsistent path, now aligned. Added a regression test asserting external git writes stay blocked under allow-live.

    **Review rubric is now a real flow.** `buildReviewRubric` is no longer a dead export: a new `guard_review_rubric` tool emits the rubric with the current branch diff for the orchestrator to hand to a reviewer subagent, and `record_review` rejects summaries that don't reference the review axes.

    **Docs drift cleanup.** `docs/testing.md` no longer references the removed single-focus rule; `docs/policies.md` names the full hook surface; the stale `## Unreleased` block in CHANGELOG.md (content that shipped in 1.2.0) is removed.

## 1.2.1

### Patch Changes

- 1e49142: **Publish pipeline fix.** Restored the `repository` field in `package.json` (accidentally dropped during a merge-conflict resolution), which npm OIDC trusted publishing requires for sigstore provenance verification. Also added a release-CI step that validates publish-critical package metadata (`repository.url`, `main`, `files`) and runs `npm pack --dry-run` before changesets contacts the registry, so this class of failure fails fast in CI instead of at publish time.

## 1.2.0

### Minor Changes

- **Modular codebase architecture.** Split the ~3.3k-line `src/workflow-guard.ts` monolith into per-policy modules under `src/policies/` and engine services under `src/lib/` (state, utils, audit, verify, review, worktree, types), with `src/workflow-guard.ts` as the orchestrator re-exporting the full public helper surface.

    **Permission prompt journaling (Policy 14).** Permission requests are now captured via the typed `permission.ask` plugin hook and replies preserve the actual outcome (including rejections) in the audit trail, instead of labeling every permission event as allowed.

    **Runtime instance isolation.** Per-invocation workspace root, SDK client, and project config now flow through `runWithRuntimeState` (AsyncLocalStorage), so co-hosted plugin instances cannot read each other's runtime context.

    **Dynamic session-scoped TUI badge (Policy 16).** The TUI companion now shows the last block reason (`Active` vs `Blocked: <reason>`) scoped to the triggering session, sourced only from guard-originated toasts.

    **Testing & docs.** `test/test-e2e.mts` now packs and installs the npm tarball to verify the modular entrypoint resolves, in addition to the live local-copy plugin-load checks. `AGENTS.md`, README, and policy/testing/installation docs were synchronized with the new layout and hook contracts.

## 1.1.5

### Patch Changes

- d65e5eb: Use `changeset publish` in release workflow to ensure git tags and GitHub Releases are created automatically upon publish.

## 1.1.4

### Patch Changes

- bdb0796: Upgrade Release workflow to Node.js 24 (npm >= 11.5.1) required for npm OIDC Trusted Publishing.

## 1.1.3

### Patch Changes

- 1c515ae: Align repository.url format with npm git+https convention for Trusted Publishing OIDC claim validation.

## 1.1.2

### Patch Changes

- 2644db7: Switch npm release workflow from legacy token to OIDC Trusted Publishing.

## 1.1.1

### Patch Changes

- dfa60a2: Fix npm packaging so the package is installable and resolvable as an OpenCode plugin:
    - Add `main` entry point (`src/workflow-guard.ts`) so the plugin resolves when listed in `opencode.json`'s `plugin` array
    - Move `@opencode-ai/plugin` from devDependencies to runtime dependencies (`^1.18.21`) so Bun installs it alongside the plugin at startup
    - Add `publishConfig.access: public` and a `prepublishOnly` typecheck guard
    - Document npm as the recommended installation method in docs/installation.md

## 1.1.0

### Minor Changes

- b51ace8: Ecosystem-inspired DX and safety enhancements across verification, secret inspection, and multi-agent coordination:
    - **Safe .env Schema Masking (Policy 17):** Reading `.env*` files returns a sanitized variable schema mask (`KEY=********`) allowing agents to discover required environment variable names without exposing live secret values.
    - **Verification Output Snipping (Policy 10):** Truncates verbose passing/failing verification stdout/stderr (`snipVerifyOutput`) prioritizing error keywords and stack traces to minimize context bloat.
    - **Git State & Snapshot Binding (Policy 10):** Verification results now capture git commit hash (`git rev-parse HEAD`) and working tree status (`git status --porcelain`) to invalidate stale verification on external changes.
    - **Durable Verification Disk Cache (Policy 10/14):** Passing verification results are cached to disk (`~/.local/state/opencode/workflow-guard/last-verify.json`) across session restarts and multi-agent handoffs.
    - **Subagent Attribution & Breadcrumb Tagging (Policy 1/14/15):** Compaction hooks and audit trail entries now preserve subagent role identity and parent hierarchy links.
    - **Mutation Accounting (Policy 10):** Added `getMutationCount()` tracking for audit and lifecycle verification.
- b338d86: Enrich Policy 15 compaction hook with full operational guard state:
    - Injects active tasks with status badges and subagent/parent session attribution
    - Injects active Git branch name and protected branch status
    - Injects test verification evidence (status, verify command, and commit hash)
    - Injects secondary review verdict (reviewer name and approval status)
    - Injects session mutation count
    - Ensures complete context continuity across OpenCode session compactions
- 68d8a14: Harden guard boundaries and evidence integrity:
    - `mv` source validation: moving files from outside the workspace, or moving protected settings/plugin files to innocuous names, is now blocked (mv mutates its sources)
    - The workspace boundary (Policy 8) has no override: `WORKFLOW_GUARD_ALLOW_LIVE=1` no longer weakens shell or external-repository git confinement
    - The exact `.opencode` directory itself is protected, not only paths nested inside it
    - Durable verification evidence is workspace-bound: a cached passing run from one project can no longer satisfy finalization in another (critical for non-git workspaces)
    - Policy 21 documentation gate accepts only README.md and `docs/` changes; changeset fragments and other markdown no longer satisfy it
    - Audit-trail and command-event tests now assert real behavior instead of unconditional `true`
- e36b48d: Integrate Changesets (@changesets/cli) for fragment-based changelog and version management:
    - Policy 3 now accepts `.changeset/*.md` diffs in addition to `CHANGELOG.md` and PR body `Changelog:` sections
    - CI changelog check accepts `.changeset/*.md` fragment files to prevent merge conflicts between parallel PRs
    - Added `package.json` scripts: `changeset` and `version-packages`
- 1f8b87f: Add native in-process Git worktree lifecycle tools:
    - `guard_worktree_create(branch, baseBranch?)`: creates an isolated git worktree under `~/.local/share/opencode/worktrees/<repo-name>/` (override with `WORKFLOW_GUARD_WORKTREE_DIR`), validates branch names via `git check-ref-format`, rejects built-in and config-defined protected branches, and symlinks the parent `node_modules` for zero-reinstall tooling
    - `guard_worktree_cleanup(worktreePath)`: commits a final auto-snapshot (excluding the plugin-created `node_modules` symlink) before removing the worktree; aborts with the worktree intact when the snapshot cannot be established
    - Cleanup is ownership-validated: only registered worktrees of the current repository under the configured storage directory are removed — arbitrary directories, other repos' worktrees, and the primary working tree are refused, and there is no raw-deletion fallback
    - Both tools enforce the todo gate and invalidate stale verification/review evidence on mutation
    - Spawned git commands run with a sanitized environment (git context variables such as `GIT_INDEX_FILE` are stripped), so the tools work reliably even when invoked from inside git hook contexts
    - Branches configured via `protectedBranches` in `.opencode/workflow-guard.json` now receive destination-side push protection, matching the built-in main/master rules (`git push origin feature/x:release/prod` is blocked)
    - Enables fully isolated concurrent subagent execution with no external dependencies or terminal spawning
- 150f40c: Implement Policy 22 (Non-Interactive Shell & TTY Hang Guard) and Native Desktop Notifications:
    - **Policy 22:** Deterministically blocks interactive text editors (`nano`, `vim`), pagers (`less`), process monitors (`top`), `sudo`, and package manager invocations lacking non-interactive flags (`npm init` / `apt-get` without `-y`) to prevent subshell freezes.
    - **Native OS Desktop Notifications:** Non-blocking notification dispatch (`notify-send` / `osascript`) on blocked actions and verification completions.
    - **CI & Package Audit:** Updated dependency tree and validated `npm audit` passing at high security threshold.
- 150f40c: Implement Policy 23 (Package Supply-Chain & Dependency Hygiene Guard):
    - Blocks destructive `npm audit fix --force` downgrades
    - Blocks global package installations (`npm i -g`, `pnpm add -g`) in agent sessions
    - Blocks direct CLI package publishing (`npm publish`, `pnpm publish`)
    - Blocks unpinned `pip --force-reinstall` commands
- a08c64f: Refactor repository folder layout and streamline documentation:
    - Shift production TypeScript plugin files into `src/` (`src/workflow-guard.ts`, `src/workflow-guard-ui.ts`)
    - Shift unit and runtime tests into `test/` (`test/test.mts`, `test/test-e2e.mts`)
    - Update `package.json` entry files and test script paths
    - Update `tsconfig.json` include patterns
    - Significantly streamline and shorten `README.md`, directing detailed policy references to standalone docs
    - Update repository documentation tree

### Patch Changes

- 8395c78: Add ACKNOWLEDGEMENTS.md to credit community projects and ecosystem inspirations.
- 1c89b23: Automate Changesets versioning and npm releases via @changesets/action in release.yml.

All notable changes to `opencode-workflow-guard` will be documented in this file.

## [1.2.0] - 2026-08-22

### Security & Invariant Hardening

- **Secret-File READ Block (Policy 17).** Blocks reading `.env*`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `*kubeconfig*`, `*credentials*.json`, and `service-account*.json` via the `read` tool or shell inspection commands (`cat`, `less`, `grep`, `awk`, `head`, `tail`, `base64`). Non-secret fixtures (`.env.example`, `.env.sample`, `.env.template`) remain readable.
- **Interpreter Inline Evasion Scanner (Policy 18).** Decodes and scans inline interpreter payloads (`python -c`, `node -e`, `perl -e`, `ruby -e`, `osascript -e`, `powershell -enc`, `echo <base64> | base64 -d | sh`) to prevent smuggling destructive commands or settings tampering.
- **Conflict-Free Pre-Flight Guard (Policy 19).** Uses `git merge-tree` to verify the branch has zero merge conflicts with the base branch (`origin/main`) before PR creation or final task handoff.
- **Merged Branch & Base Freshness Guard (Policy 20).** Blocks pushing to branches already merged or associated with closed PRs (GitHub & Azure DevOps), and blocks creating fresh branches when the local base is behind remote.
- **Privilege-Isolated Verification Execution (Policy 10).** Verification runs with scrubbed credentials (`getCleanEnv()`), output caps, safety checks against destructive commands, and a 30s timeout to prevent process hangs or credential exfiltration.
- **Multi-Segment Shell Mutation Scanning (Policy 8).** Fixed compound command parsing in `guardShellMutation()` to inspect all segments rather than returning early on the first match.
- **Symlink-Aware Workspace Boundary Enforcement (Policy 8).** Uses `realpathSync` to ensure target paths and existing ancestor directories cannot traverse outside the workspace root via symlinks.
- **External Git Repository Protection (Policy 7/8).** Confines mutating Git operations (`git -C /other-repo commit`) to repositories within the workspace boundary unless `WORKFLOW_GUARD_ALLOW_LIVE=1` is set.

### Developer Experience & Multi-Agent Accountability

- **Azure DevOps & GitHub PR Parity (Policy 3).** Full PR changelog support for `az repos pr create` alongside `gh pr create`.
- **Secondary Review Spoke & Rubric.** Added `buildReviewRubric` and `recordReviewResult` integrating `code-review-and-quality` and `doubt-driven-development` skills to verify real behavioral tests and zero shortcut stubs.
- **Worktree & Devcontainer Root Resolution.** Initializes workspace root from `ctx.worktree || ctx.directory || process.cwd()`.
- **Project Configuration (`.opencode/workflow-guard.json`).** Supports repository overrides for custom protected branches, custom verify commands, and review enforcement.
- **Custom Inspection Tools.** Registers `guard_status`, `guard_audit`, `guard_why`, and `record_review` in OpenCode sessions.
- **Toast Notifications on Block (Policy 16).** Emits real-time warning toasts via `tui.showToast` on blocked actions.
- **Flexible Task Execution (Policy 1).** Relaxed strict top-down sequential completion blockers while maintaining single-task `in_progress` focus and silent deletion prevention.
- **Evidence-Based Verification Freshness (Policy 10).** Associates mutation timestamps with verification runs, ensuring test evidence is fresh before allowing finalization.
- **Documentation Synchronization Guard (Policy 21).** Verifies relevant documentation (`README.md` or `docs/`) is reviewed and updated when changes alter features or policies before PR creation.
- **Comprehensive Adversarial Test Suite.** 235 passing unit and adversarial tests covering all policies and evasion vectors.

### Fixed

- **README policy table now starts at Policy 1.** The "Summary of Enforced Policies" table omitted Policy 1 (Task Gate & Lifecycle) and began at 2; the row is restored. `docs/policies.md` also regains its missing Policy 9 (Script-Laundering Guard) section.

### Changed

- **Targeted `rm -rf` guard (Policy 4).** Recursive/forced deletion is now blocked only when it targets system/home/wildcard paths (`/`, `~`, `*`); workspace-local cleanup (`rm -rf node_modules`, `rm -rf dist/`, `rm -r build/`) is allowed, removing a routine false positive.
- **Verification runs at finalization, not per-edit (Policy 10).** The verify command (`WORKFLOW_GUARD_VERIFY` / auto-detected `npm test`) no longer spawns in the background after every edit - it runs once, on demand, when the agent attempts to mark every todo completed. This eliminates test churn on intermediate broken states and the CPU cost of per-edit runs.
- **Shell env scrub announces itself (Policy 12).** When the `shell.env` hook empties sensitive variables, a warning is logged naming the scrubbed keys so auth failures are diagnosable instead of silent.
- **Script-laundering scan skips comment lines (Policy 9).** Payloads are scanned line-by-line; lines starting with `#`, `//`, `/*`, or `*` are ignored, reducing false positives on documented cleanup commands while keeping executable lines covered.

### Changed

- **Dependency & CI updates:**
    - Upgraded GitHub Actions `actions/checkout` and `actions/setup-node` to v7 across CI and Release workflows.
    - Upgraded `typescript` to `^7.0.2` and `@types/node` to `^26.2.0`.
    - Configured Dependabot groups for npm and GitHub Actions dependencies to bundle automated updates.
    - Exempted `dependabot[bot]` from the PR CHANGELOG gate in CI.

### Added (DX improvements)

- **Post-edit verification gate (Policy 10).** After every successful `edit`/`write`/`apply_patch`, the guard runs `WORKFLOW_GUARD_VERIFY` (or auto-detects `npm test` from `package.json`) in the background. Marking every todo completed is blocked while the latest verify run is failing - the agent can no longer claim "done" over a red build.
- **Secret-content scan (Policy 11).** File payloads are blocked at write/edit when they carry AWS keys, private key headers, GitHub tokens (`ghp_`, `github_pat_`, …), LLM/API keys, Google/Slack tokens, or env-style assignments (`AWS_SECRET_ACCESS_KEY=…`).
- **Shell environment scrub (Policy 12).** `shell.env` empties sensitive vars (`AWS_*`, `KUBE*`, `OPENAI*`, `ANTHROPIC*`, `GH_/GITHUB_*`, `GOOGLE_/GCP_`, `AZURE_`, `SLACK_`, `NPM_`, `DOCKER_`, `KUBECONFIG`, plus fixed names like `GITHUB_TOKEN`, `OPENAI_API_KEY`, `NPM_TOKEN`) so the agent cannot carry live credentials into shell sessions by default.
- **Command-channel audit (Policy 13).** `command.executed` events are journaled to the durable audit trail alongside tool decisions.
- **Audit trail (Policy 14).** Every block/allow decision is appended as JSON to `~/.local/state/opencode/workflow-guard/workflow-guard.jsonl` (XDG_STATE_HOME respected), giving developers a durable, machine-readable record of guard activity for review.

### Security (Fixed Holes)

- **CI pipeline** (`.github/workflows/ci.yml`): typecheck → unit-test matrix (Node 20/22/24) → live plugin-load e2e → `npm audit` → CHANGELOG-updated PR gate. `e2e` skips cleanly when no `opencode` binary is installed.
- **Release workflow** (`.github/workflows/release.yml`): `v*` tag → re-verify → tag/version consistency check → `npm publish --provenance` → GitHub release with generated notes.
- **Dependabot** (`.github/dependabot.yml`): weekly npm + GitHub Actions updates.
- **README** CI/CD section documenting triggers and required branch protection checks.

### Security (Fixed Holes)

- **Removed `# allow-live` in-command override.** The marker let the agent grant itself live-system access, and the block message advertised how. The `WORKFLOW_GUARD_ALLOW_LIVE=1` environment variable (set by the user before launch) is now the only override.
- **Tamper guard closes edit-tool hole.** `edit`/`write`/`apply_patch` were unchecked on path tamper - a project-level `opencode.json`/`.opencode/` was directly editable. `isProtectedPath()` is now enforced on all edit-tool targets (not just shell).
- **Guard no longer defeats itself.** Tamper patterns now cover the guard's own plugin and TUI files (`~/.config/opencode/plugins/*`, `~/.config/opencode/ui/*`) with any extension, closing the `sed -i … workflow-guard.ts` hole.
- **Shell file mutations now gated.** The edit-tool gates (todo activity, branch, boundary) were bypassed by shell redirect (`>`), `tee`, `sed -i`, `cp`/`mv`, and `git apply`/`git am`. `guardShellMutation()` applies the same gates to those idioms.
- **Script-laundering guard.** `write`/`apply_patch` payloads are scanned for destructive patterns so `write deploy.sh` → `bash deploy.sh` no longer smuggles blocked commands.
- **Git global-flag evasion.** `-C`, `--git-dir`, `--work-tree`, `-c`, `--config-env` are parsed before matching, closing `git -C /repo commit` and `git -C /repo push origin main`.
- **Push refspecs blocked.** `git push origin HEAD:main`, `feature:main`, `:main` (delete) and `+main` (forced) are gated; previously only bare `main` matched.
- **History-changing commands extended.** `update-ref`, `filter-branch`, and `branch -D` are now in the branch guard.
- **MCP guard tokenization.** Server names are split on all non-alphanumerics, closing `mcp__azure-devops__*` and `mcp__gh__*` evasions; legacy flat names (`azure_devops_*`) still match.
- **Tamper evasion normalized.** Quote-concatenation (`open''code.json`), escapes (`open\c\ode`), and filename globs (`opencode.jso?`) are stripped before matching.
- **Destructive list expanded.** Now blocks `rm -rf`, `git clean -fdx`, `docker rm/prune`, `docker volume rm`, `gh repo delete|close`, and `prisma migrate reset`.
- **Read-only false positive fixed.** `cat opencode.json` (and `grep`/`less`/`head`/`tail`) now pass; only write verbs/redirects to protected paths trigger the tamper guard.
- **Adversarial regression suite.** Adds test coverage for every fixed evasion above (147 tests total).

### Changed

- Updated `docs/policies.md` with the new override model, policy numbering, and a "Known Limits" section clarifying pattern-matching is a deterrent, not a sandbox.

## [1.1.1] - 2026-08-21

### Fixed

- TUI badge now renders via `@opentui/solid` slot elements so `[Workflow Guard: Active]` actually appears in OpenCode 1.18+.
- Documented that the UI companion must live under `ui/` + `tui.json`, not `plugins/` (server loader rejects TUI-only modules).

### Changed

- Badge registers both `home_prompt_right` and `session_prompt_right`.

## [1.1.0] - 2026-08-21

### Added

- Persistent TUI status indicator slot on the bottom-left toolbar (`app_bottom`).
- Workspace boundary guard enforcing that edits and patch targets stay within the workspace root.
- Native OpenCode todo lifecycle validation with focus enforcement (single `in_progress` item, sequential progression, no silent deletion).
- Session compaction hook preserving active task lists across context compaction.

### Changed

- Removed intrusive session startup toast notifications in favor of the permanent bottom toolbar indicator.
- Routed plugin block warnings to the OpenCode app logger to avoid TUI screen pollution.
- Updated plugin export structure to V1 PluginModule format supporting both server hooks and TUI plugins.
