---
"opencode-workflow-guard": patch
---

Apply the project-memory database busy timeout before switching journal mode so concurrent first opens can wait for ordinary SQLite contention.
