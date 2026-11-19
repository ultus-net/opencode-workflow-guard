---
"opencode-workflow-guard": patch
---

Allow sanctioned scratch writes, reclaim leaked file claims by TTL, and name the verify-config source.

- `/tmp/opencode` is now a write allowance rather than a block with a nicer message. A write is allowed for a real session and only while the target's canonical location stays inside that exact directory. The root must be a real directory. A symlink that leaves it, a sibling that shares the prefix, a `..` traversal out of it, and a session-less write stay blocked. The todo and feature-branch gates still apply, as they do to every mutation. A scratch write skips the file-claim, prior-read, and mutation-evidence steps because it is not repository state.
- A leaked file claim is now reclaimed by two audited rules, both scoped to the contended paths so a long-running command elsewhere keeps its claim. The existing idle rule stays. A new TTL rule releases a claim older than `claimTtlMs` (default five minutes, `WORKFLOW_GUARD_CLAIM_TTL_MS` wins) even when the owner record cannot be read, which covers a deleted session and a server restart. The reclaim is journaled as `claim_ttl_expired` with the owner and claim age, and the conflict message names the owner, age, and reclaim step.
- `guard_status` reports `projectConfig.configPath`, the project config file actually read, plus `verifyCommandSource` (`environment`, `project-config`, `auto-detected`, or null). A null `verifyCommand` with a null source means the repository has neither a configured nor a detectable command, which is now distinguishable from an auto-detected command.
- A reviewer agent's access to `record_review` is a host permission grant, not a guard policy. The tool stays registered for every session regardless of `requireReview`, so an agent with a deny-all permission list must allow it in its own definition. This release documents that lever and covers the registration with a regression test.
