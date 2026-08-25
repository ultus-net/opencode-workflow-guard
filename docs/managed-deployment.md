# Managed Deployment

For organization-managed installations, deploy workflow-guard together with OpenCode's administrator-controlled managed configuration. Keep controls already enforced by OpenCode, such as provider allowlists and tool permissions, in managed OpenCode settings. Keep workflow invariants such as protected-branch, verification, review, and workspace-boundary checks in workflow-guard rather than duplicating OpenCode's configuration precedence.

As documented by OpenCode, managed configuration has the highest configuration precedence. Place `opencode.json` or `opencode.jsonc` in `/etc/opencode/` on Linux, `/Library/Application Support/opencode/` on macOS, or `%ProgramData%\opencode` on Windows. macOS can additionally use the `ai.opencode.managed` preference domain through MDM. Verify the resolved host configuration with `opencode debug config`.

A typical managed configuration should restrict organization-level capabilities, for example with `enabled_providers`, `disabled_providers`, `experimental.policies`, and `permission`. Install workflow-guard through your controlled OpenCode distribution or configuration alongside those settings, and pin/review the package version according to your normal software-supply-chain process.

At startup workflow-guard writes an informational app-log diagnostic stating whether a file-based managed configuration was detected at the platform's standard location. This is observational only. OpenCode's V1 plugin API does not provide a supported provenance/trust signal proving that workflow-guard itself came from an administrator-controlled source, and managed configuration precedence does not prove that untrusted project plugins cannot also run.

Reference: https://opencode.ai/docs/config/#managed-settings (retrieved August 25, 2026).
