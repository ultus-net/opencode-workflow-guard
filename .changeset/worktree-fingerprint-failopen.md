---
"opencode-workflow-guard": patch
---

Fix evidence freshness in worktrees containing untracked special files: `getGitWorktreeFingerprint` no longer voids on a single unreadable or unopenable untracked entry. Directory symlinks hash their link string (git semantics - re-pointing a link moves the fingerprint, changing the link target's contents does not), FIFOs/sockets hash path and mode, and unopenable files are skipped with a `worktree-fingerprint` entry naming them in the durable audit trail instead of returning `undefined` for the whole fingerprint. PR preflight now names the actual cause when an existing approval cannot be matched (missing fingerprint binding, fingerprint mismatch, or uncomputable fingerprint) instead of the misleading generic "review approval required".

Also changes the `.gitignore` pattern from `node_modules/` to `node_modules`: the directory-only pattern does not match a `node_modules` symlink (as created in isolated worktrees), which previously let `git add -A` stage it.
