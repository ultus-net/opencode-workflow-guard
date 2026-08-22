---
"opencode-workflow-guard": minor
---

Implement Policy 22 (Non-Interactive Shell & TTY Hang Guard) and Native Desktop Notifications:
- **Policy 22:** Deterministically blocks interactive text editors (`nano`, `vim`), pagers (`less`), process monitors (`top`), `sudo`, and package manager invocations lacking non-interactive flags (`npm init` / `apt-get` without `-y`) to prevent subshell freezes.
- **Native OS Desktop Notifications:** Non-blocking notification dispatch (`notify-send` / `osascript`) on blocked actions and verification completions.
- **CI & Package Audit:** Updated dependency tree and validated `npm audit` passing at high security threshold.
