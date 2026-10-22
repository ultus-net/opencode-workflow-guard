# Static Policy Posture

Workflow Guard has three enforcement seats. Two of them live inside the plugin:

| Seat | Runs in | Removed by |
|---|---|---|
| `ctx.permission.hook("evaluate")` | the plugin | uninstalling or disabling the plugin |
| `execute.before` | the plugin | uninstalling or disabling the plugin |
| static configuration policies | the host | editing the config that carries them |

Static policies are the only layer a repository cannot lift. A project cannot
grant itself a permission the host denies in global config, because the host
resolves static policy before any plugin hook runs. That is the whole point of
this surface, and it is also why the plugin refuses to install it for you.

## Emit, do not install

```
opencode-workflow-guard policies --print
opencode-workflow-guard policies --print --format next
```

The command writes JSONC to stdout and nothing else. It refuses to run without
`--print`. A plugin that can write the configuration holding its own static
rails has moved those rails back inside the plugin, so the operator places the
block.

`--format 2.0` (default) emits the shape OpenCode 2.0.x reads. `--format next`
emits the documented newer shape. The invariants are identical. Only the
envelope differs:

| Format | Envelope | Rule action |
|---|---|---|
| `2.0` | `experimental.policies` | `permission` |
| `next` | top-level `policies` | `tool.use` |

The default is `2.0` because 2.0.x silently drops unknown top-level keys, so a
`next` block installed there looks applied and does nothing. Verified against
`@opencode/schema` 2.0.10: the `2.0` block decodes with all rules intact, and
the `next` block decodes to `policies: undefined`.

## What is emitted

| Rule | Action | Resource | Why |
|---|---|---|---|
| protected trunk push | `shell` | `git push * main`, `git push * master`, `git push * HEAD:main`, `git push * HEAD:master` | trunk must stay protected when the plugin is absent |
| live control plane write | `edit` | `~/.config/opencode/*`, `/etc/opencode/*`, `/Library/Application Support/opencode/*` | an agent that can edit the control plane can rewrite its own constraints |
| secret material read | `read` | `*/.ssh/*`, `*id_rsa*` | private keys should never enter a model context |
| external directory widening | `external_directory` | `*` | `external_directory` defaults to allow; denying it is what makes the write boundary a boundary |
| Code Mode surface | `execute` | `*` | removes the nested tool surface where the host asserts the action |

Every emitted rule is a denial. A posture that granted access would be a second,
weaker policy engine in a config file, and the plugin already owns that job.

Two of these are judgement calls rather than obvious wins, so drop them
deliberately if they conflict with normal work:

- `external_directory: *` denies every path outside the active project. Cross
  repository reads then require an explicit later `allow` rule. That is the
  strict posture, and it is the one the write-confinement work assumes.
- `execute: *` removes Code Mode. On 2.0.x the host never asserts an `execute`
  permission action, so the rule is inert there and Code Mode stays available.
  On hosts that do assert it, the rule removes a surface whose nested tool calls
  this guard does not evaluate. The plugin's read-only tool pruning and
  `execute.before` remain the coverage on 2.0.x.

## Precedence

Highest authority first:

| Authority | Source |
|---|---|
| 0 | managed preferences and Console policies |
| 2 | `OPENCODE_CONFIG_CONTENT` |
| 3 | `/etc/opencode` |
| 4 | `~/.config/opencode` |
| 5 | project `opencode.json(c)` |

Within one ruleset the last matching rule wins. Across documents the earlier
authority wins. Two consequences matter when you place the block:

1. Put it in the system or global config (authority 3 or 4), never in a project
   file. A project file is the scope the rules are meant to outrank.
2. If you add broad `allow` rules for local workflows, place these denies after
   them in the same file. A deny that lands earlier is shadowed.

On 2.0.x, the host builds its rule list by reversing the document order and
then taking the last match per resource, so a global document beats a project
document for the same resource. Verified in the 2.0.15 binary
(`opencode.config.policy`).

## Residual risk

Read this before treating the block as a sandbox.

- Policies do not sandbox plugin code. A plugin can still do anything the
  process can do.
- A process that can write the file carrying these rules can remove them. File
  ownership and permissions are the control there, not policy.
- Shell patterns match the whole command string. `cd /tmp && git push origin
  main` does not match `git push * main`, and neither does an exotic refspec
  spelled differently. The static floor covers the direct forms only. This gap
  is covered by a regression test, which asserts the evasion succeeds so the
  limit stays visible.
- A denied provider is blocked on the normal path only. Alternate paths are not
  covered by `provider.use` policies.
- Effect values are `allow` and `deny`. There is no `ask` at this seat, which is
  why the emitted rules deny rather than prompt.

## Acceptance status

The acceptance canary in the implementation plan installs the block into a
running host and confirms the denial message is `Blocked by configuration
policy` rather than a hook message.

**Status: NOT RUN.** Two reasons, both environmental:

- The canary needs a model turn to drive a tool call, and this environment has
  no configured provider.
- Placing the block requires writing a live control-plane config path, which the
  guard's own tamper policy refuses to let an agent do. That refusal is correct.

What was verified instead, on the installed 2.0.15 host:

- `@opencode/schema` 2.0.10 accepts the emitted `2.0` block with all rules
  intact, and drops the `next` block.
- The 2.0.15 binary carries the `opencode.config.policy` plugin, which reads
  `experimental.policies`, matches `<action>:<resource>` as a whole-string glob,
  and sets the message to the literal `Blocked by configuration policy`.
- The emitted resources match the intended commands under a replica of that
  matcher, asserted in `test/test.mts`.

To run the canary yourself, install the block into `~/.config/opencode`, then
attempt a denied action in a live session and confirm the message names
configuration policy rather than the plugin.
