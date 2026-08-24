---
"opencode-workflow-guard": patch
---

Harden workspace boundary mutator scanning, review fingerprinting, and OpenCode 1.18.21 package entrypoints:

- Expose native `./server` and `./tui` package entrypoints in `package.json`, removing the ambiguous `./ui` export that npm parsed as GitHub shorthand.
- Add `dd of=` and `truncate` to recognized workspace file mutations under Policy 8.
- Scan every destination in multi-redirection commands rather than only the first redirect match.
- Preserve TTY hang protections for interactive monitors while permitting batch top commands (`top -b -n 1`, `top --batch`), matching monitor tokens on command boundaries to avoid false positives on unrelated words.
- Bind secondary review approvals to worktree SHA-256 diff fingerprints covering staged, unstaged, and untracked file content.
- Clarify command-level guardrails vs OS kernel sandboxing in documentation.
