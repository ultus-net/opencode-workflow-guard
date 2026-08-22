---
"opencode-workflow-guard": minor
---

Integrate Changesets (@changesets/cli) for fragment-based changelog and version management:
- Policy 3 now accepts `.changeset/*.md` diffs in addition to `CHANGELOG.md` and PR body `Changelog:` sections
- CI changelog check accepts `.changeset/*.md` fragment files to prevent merge conflicts between parallel PRs
- Added `package.json` scripts: `changeset` and `version-packages`
