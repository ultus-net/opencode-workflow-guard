---
"opencode-workflow-guard": minor
---

Qualify against OpenCode 2.2.0.

OpenCode 2.2.0 reorganizes the `@opencode/ai` export surface. `Message` is no
longer reachable from the package root there, and a root named import throws
`SyntaxError: The requested module '@opencode/ai' does not provide an export
named 'Message'`. A V2 plugin that cannot be evaluated registers no hooks, so
every policy would be inert while the host looks healthy. This release moves the
import and the pins to the 2.2.0 package set.

- **Import path.** `Message` moves from the `@opencode/ai` root to
  `@opencode/ai/effect`. On 2.2.0 the root no longer re-exports the schema
  surface, so a root named import throws, as quoted above; verified against the
  installed 2.2.0 dist. `@opencode/plugin@2.2.0` itself imports `Message` from
  `/effect`, so this is the host's own sanctioned path. No call site changes:
  `Message.user` is still the constructor used at `src/lib/v2-plugin.ts:542`.
- **Pins.** `@opencode/plugin` and `@opencode/ai` move to `2.2.0`, and
  `@opentui/solid` to `0.7.0`, which `@opencode/plugin@2.2.0` declares as an
  exact peer requirement. `@opentui/core` is deliberately not added as a direct
  dependency: `@opentui/solid@0.7.0` already declares it as an exact dependency,
  so an extra pin would duplicate a resolution the tree already settles. The
  `@opencode-ai/plugin` `1.19.3` V1 pin is unchanged. Of the existing `overrides`
  entries, `solid-js` `1.9.17` still applies because `@opentui/solid@0.7.0` still
  peer-pins exactly `1.9.12`; `toml` `5.0.1` is unaffected.
- **Todo capability.** The registry probe already covers this host, so 2.2.0
  needs no version check. Verified on the live 2.2.0 binary: `available` with
  `experimental.todo: true`, `unavailable` without it.
- **Docs.** `docs/installation.md` carries a 1.18.x / 2.2.0 qualification row
  listing only the seats actually exercised, and the pin-set paragraph now
  explains the `@opencode/ai` root-versus-`/effect` boundary and why
  `@opentui/core` needs no direct pin.
- **Test coverage.** `test/test-e2e.mts` gains two canaries that need no model
  provider: the permission seat denies a real finding and abstains on an
  undecidable push. They run inside the real host setup with the workspace taken
  from the host's own `location.directory`; the push case passes no client,
  because the point is that simulation skips the remote PR probe. The deny
  canary asserts policy identity (`secrets` / `secret_read`), not message prose.

Verified on OpenCode v2.2.0: `npm run typecheck` clean, `npm test` 1370 passed /
0 failed, `npm run test:install` 32 passed / 0 failed. The opt-in model-driven
probes remained unavailable because the provider returned
`Model unavailable` before guard behavior could run, which that harness reports
as `live unavailable` rather than as a guard failure.

The `zod` advisory is also cleared here. `GHSA-mrhx-c7xc-m3w5` covers
`zod <4.6.6`, and the vulnerable `4.1.8` copy arrived through the exact
`@opencode-ai/plugin@1.19.3` V1 pin while the V2 entrypoint imports `zod`
without declaring it. A new `zod: 4.6.6` override dedupes both onto one patched
copy, and `npm audit` now reports zero vulnerabilities. That override must be
applied with a clean reinstall: an incremental `npm install` leaves the old
resolution in place and fails 14 `test:install` checks, which reads as an
incompatibility but is a stale tree.

One pre-existing issue is deliberately not fixed here, because it needs a real
binary probe and changes behavior beyond a host qualification:
`src/lib/policy-posture.ts` describes the `code-mode-surface` rule as inert on the
qualified hosts because they "register no `execute` tool". That rationale is not
accurate: the tool is registered, and this repository's own session calls it on
2.1.3.
