# Contributing to opencode-workflow-guard

Thanks for your interest! This plugin enforces workflow discipline through
**deterministic hooks** — every contribution should maintain that standard.

## Quick Start

```bash
git clone https://github.com/ultus-net/opencode-workflow-guard.git
cd opencode-workflow-guard
npm install
npm run typecheck && npm test
```

Install the pre-commit hooks (recommended):
```bash
git config core.hooksPath .githooks
```

## Verification

Always run before pushing:

```bash
npm run typecheck   # strict TS — 0 errors required
npm test            # in-memory unit + adversarial tests
npm run test:all    # optional: full suite incl. live opencode load
```

## Test Patterns

The test suite in `test/test.mts` is an in-memory adversarial harness, not a
framework suite. New policies or evasions need regression cases for:

- Normal CLI variants (options, wrappers, chained commands)
- Multiple operands and symlink aliases
- Parent/subagent session hierarchies
- Quote-concatenation, escapes, and glob wildcards

See `docs/testing.md` for the full coverage matrix.

## Adding a Guard Policy

1. Add the check logic as a new module in `src/policies/` (or extend the
   matching existing policy module), then wire it into the orchestrator's
   `guardToolCallImpl` in `src/workflow-guard.ts`.
2. Add regression tests in `test/test.mts` (look for existing policy blocks).
3. Document the policy in `docs/policies.md` and update the policy table in
   `README.md`.
4. If the policy deserves a troubleshooting entry, add it to
   `docs/troubleshooting.md`.
5. Add a changeset (`npx changeset`) for release notes.

## PR Requirements

- Every PR must document its change using one of these methods (mirrors Policy 3):
  - **Preferred:** Add a changeset file with `npx changeset` (creates `.changeset/<name>.md`), avoiding merge conflicts with parallel PRs.
  - Add a `Changelog:` section in the PR description.
  - Update `CHANGELOG.md` directly.
- Keep documentation synchronized — if you change behavior, update README,
  policy docs, and troubleshooting guide.
- The `record_review` custom tool should be used for secondary review
  verification when policy correctness matters (it usually does).

## Security

If you find a bypass or vulnerability, **do not open a public issue**.
See `SECURITY.md` for the disclosure process.