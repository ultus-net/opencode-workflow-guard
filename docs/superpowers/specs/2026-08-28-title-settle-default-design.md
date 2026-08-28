# Title Settle Default Design

## Context

Workflow Guard can automatically continue a root session that still owns unfinished todos. That synthetic continuation can race OpenCode's asynchronous native session-title generation. The existing `titleSettleWorkaround` behavior avoids the race by briefly waiting for native title generation, but it currently requires explicit opt-in even though Workflow Guard's continuation behavior creates the need for the workaround.

## Decision

Enable the title-settle behavior by default. A missing `titleSettleWorkaround` setting means enabled; `titleSettleWorkaround: false` remains an explicit project-level opt-out.

The server and TUI must expose the same effective semantics. The project-options menu therefore renders Title settle workaround as On when the setting is absent, and selecting it persists `false`. Selecting it again persists `true`.

No configuration migration is required. Existing projects that do not mention the setting acquire the safer default automatically, while projects already configured with `false` retain their behavior.

## Scope

- Change effective server behavior from `=== true` to enabled unless explicitly false.
- Change the TUI project-option reader to report the same enabled-by-default value.
- Preserve all existing bounded-wait, ownership, title, provider, and model behavior.
- Update installation and policy documentation to describe the default and opt-out.
- Update regression coverage for default-enabled behavior and explicit-false opt-out.

## Verification

Regression tests must prove that an unconfigured project uses title settling, explicit `false` bypasses title settling, and the TUI reports/toggles the same effective state. The repository typecheck, unit harness, and packaged-install test must remain green.
