---
"opencode-workflow-guard": minor
---

Harden guard boundaries and evidence integrity:
- `mv` source validation: moving files from outside the workspace, or moving protected settings/plugin files to innocuous names, is now blocked (mv mutates its sources)
- The workspace boundary (Policy 8) has no override: `WORKFLOW_GUARD_ALLOW_LIVE=1` no longer weakens shell or external-repository git confinement
- The exact `.opencode` directory itself is protected, not only paths nested inside it
- Durable verification evidence is workspace-bound: a cached passing run from one project can no longer satisfy finalization in another (critical for non-git workspaces)
- Policy 21 documentation gate accepts only README.md and `docs/` changes; changeset fragments and other markdown no longer satisfy it
- Audit-trail and command-event tests now assert real behavior instead of unconditional `true`
