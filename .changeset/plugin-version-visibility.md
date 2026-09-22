---
"opencode-workflow-guard": minor
---

The loaded guard version is now visible: `guard_status` reports it as `pluginVersion`, and the startup app log states `Workflow Guard v<version> plugin initialized`. This closes the silent-stale-installation trap where OpenCode resolves a configured bare plugin name through Node's parent-directory lookup from its configuration location — a copy in a parent `node_modules` (for example a pnpm-managed home directory) shadows both OpenCode's plugin cache and a global `npm install -g`, so updates to the wrong surface leave an old version running. `docs/installation.md` and `docs/troubleshooting.md` now document the shadowing behavior, how to verify which copy actually loaded, and how to update it (`opencode service restart` reloads the background service).
