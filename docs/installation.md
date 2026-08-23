# Installation Guide

`opencode-workflow-guard` runs as an OpenCode plugin.

---

## Requirements

- **OpenCode >= 1.18** (requires the `GET /session/:id/todo` endpoint and V1 `PluginModule` loader).
- **Node.js >= 22.18** or **Bun** (for running test scripts directly).

---

## Installation Methods

### 1. From npm (Recommended)

Add the package to your project's `opencode.json` (or global `~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-workflow-guard"
  ]
}
```

OpenCode automatically installs the plugin and its dependencies with Bun at startup (cached in `~/.cache/opencode/node_modules/`). No manual file copies needed.

---

### 2. Manual File Copy (Server Plugin)

Install the core server plugin into your plugin directory:

```bash
# Global (all projects)
mkdir -p ~/.config/opencode/plugins
cp workflow-guard.ts ~/.config/opencode/plugins/

# Project-level (per repo)
mkdir -p .opencode/plugins
cp workflow-guard.ts .opencode/plugins/
```

Files in `.opencode/plugins/` and `~/.config/opencode/plugins/` are automatically loaded by the OpenCode server process at startup.

---

### 3. TUI Visual Indicator (Prompt Box Badge)

To enable the persistent `🛡️ [Workflow Guard: Active]` badge inside the prompt input bar:

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
