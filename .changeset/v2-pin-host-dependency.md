---
"opencode-workflow-guard": patch
---

Pin every direct dependency to the exact version this build is qualified against instead of `latest`. A floating host API lets a new major load and silently no-op, which is the failure mode the migration guide names. `guard_status` now also reports `qualifiedHostVersion` next to the live `hostVersion`, so a mismatch is visible before it becomes an inert hook.

Qualify OpenCode 2.1.3 and move the host pins with it: `@opencode/plugin` and `@opencode/ai` to `2.1.3`, and `@opentui/solid` to `0.6.6` (the 2.1.3 peer floor). A 2.0.x pin set on a 2.1.x host does not degrade gracefully: the plugin imports an `effect` path the host no longer provides, so the host reports `failed to load plugin` and every policy is inert. This was reproduced, then fixed by moving the pins.

Fix `opencode-workflow-guard setup`, which wrote the singular `plugin` key unconditionally. OpenCode 2 reads only `plugins`, and its config schema drops the singular key without an error, so setup on a 2.x install produced a config that looked configured and loaded nothing. Setup now detects the target from the existing config, defaults to OpenCode 2, and accepts `--major 1|2` to state it explicitly.
