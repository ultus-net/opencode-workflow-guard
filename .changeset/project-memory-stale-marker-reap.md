---
"opencode-workflow-guard": patch
---

Reap stale project-memory coordination markers during the daily maintenance pass: markers (`*.sqlite.active.*`) left behind by processes that died without closing their store previously accumulated until the 100 MB storage ceiling triggered eviction, so a healthy machine collected unbounded zero-byte files. Maintenance now removes provably dead owners opportunistically, keeping the project-memory directory's file count bounded without storage pressure. Markers owned by live or unidentifiable processes are never removed.
