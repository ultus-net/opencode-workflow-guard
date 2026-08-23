# Repository Guide

## Where Behavior Lives
- `src/workflow-guard.ts` is the server plugin entrypoint and orchestrator: it imports policy modules from `src/policies/` and engine services from `src/lib/`, then re-exports the public helper surface for tests. Keep its default export in V1 `PluginModule` form: `{ id: "workflow-guard", server: WorkflowGuard }`. OpenCode 1.18+ can misinterpret a bare default plugin function when named helper exports are present.
- `src/policies/` holds the per-policy implementations (`todo`, `git`, `changelog`, `destructive`, `mcp`, `tamper`, `boundary`, `secrets`, `interpreter`, `docs`, `shell-safety` for Policies 22/23 + desktop notifications). Add new policies as new modules here, not inline in `workflow-guard.ts`.
- `src/lib/` holds shared engine services: `state` (runtime state + AsyncLocalStorage), `utils`, `audit` (incl. durable verify cache), `verify`, `review`, `worktree`, `types`. Policy modules must read runtime context via these getters, never module-level captures.
- `src/workflow-guard-ui.ts` is the optional TUI companion; it is installed separately from the server plugin.
- `test/test.mts` is an executable in-memory/adversarial harness, not a framework suite. It has no per-test CLI filter; add a focused regression check and run `npm test`.
- `test/test-e2e.mts` packs the npm tarball, installs it into an isolated project, copies the plugin (with `src/lib/` and `src/policies/`) into `.opencode/plugins/`, and launches real `opencode run` sessions. It skips successfully when `opencode` is absent from `PATH`, so a CI-green E2E job does not prove the live loader ran unless the binary was present.

## Verification
- Use Node 22+ locally. CI runs unit tests on Node 22 and 24; `docs/testing.md` documents Node >=22.18 for `test.mts`.
- Fast checks: `npm run typecheck` and `npm test`.
- Live loader/hook check: `npm run test:install`; it is slower and model-driven, so inspect captured output when it fails rather than assuming the guard logic failed.
- Full local sequence: `npm run typecheck && npm test && npm run test:install`. CI additionally runs `npm audit --audit-level=high`.
- `npm run build` is only a typecheck alias; this package ships the TypeScript plugin source rather than emitted build artifacts.

## Guard-Specific Constraints
- Treat shell matching as defense in depth, not a sandbox. New policy claims need adversarial regression cases for normal CLI variants: wrappers/options, chained commands, multiple operands, symlink aliases, and parent/subagent sessions have all caused real bypasses here.
- When changing mutation detection, keep verification/review freshness in sync. Mutations governed by inherited parent todos must invalidate the parent's evidence, including Git worktree/history mutations.
- Existing secret/protected-path checks are symlink-aware. Preserve ancestor resolution for new files through symlinked directories; checking only the lexical or final existing path reopens bypasses.
- `WORKFLOW_GUARD_ALLOW_LIVE=1`, set before OpenCode starts, is the only live-system override. Do not reintroduce an in-command `# allow-live` escape.
- Project `.opencode/workflow-guard.json[c]` may configure `protectedBranches`, `verifyCommand`, `requireReview`, and `requireDocumentation`; behavior changes must honor these in addition to environment overrides/defaults.
- Per-invocation runtime context (workspace root, SDK client, project config) flows through `runWithRuntimeState` (AsyncLocalStorage) in `src/lib/state.ts`. Verification/review evidence maps in `src/lib/state.ts` are process-global by design so subagent sessions share freshness with parents; do not "fix" that without a dedicated design discussion.
- Permission prompts must be journaled via the typed `"permission.ask"` plugin hook. There is no `permission.asked` event in the V1 SDK `Event` union (only `permission.updated`/`permission.replied`); tests must not fabricate unsupported event types with `as any`.
- There is deliberately no LSP-diagnostics finalization gate: the V1 `lsp.client.diagnostics` event carries only `{serverID, path}` metadata, not diagnostics. Do not reintroduce the gate until the SDK exposes a supported diagnostics source.
- Block reasons must keep flowing to `client.app.log()` at warn level via `logBlock` (the modularization accidentally no-op'd it once); toasts via `tui.showToast` are for the TUI, app logs are for the durable in-app trail.
- The single-task focus rule was intentionally removed from Policy 1: multiple tasks may be `in_progress` concurrently so subagents can parallelize. Only "no silent deletion" and the all-done verification gate remain.

## PR And Release Gates
- Releases are managed by Changesets: add a `.changeset/*.md` entry (run `npm run changeset`) for user-facing changes. `@changesets/action` opens/updates the version PR, and merging it publishes to npm with OIDC Trusted Publishing and creates the GitHub Release.
- Keep README/policy/troubleshooting docs synchronized when policy behavior changes. The plugin can enforce documentation updates when configured, and CI/review treats policy docs as part of the behavior contract.
