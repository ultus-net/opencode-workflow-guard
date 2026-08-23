---
"opencode-workflow-guard": patch
---

Fix TUI plugin failing to load when installed via npm: move `@opentui/solid` from devDependencies to dependencies so it is installed automatically alongside the package. OpenCode resolves the `./ui` entrypoint's imports from the config directory's `node_modules`, not its own runtime, so the package must declare the dependency itself.
