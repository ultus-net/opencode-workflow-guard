# Changelog

All notable changes to `opencode-workflow-guard` will be documented in this file.

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
