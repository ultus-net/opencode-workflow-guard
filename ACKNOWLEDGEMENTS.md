# Acknowledgements & Ecosystem Inspirations

`opencode-workflow-guard` is built on original, clean-room TypeScript code, but draws design inspiration, best practices, and workflow ideas from the broader [OpenCode](https://opencode.ai) community and ecosystem:

## Community Projects & Inspirations

* **[`opencode-shell-strategy`](https://github.com/JRedeker/opencode-shell-strategy)** by [@JRedeker](https://github.com/JRedeker)  
  * Inspired the interactive TTY detection patterns in **Policy 22** (Non-Interactive Shell & TTY Hang Guard) to prevent subshell freezes on interactive prompts.

* **[`envsitter-guard`](https://github.com/boxpositron/envsitter-guard)** by [@boxpositron](https://github.com/boxpositron)  
  * Inspired the safe variable schema masking approach in **Policy 17** (Secret-File Read Block & Schema Masking) so agents can discover environment variable names without exposing live secret values.

* **[`opencode-snip`](https://github.com/VincentHardouin/opencode-snip)** by [@VincentHardouin](https://github.com/VincentHardouin)  
  * Inspired the token-efficient test output truncation and failure prioritization in **Policy 10** (Evidence-Based Verification).

* **[`opencode-worktree`](https://github.com/kdcokenny/opencode-worktree)** by [@kdcokenny](https://github.com/kdcokenny)  
  * Inspired the isolated-worktree development workflow behind the **`guard_worktree_create` / `guard_worktree_cleanup`** tools (snapshot-commit before removal, `node_modules` sharing, storage outside the repository), re-implemented here as native in-process tools with zero external dependencies.

* **[`changesets`](https://github.com/changesets/changesets)** by the [Changesets Team](https://github.com/changesets/changesets)  
  * For the fragment-based changelog and versioning model that prevents merge conflicts across parallel feature PRs.

* **[`oh-my-pi`](https://github.com/can1357/oh-my-pi)** by [@can1357](https://github.com/can1357), **`omp-guardrails`** by [@breathi3552](https://github.com/breathi3552), **`agentsflow`** by [@xzhang17](https://github.com/xzhang17), **`tools`** by [@marcelsud](https://github.com/marcelsud), and the **Claude Code** security hook community  
  * Inspired the hardened shell wrapper tokenization/normalization in **`unwrapShellWords`**, multi-ecosystem verification detection in **Policy 10**, structured severity ranking (P0-P3 blocker gate) for the secondary review rubric in **Policy 19 / `guard_review_rubric`**, disk wipe, reverse shell & system permission signatures in **Policy 4**, lockfile synchronization checks in **Policy 3**, and subagent read-only role confinement & mutation budgets in **Policy 1**.

* **[OpenCode Team at Anomaly](https://github.com/anomalyco/opencode)**  
  * For building the OpenCode terminal AI coding agent and its extensible plugin architecture (`@opencode-ai/plugin`).
