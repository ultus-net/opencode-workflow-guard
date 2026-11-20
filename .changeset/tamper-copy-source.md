---
"opencode-workflow-guard": patch
---

Policy 6 no longer treats a copy source under a config path as a settings mutation when no live control plane is declared. `cp`, `ln -s`, and `install` are judged by their destination operand, so `cp ~/.config/opencode/templates/x ./draft.md` is allowed. A guarded destination still blocks, including through `-t`, `--target-directory=`, and `install -d`. A hard link stays blocked because it is a second writable name for the guarded inode, so `ln` without `-s` and `cp -l`/`--link` keep the broad match. `mv` keeps the broad any-operand match because the move removes its source. A guarded destination written after an fd duplication (`2>&1`) is now blocked as well; the duplication no longer splits the command into a fragment the guard does not read.
