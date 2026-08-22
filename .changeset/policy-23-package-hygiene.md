---
"opencode-workflow-guard": minor
---

Implement Policy 23 (Package Supply-Chain & Dependency Hygiene Guard):
- Blocks destructive `npm audit fix --force` downgrades
- Blocks global package installations (`npm i -g`, `pnpm add -g`) in agent sessions
- Blocks direct CLI package publishing (`npm publish`, `pnpm publish`)
- Blocks unpinned `pip --force-reinstall` commands
