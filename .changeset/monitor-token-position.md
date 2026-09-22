---
"opencode-workflow-guard": patch
---

Interactive monitor detection now only flags a monitor in command position, so a monitor name used as an argument no longer blocks a benign command. The detector matched `top`/`htop`/`btop`/`atop`/`glances` anywhere as a whitespace-delimited token, so `az keyvault secret show --vault-name x --name top` (observed live in the device audit) and `echo top` were rejected as an "interactive process monitor".

It now unwraps shell wrappers (`sudo`, `env`, `timeout`, `command`, …), splits quote-aware, and checks each segment's executable: `top`, `htop`, `… | top`, `sudo top`, `timeout 5 top`, `busybox top`, `eval top`, and `sh -c top` are still blocked, while `az … --name top`, `echo top`, `ls top-level-dir`, `top -b`, and `sh -c '… top …'` quoting stay allowed. `top`'s batch-mode exemption is scoped to its own arguments so `sudo -b top` is not mistaken for batch mode. Indirection this does not model (`watch`/`xargs`/`man`, `find -exec`/`su -c`, and shell loop bodies such as `while true; do top; done`) is a known limitation, documented in the policy doc alongside the existing "pager names in arguments are not execution" rule.
