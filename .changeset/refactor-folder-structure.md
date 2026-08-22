---
"opencode-workflow-guard": minor
---

Refactor repository folder layout and streamline documentation:
- Shift production TypeScript plugin files into `src/` (`src/workflow-guard.ts`, `src/workflow-guard-ui.ts`)
- Shift unit and runtime tests into `test/` (`test/test.mts`, `test/test-e2e.mts`)
- Update `package.json` entry files and test script paths
- Update `tsconfig.json` include patterns
- Significantly streamline and shorten `README.md`, directing detailed policy references to standalone docs
- Update repository documentation tree
