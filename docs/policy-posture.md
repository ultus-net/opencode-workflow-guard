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
opencode-workflow-guard policies --print --format 2.0
opencode-workflow-guard policies --print --format next
```

The command writes JSONC to stdout and nothing else. It refuses to run without
`--print`. A plugin that can write the configuration holding its own static
rails has moved those rails back inside the plugin, so the operator places the
block.

The default is `both`, which emits each rule under the key its host reads:

| Format | Envelope | Rule action | Host that reads it |
|---|---|---|---|
| `both` (default) | `experimental.policies` and top-level `policies` | `permission` and `tool.use` | 2.0.x and 2.1.x |
| `2.0` | `experimental.policies` | `permission` | 2.0.x only |
| `next` | top-level `policies` | `tool.use` | 2.1.x only |

The envelopes are not interchangeable, and neither host warns about the one it
does not read. OpenCode 2.0.x evaluates `experimental.policies` with
`action === "permission"` and ignores a top-level `policies` array entirely.
OpenCode 2.1.x evaluates the top-level `policies` array with
`action === "tool.use"` and ignores `experimental.policies`. A single-key block
therefore looks applied on the other host and enforces nothing.

Both hosts read only their own key, so carrying both cannot double-apply a rule
or make them conflict. `--format 2.0` and `--format next` exist for a pinned
host. `both` is the default, because the silent no-op is the failure this
surface exists to prevent.

Schema acceptance is not runtime acceptance. `@opencode/schema` 2.0.10 admits a
top-level `policies` array that the 2.0.15 runtime never reads, so a decode test
grades the block as valid while the host enforces nothing. The envelope table
above is verified by live denial canaries on both hosts, in the acceptance
section below.

## What is emitted

| Rule | Action | Resource | Why |
|---|---|---|---|
| protected trunk push | `shell` | `git push * main`, `git push * master`, `git push * HEAD:main`, `git push * HEAD:master` | trunk must stay protected when the plugin is absent |
| live control plane write | `edit` | `*/.config/opencode/*`, `/etc/opencode/*`, `/Library/Application Support/opencode/*` | an agent that can edit the control plane can rewrite its own constraints |
| secret material read | `read` | `*/.ssh/*`, `*id_rsa*` | private keys should never enter a model context |
| external directory widening | `external_directory` | `*` | `external_directory` defaults to allow; denying it is what makes the write boundary a boundary |
| Code Mode surface | `execute` | `*` | removes the nested tool surface where the host asserts the action |

Every emitted rule is a denial. A posture that granted access would be a second,
weaker policy engine in a config file, and the plugin already owns that job.

The control-plane rule starts with `*/` rather than `~/` on purpose: 2.0.x
expands `~` and `$HOME` only for the `permissions` key, not for
`experimental.policies`, so a tilde resource would never match an absolute path.
`*/.config/opencode/*` is version-independent and covers every home directory.

Two of these are judgement calls rather than obvious wins, so drop them
deliberately if they conflict with normal work:

- `external_directory: *` denies every path outside the active project. Cross
  repository reads then require an explicit later `allow` rule. That is the
  strict posture, and it is the one the write-confinement work assumes.
- `execute: *` removes Code Mode. The qualified hosts (2.0.15 and 2.1.3)
  register no `execute` tool and never assert an `execute` permission action,
  so the rule is inert on both and Code Mode stays available. On a host that
  does assert the action, the rule removes a surface whose nested tool calls
  this guard does not evaluate. The plugin's read-only tool pruning and
  `execute.before` remain the coverage today.

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

**Status: RUN.** The canary installs the emitted block into an isolated project
config and drives a real model turn that calls the denied tool. It is run once
per host.

| Host | Emitted block | Probed rule | Result |
|---|---|---|---|
| 2.0.15 | `--format 2.0` | `shell:printf*` | `Blocked by configuration policy` |
| 2.1.3 | `--format 2.0` | `shell:printf*` | **executed** (silent no-op) |
| 2.0.15 | `--format next` | `shell:printf*` | **executed** (silent no-op) |
| 2.1.3 | `--format next` | `shell:printf*` | `Blocked by configuration policy` |
| 2.0.15 | default (`both`) | `read:*id_rsa*` | `Blocked by configuration policy` |
| 2.1.3 | default (`both`) | `read:*id_rsa*` | `Blocked by configuration policy` |

The two silent no-ops are the defect this section exists to prevent, and they
are why the default emits both envelopes. A single-key block is not merely
unverified on the other host. It is actively misleading there, because the
config loads and reports no error.

Two limits on the canary, so nobody over-reads it:

- The `write` tool is gated by the `edit` permission action on 2.1.3 but not on
  2.0.15, so a `write` canary would not have proved the `edit` rule on both.
  The `read` rule was chosen for the cross-host proof because both hosts map it
  identically.
- The `execute` invariant stays inert on both qualified hosts, because neither
  registers an `execute` tool. Its canary cannot pass until a host asserts the
  action, and the rule is documented as inert rather than claimed as coverage.

Placing the block in a live control-plane path stays out of scope for an agent:
the tamper policy refuses that write, and that refusal is correct. The canary
uses an isolated project config instead, which exercises the same evaluator.

The emitted resources are also asserted against a replica of the host matcher in
`test/test.mts`, and both envelopes are required to reach the same verdict for
every probed resource.

To run the canary yourself, install the block into `~/.config/opencode`, then
attempt a denied action in a live session and confirm the message names
configuration policy rather than the plugin. Use the default (`both`) envelope
unless you have pinned the host, and check the result on the host you actually
run.
