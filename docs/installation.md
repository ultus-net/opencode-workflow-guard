# Installation Guide

`opencode-workflow-guard` runs as an OpenCode plugin.

---

## Requirements

- **OpenCode >= 1.18** (requires the `GET /session/:id/todo` endpoint and V1 `PluginModule` loader).
- **Node.js >= 22.18** or **Bun** (for running test scripts directly).

---

## Installation Methods

### Option A: npm Package (Recommended)

Add `opencode-workflow-guard` directly to your project or global OpenCode configuration:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-workflow-guard"
  ]
}
```

OpenCode automatically resolves the plugin package and all internal policy modules.

---

### Option B: Local Plugin Copy

Place `workflow-guard.ts`, `lib/`, and `policies/` into your OpenCode plugins folder:

```bash
# Copy into your plugins directory (e.g. ./opencode-plugins/ or your configured plugin path)
cp -r workflow-guard.ts lib policies /path/to/opencode-plugins/
```

Files in your plugin directory are automatically loaded by the OpenCode server process at startup.

---

### 2. TUI Visual Indicator (Prompt Box Badge)

To enable the dynamic prompt-bar badge - `🛡️ [Workflow Guard: Active]` during normal operation, switching to `🛡️ [Workflow Guard: Blocked: <reason>]` for the current session when a guard policy intercepts an action:

1. Place `workflow-guard-ui.tsx` in your config directory (outside `plugins/`):
```bash
mkdir -p ~/.config/opencode/ui
cp workflow-guard-ui.ts ~/.config/opencode/ui/workflow-guard-ui.tsx
```

2. Reference it in your `~/.config/opencode/tui.json`:
```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "file:///absolute/path/to/.config/opencode/ui/workflow-guard-ui.tsx"
  ]
}
```

The TUI badge uses OpenCode's Solid slot API (`@opentui/solid`). OpenCode resolves that package from its own runtime; no extra install is required when running inside OpenCode. For local typecheck of this repo, `@opentui/solid` is a devDependency.

---

## Recommended Companion Configuration

For defense in depth, pair `opencode-workflow-guard` with OpenCode's native permission rules in `opencode.json` (see [OpenCode Permissions](https://opencode.ai/docs/permissions/)):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "edit": "allow",
    "bash": {
      "git push *main*": "deny",
      "git push *master*": "deny",
      "opencode auth*": "deny"
    }
  }
}
```
