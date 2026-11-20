# RSI loop playbook

The operating manual for the `/rsi-loop` and `/rsi-campaign` commands, and the
repo-local grounding those commands read first. The top half is the scaffold
template; the anchors at the bottom are this repository's own pain points,
verifier, and metric.

## Before the first iteration

The loop depends on three artifacts in this repo. Create any missing one from
`~/.config/opencode/templates/rsi/` before running an iteration:

- `docs/agents/rsi-loop-playbook.md` — this file.
- `docs/agents/ledger.md` — the create-only experiment ledger.
- `docs/agents/lessons.md` and `docs/agents/lessons/` — the lesson memory.

## The base loop

One iteration maps to one branch and one PR:

1. **PROPOSE** — pick one minimal candidate change. Read the actual code first;
   cite the files you read in the proposal.
2. **PREDICT** — before editing, register a falsifiable claim: expected effect
   on the metric, how it will be verified, and at-risk regressions.
3. **IMPLEMENT** — delegate mechanical work to an `executor` subagent with a
   full spec (inputs, constraints, acceptance command). Keep the diff minimal.
   Start on the cheap tier; escalate only on an observable trigger.
4. **EVALUATE** — run the external verifier only; self-review is not evidence.
   Change one causal axis per iteration.
5. **SELECT** — regularize selection: anneal the edit budget, screen proposals
   for benchmark-specific trickery, prune stale or too-small edits, and advance
   the incumbent only on a minimum effect size. Delegate a fresh-eyes check to
   a `reviewer` subagent. Archive rejected attempts with their failure evidence.
6. **REMEMBER** — write one lesson file under `docs/agents/lessons/`, and append
   one structured record to `docs/agents/ledger.md`. Write it either way; a
   negative result is data.

## Hard rules

- Never edit tests, the verifier, baselines, or run logs to make a change pass.
- Live settings changes go through a sanctioned installer, never a direct edit.
- A negative result is a valid result: log it and stop.

## Multi-iteration campaigns

`/rsi-loop` runs one iteration. `/rsi-campaign` runs a bounded batch (3-5
iterations) in one session with explicit stop brakes and subagent fan-out: it
builds a diversity-tagged candidate set before iterating, enforces no-gain and
same-type stop brakes, and isolates overlapping edits in git worktrees. Each
iteration still maps to one branch and one PR.

## Anchors for this repository

- **verifier** — `npm run typecheck && npm test` in the repository root. Both
  are deterministic: strict TypeScript compilation, then the in-memory
  adversarial harness in `test/test.mts`. `npm run test:install` is the heavier
  package and loader check, reserved for a change that touches the entrypoint.
- **metric** — false-positive policy blocks. The counterfactual is a command an
  agent legitimately issues, or a legitimate lifecycle update, that a policy
  refuses. The observable proxy is the block count per policy code in the audit
  journal (`~/.local/state/opencode/workflow-guard/workflow-guard.jsonl`,
  `decision: "block"`), paired with a regression case that fails before the fix
  and passes after it. A fix that lowers the block count while removing a real
  detection is a loss, not a gain, so every candidate ships both directions:
  the now-allowed false positive, and a still-blocked true positive.
- **noise floor** — the journal accumulates across sessions and machines, so a
  raw count is not comparable between runs. Every iteration therefore scores
  against a frozen snapshot of the journal and a frozen subset of commands
  quoted in its own block-reason strings, not against a live count.
- **frozen ruler** — the audit journal is read-only evidence. No iteration
  edits, truncates, or regenerates it, and no iteration edits `test/test.mts`
  assertions to make a case pass. The ruler is the historical journal plus the
  policy code at `origin/main`.
- **spirit** — this plugin is a defence-in-depth deterrent against forgetful or
  prompt-injected agents, not a sandbox. A candidate that removes a detection
  class instead of a false positive is rejected, even when the suite stays
  green.
