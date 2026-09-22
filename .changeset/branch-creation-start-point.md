---
"opencode-workflow-guard": patch
---

Branch creation freshness gate honors explicit fresh start points

`git switch -c <name> origin/main` (and `git checkout -b <name> origin/main`)
no longer fails when the current branch is behind the remote default: a start
point that already contains `origin/HEAD` makes the new branch fresh by
construction, so the HEAD-based staleness check does not apply to it.
Classifiable start points are the literal ref or SHA operand of the creation
flag (including `-c<name>`-style attached forms and valueless flags around
them); variables, quoted or otherwise indeterminate tokens, and unknown or
value-taking flags fail closed to the previous check. Creations without a
start point are unchanged.

Block reasons now name what was actually checked — the current branch and its
distance from the remote default — and remedies that work under the guard
(rebase or ff-merge the branch, or branch from the remote default directly),
instead of suggesting `git pull` on main, which does not address a stale
non-main branch and previously kept the block in place even after the local
`main` ref was updated.
