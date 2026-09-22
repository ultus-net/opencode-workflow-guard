---
"opencode-workflow-guard": patch
---

Scratch-directory cause attribution: `/tmp/opencode` is the OpenCode environment's designated agent scratch space, but the workspace boundary is workspace-absolute and does not cover it, so writes there stay blocked. Block messages for targets under it (edit/write, apply_patch, and shell mutations) now name the directory and point to the remedy — write scratch as an untracked file inside the workspace instead of outside it — instead of the generic escape message that read as a guard bug (six of the device audit's boundary blocks were this class). The enforcement decision is unchanged.
