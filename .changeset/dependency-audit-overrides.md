---
"opencode-workflow-guard": patch
---

Clear the dependency audit so a release can ship clean.

`npm audit` reported 10 vulnerabilities (4 high, 6 critical). Three are leaf packages with direct fixes, applied by `npm audit fix`: `launch-editor` 2.14.2, `shell-quote` 1.12.0, and `brace-expansion` 2.1.7.

The remaining five are nested inside the OpenCode host dependency tree, where the parent packages hard-pin the vulnerable ranges. Two `overrides` entries clear them:

- `solid-js` 1.9.17: `@opentui/solid@0.6.6` peer-pins exactly `1.9.12`, which requires `seroval ~1.5.0` and carries memory-exhaustion and thenable-assimilation advisories. `1.9.17` requires `seroval ~1.6.8`, which is patched. The TUI imports `solid-js` directly, so this is the version the guard actually runs.
- `toml` 5.0.1: `effect@4.0.0-beta.83` (via `@opencode-ai/plugin`) requires `^4.1.1`; `toml <=5.0.0` carries three quadratic-complexity denial-of-service advisories. `5.0.1` keeps the single `parse` export the caller uses, and the guard never parses TOML itself.

`npm audit` now reports zero vulnerabilities. Note that `npm overrides` apply only to the root project, so this protects this repository's install and CI, not a consumer's transitive tree; a consumer resolves the parent-declared ranges unless it declares the same overrides. Both entries are documented in `docs/installation.md` and should be dropped once the parent packages widen their ranges.
