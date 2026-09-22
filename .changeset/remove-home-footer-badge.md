---
"opencode-workflow-guard": patch
---

TUI companion: drop the duplicate home-footer badge on OpenCode 2

The V2 companion claimed both `home.footer.status` and `prompt.footer.status`,
and OpenCode 2 mounts both footers on the home screen, so the
`Workflow Guard 🛡️` badge rendered twice there (once in the prompt footer row
next to the location path, once in the bottom status bar next to the version).
The companion now claims only `prompt.footer.status`, which is mounted on every
screen (home and session composers), so the badge renders exactly once; the
home footer bar returns to its builtin contents (MCP/plugin indicators,
version).
