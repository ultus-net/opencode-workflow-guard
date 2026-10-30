---
"opencode-workflow-guard": minor
---

feat: opt-in pre-deployment dogfood gate (Policy 27)

Gates PR creation on a recorded run of the change on real hardware. Off by
default, so no existing repository changes behavior.

- `record_dogfood` records a run as `dogfood` evidence bound to the workspace,
  commit hash, and tracked-content worktree fingerprint. A tracked edit or new
  commit after the run makes the evidence stale.
- Only a `pass` is durable. A `hold` stays diagnosable in memory with its
  taxonomy class and never becomes evidence. Recording a `hold` also discards
  that host's cached passes, so a process restart cannot re-open the gate on an
  older green run.
- A `pass` requires every check row to be `pass` and at least one check row
  to exist, so the gate cannot be satisfied by a skipped check or by an empty
  observation. A `hold` must name a taxonomy class.
- `requireDogfood` and `dogfoodDeployMatrix` (or `WORKFLOW_GUARD_REQUIRE_DOGFOOD`
  and `WORKFLOW_GUARD_DOGFOOD_DEPLOY_MATRIX`) enable the gate and declare the
  host labels that each need a passing run. Retention is per host, so repeated
  runs on one host cannot evict another host's only pass.
- `WORKFLOW_GUARD_DOGFOOD_ACTOR`/`WORKFLOW_GUARD_DOGFOOD_DEPTH` mark a session
  spawned by a repository runner. Every policy still applies there, and the
  marker only refuses `record_dogfood`, so a tested session cannot certify
  itself.
- `guard_status` reports `lastDogfood` and adds `dogfood` to
  `outstandingRequirements` when the gate is unsatisfied.
