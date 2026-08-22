---
"opencode-workflow-guard": minor
---

Enrich Policy 15 compaction hook with full operational guard state:
- Injects active tasks with status badges and subagent/parent session attribution
- Injects active Git branch name and protected branch status
- Injects test verification evidence (status, verify command, and commit hash)
- Injects secondary review verdict (reviewer name and approval status)
- Injects session mutation count
- Ensures complete context continuity across OpenCode session compactions
