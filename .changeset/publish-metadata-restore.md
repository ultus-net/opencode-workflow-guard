---
"opencode-workflow-guard": patch
---

**Publish pipeline fix.** Restored the `repository` field in `package.json` (accidentally dropped during a merge-conflict resolution), which npm OIDC trusted publishing requires for sigstore provenance verification. Also added a release-CI step that validates publish-critical package metadata (`repository.url`, `main`, `files`) and runs `npm pack --dry-run` before changesets contacts the registry, so this class of failure fails fast in CI instead of at publish time.
