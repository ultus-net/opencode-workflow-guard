---
"opencode-workflow-guard": patch
---

Policy 6 no longer treats a copy source under a config path as a settings mutation when no live control plane is declared. `cp`, `ln`, and `install` are judged by their destination operand, so `cp ~/.config/opencode/templates/x ./draft.md` is allowed. A guarded destination still blocks, including through `-t`, `--target-directory=`, and `install -d`. `mv` keeps the broad any-operand match because the move removes its source.
