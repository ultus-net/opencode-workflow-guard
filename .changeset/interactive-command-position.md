---
"opencode-workflow-guard": patch
---

Policy 22 now judges every interactive-command pattern at command position, matching how monitors and pagers already worked. An editor name, `sudo`, `git rebase -i`, `git add -p`, or an unconfirmed `npm init` / apt / yum install that appears only as an argument is data, so `grep -n 'sudo'`, `grep -n 'git rebase -i'`, and `printf "%s" "vim is not installed"` are allowed. The commands themselves still block, including behind wrappers (`env FOO=1 sudo ls`, `timeout 5 sudo ls`), in a control-flow body (`while true; do sudo ls; done`, `then apt-get install curl`), through `eval`, through `sh -c`, and via `busybox`. A `sudo` wrapper is reported by the shell unwrapper, because unwrapping removes it before the command word. A command name delivered to a shell as stdin data (`echo 'vim x' | sh`) is a documented limitation.
