# Acknowledgements & Ecosystem Inspirations

`opencode-workflow-guard` is built on original, clean-room TypeScript code, but draws design inspiration, best practices, and workflow ideas from the broader [OpenCode](https://opencode.ai) community and ecosystem:

## Community Projects & Inspirations

* **[`opencode-shell-strategy`](https://github.com/JRedeker/opencode-shell-strategy)** by [@JRedeker](https://github.com/JRedeker)  
  * Inspired the interactive TTY detection patterns in **Policy 22** (Non-Interactive Shell & TTY Hang Guard) to prevent subshell freezes on interactive prompts.

* **[`envsitter-guard`](https://github.com/boxpositron/envsitter-guard)** by [@boxpositron](https://github.com/boxpositron)  
  * Inspired the safe variable schema masking approach in **Policy 17** (Secret-File Read Block & Schema Masking) so agents can discover environment variable names without exposing live secret values.

* **[`opencode-snip`](https://github.com/VincentHardouin/opencode-snip)** by [@VincentHardouin](https://github.com/VincentHardouin)  
  * Inspired the token-efficient test output truncation and failure prioritization in **Policy 10** (Evidence-Based Verification).

* **[`changesets`](https://github.com/changesets/changesets)** by the [Changesets Team](https://github.com/changesets/changesets)  
  * For the fragment-based changelog and versioning model that prevents merge conflicts across parallel feature PRs.

* **[OpenCode Team at Anomaly](https://github.com/anomalyco/opencode)**  
  * For building the OpenCode terminal AI coding agent and its extensible plugin architecture (`@opencode-ai/plugin`).
