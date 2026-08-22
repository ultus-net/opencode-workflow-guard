# Repository Guide

## Where Behavior Lives
- `workflow-guard.ts` is the server plugin and policy implementation. Keep its default export in V1 `PluginModule` form: `{ id: "workflow-guard", server: WorkflowGuard }`. OpenCode 1.18+ can misinterpret a bare default plugin function when named helper exports are present.
- `workflow-guard-ui.ts` is the optional TUI companion; it is installed separately from the server plugin.
- `test.mts` is an executable in-memory/adversarial harness, not a framework suite. It has no per-test CLI filter; add a focused regression check and run `npm test`.
- `test-e2e.mts` launches real `opencode run` sessions in a temporary project. It skips successfully when `opencode` is absent from `PATH`, so a CI-green E2E job does not prove the live loader ran unless the binary was present.

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

## PR And Release Gates
- Every non-Dependabot PR must modify `CHANGELOG.md`; CI checks this independently of the plugin's PR-body `Changelog:` policy.
- Keep README/policy/troubleshooting docs synchronized when policy behavior changes. The plugin can enforce documentation updates when configured, and CI/review treats policy docs as part of the behavior contract.
- Releases are tag-driven. `vX.Y.Z` must exactly match `package.json` version before the release workflow will publish to npm with provenance.
