---
"opencode-workflow-guard": patch
---

Let the agent finish the cleanup a merged PR requires. `git branch -d <branch>` and `git branch --delete <branch>` are now permitted while the checkout sits on the protected branch, and a remote branch already merged into the remote default can be deleted with `git push <remote> --delete <branch>` or a `:<branch>` refspec.

Both halves used to be blocked, so every merge ended with the operator running two commands by hand. The exemption stays narrow. Git refuses `-d` unless the branch is fully merged, so the deletion cannot drop an unreviewed commit. `git branch -D`, a forced refspec, `--prune`, `--mirror`, a protected branch name, an unmerged branch, and any fully-qualified refspec outside `refs/heads/` all stay blocked. Remote deletion resolves the branch through `refs/heads/<branch>` or `refs/remotes/origin/<branch>` explicitly, so a tag that shares the name cannot satisfy the merged check.
