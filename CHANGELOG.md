# Changelog

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
