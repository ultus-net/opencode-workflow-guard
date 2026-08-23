---
"opencode-workflow-guard": patch
---

**GitHub Releases now created on publish.** The Release workflow passes `createGithubReleases: true` to `@changesets/action`, so each merged version PR publishes to npm, pushes the git tag, and opens the matching GitHub Release automatically. Previously npm publishes succeeded (1.2.1, 1.3.0) but tags/Releases were only created locally on the CI runner and never pushed, leaving the GitHub Releases page stale at v1.1.5. Those two versions still need a one-time manual `gh release create` backfill.
