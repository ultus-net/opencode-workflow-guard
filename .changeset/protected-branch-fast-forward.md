---
"opencode-workflow-guard": patch
---

Allow a stale protected checkout to sync. `git merge --ff-only [<ref>]`, `git rebase <ref>`, and `git pull --ff-only` are now permitted on `main`/`master` when the target is the branch's tracked upstream or the remote default and `HEAD` is already an ancestor of it, so the sync adds no commit and rewrites none.

A protected branch with no safe sync path was the defect: every remote refresh was refused with "create a feature branch first", which left the primary checkout permanently stale. The exemption stays narrow. `git merge` without `--ff-only`, a bare `git pull`, a local branch target, a different remote branch, a named remote and branch, and a diverged branch all stay blocked.

An unqualified `git pull` on a protected branch is now a blocked history write rather than an unclassified command, because with `pull.rebase` set it replays local commits. The permission seat defers any `pull` to `execute.before`, since whether the checkout is protected is a fact the seat cannot see.
