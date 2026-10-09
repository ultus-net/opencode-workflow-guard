---
"opencode-workflow-guard": minor
---

Add Policy 25, the live-documentation research floor. After repeated tool failures (default 3) with no live-documentation lookup since, the guard blocks the next mutation or shell call and directs the agent to consult a current source (`websearch`/`webfetch`, or an MCP documentation tool) instead of guessing from training data. Reads, greps, and research tools are never blocked.

The floor is debt-based rather than success-based: an unrelated successful tool does not clear the debt, so a benign command cannot slip a guessed change back through; only a successful research call clears it. It is enabled by default to force the failover and can be disabled with `requireLiveDocs: false` / `WORKFLOW_GUARD_REQUIRE_LIVE_DOCS=0`, or retuned with `liveDocFailureThreshold` / `WORKFLOW_GUARD_LIVE_DOC_THRESHOLD`. Decisions are audited (`reason: live_docs_research_floor`) and block feedback flows to the app log at warn level.

Note for operators: the acting agent must be permitted to call a research tool, or the floor will (correctly) stall it. Agents whose toolset denies `websearch`/`webfetch` and exposes no MCP docs server should be granted one. Both the V1 and V2 entrypoints enforce the floor in parity.

Also add Policy 26, sweeping repository claims vs read coverage. It is observability-only (like Policy 24): when the final response asserts a whole-repository fact ("the entire codebase uses X", "no other callers reference this") but the session has read or authored fewer than 2 distinct files, the mismatch is journaled and logged at info level. The response is never blocked or rewritten, since a search-heavy investigation can legitimately back such a claim with little read coverage. Both entrypoints report it in parity.
