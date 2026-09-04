---
"opencode-workflow-guard": minor
---

Improve multi-model workflow adherence by enriching mutating tool definitions (`edit`, `write`, `apply_patch`) with operational preconditions, grounding synthetic continuation prompts with remaining active tasks, and adding in-context circuit breaker steering on repeated blocked operations.
