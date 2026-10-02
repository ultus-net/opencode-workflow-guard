---
"opencode-workflow-guard": patch
---

Settings tamper now flags `patch` and `perl -i` / `perl -pi` in-place editors when their target is protected OpenCode config (`opencode.json`, `.config/opencode/**`, `.opencode/**`). Previously `V_LIST` in `src/policies/tamper.ts` omitted these verbs, so they could rewrite guarded settings without tripping the tamper policy. Regression tests cover the blocked targets and the allowed normal-file cases.
