---
"opencode-workflow-guard": patch
---

Fix npm packaging so the package is installable and resolvable as an OpenCode plugin:
- Add `main` entry point (`src/workflow-guard.ts`) so the plugin resolves when listed in `opencode.json`'s `plugin` array
- Move `@opencode-ai/plugin` from devDependencies to runtime dependencies (`^1.18.21`) so Bun installs it alongside the plugin at startup
- Add `publishConfig.access: public` and a `prepublishOnly` typecheck guard
- Document npm as the recommended installation method in docs/installation.md
