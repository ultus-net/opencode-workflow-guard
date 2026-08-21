# Installation Guide

`opencode-workflow-guard` runs as an OpenCode plugin.

---

## Requirements

- **OpenCode >= 1.18** (requires the `GET /session/:id/todo` endpoint and V1 `PluginModule` loader).
- **Node.js >= 22.18** or **Bun** (for running test scripts directly).

---

## Installation Methods

### Option A: Project-Level Installation (Per Repository)

Install the plugin into a specific project's `.opencode/plugins/` directory:

```bash
mkdir -p .opencode/plugins
cp workflow-guard.ts .opencode/plugins/
```

OpenCode automatically discovers and loads all `.ts` files inside `.opencode/plugins/` at startup.

---

### Option B: Global Installation (All Projects)

Install the plugin globally for all OpenCode sessions:

```bash
mkdir -p ~/.config/opencode/plugins
cp workflow-guard.ts ~/.config/opencode/plugins/
```

---

### Option C: Via `opencode.json` (NPM / Package Reference)

If installed from npm or a package directory, reference it in `opencode.json` (or `~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-workflow-guard"]
}
```

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
