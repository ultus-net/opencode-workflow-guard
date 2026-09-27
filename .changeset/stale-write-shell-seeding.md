---
"opencode-workflow-guard": patch
---

Seed stale-write freshness observations from allowed shell redirect writes: a file the session just created or rewrote via `cmd > file` can be edited without a redundant re-read, extending the existing edit/write seeding (LL-003) to shell writers. Redirects to `/dev/null`, the `/tmp/opencode` scratch directory, or outside the workspace seed nothing, identical-byte (no-op) redirects do not seed, and the not-read block message now also suggests coordinating when another session may own the file.