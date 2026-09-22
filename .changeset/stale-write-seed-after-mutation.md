---
"opencode-workflow-guard": patch
---

A successful `edit`/`write` now records the session's stale-write observation of the bytes it just authored, so iterating on a file the session created or modified no longer demands a redundant re-read. Previously only `read` seeded the observation, so a follow-up `edit` to a just-written file was blocked with "has not been read by this session" (the most common guard block in local audit logs, including agent-authored temp scripts).

- The observation is seeded only when the file content actually changed (the pre/post digest differs), so a no-op or failed mutation seeds nothing; an external change after the mutation still fails the next comparison and blocks the edit. V2 additionally skips errored calls outright.
- Observations remain per-session and are cleared on session idle/deletion. `apply_patch` results also seed the session observation, while its clobbering pre-check remains outside this bounded mechanism as documented.
