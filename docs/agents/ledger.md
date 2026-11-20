# RSI experiment ledger

Structured, create-only record of every base-loop attempt, accepted or
rejected. One record per iteration; append only. Never edit or delete a prior
record: a negative result is data, not clutter.

## Schema (one block per iteration)

```text
n · date (UTC) · hypothesis (falsifiable) · trace evidence · code change ·
commit SHA + git tree · artifact name + checksum · exact command/config ·
test results · eval job path · score · gains · losses · exceptions ·
token/cost/duration · interpretation · keep/revert · next hypothesis
```

Schema v2 adds two fields, required on every new record:

```text
selection score (n items) · held-out score (n items, never used for selection)
· prev-chain: sha256:<hex of the preceding record block>
```

`selection score` is the score on the items the loop selected against.
`held-out score` is the score on a disjoint item set never used for
selection. Report both (winner's curse). `prev-chain` links each record to
the sha256 of the prior record block so the create-only rule is
tamper-evident (hash-chained admission).

## Rules

- Append only. One block per iteration. No rewrites, renumbering, or deletes.
- Report `selection score` and `held-out score` side by side; a `keep`
  requires a non-empty `held-out score`. Held-out items are never reused for
  selection.
- `prev-chain` is the sha256 of the preceding record block.
- Record failures with the same care as successes; an empty failures column
  is a smell, not a clean run.
- Name idiosyncratic infrastructure/verifier constraints explicitly, so a
  later reader does not re-derive them.
- Every `keep` cites the eval run that justified it; every `revert` keeps the
  failure evidence and the next hypothesis.
- A record is written by the base loop, not a subagent.

## Records

<!-- append blocks below this line, newest last -->

### n=1 — campaign scaffolding (docs, preregistered 2026-11-21)

- **hypothesis (falsifiable, registered before the edit):** this repository has
  no `docs/agents/rsi-loop-playbook.md` and no `docs/agents/ledger.md`, so a
  campaign run here has no grounding and nowhere to append. `docs/agents/lessons.md`
  and `docs/agents/lessons/` already exist from earlier loops (LL-001 onwards),
  so two of the three anchors are missing. Falsified if either file already
  exists at `origin/main`.

- **prediction (expected gain):** both files created from
  `~/.config/opencode/templates/rsi/`, with the playbook's placeholder anchors
  replaced by this repository's real verifier (`npm run typecheck && npm test`),
  metric (false-positive policy blocks against a frozen journal snapshot), and
  frozen ruler (the audit journal is read-only evidence). **at-risk
  regressions:** none; both are new and no gate reads them. **non-goals:** no
  change to the existing lesson corpus, no new policy, no change to `src/`.

- **accept/reject rule:** accept if both files exist, the playbook names the
  real verifier, and `git status` shows additions only.

- **selection score (2 items, deterministic):** (a) both files are absent at
  `origin/main`, confirmed with `git ls-tree origin/main docs/agents/`; (b) the
  template sources exist and are readable.

- **held-out score:** 2/2 passed (2 items, never used for selection): the
  pre-existing `docs/agents/lessons.md` still parses as an index, and
  `docs/agents/lessons/` still holds its 7 lesson files. Neither was used to
  choose or shape the scaffold.

- **disjointness:** the held-out set is the pre-existing lesson corpus. It reads
  neither the playbook nor the ledger, and neither was used for selection.

- **eval job path:** none. A file-existence and content check, with no
  model-scored eval, so the matched-budget test-time-scaling control does not
  apply (deterministic verifier, per the playbook anchors).

- **result (appended after the acceptance run):** GAIN. Both files created in
  the campaign worktree; the playbook's anchors name `npm run typecheck && npm
  test`, the block-count proxy, and the read-only journal. The lesson corpus is
  untouched. **keep/revert:** keep.

- **next hypothesis:** the plugin's own telemetry has never been read as a
  first-class input. The audit journal holds 10,395 records with 249 block
  decisions, and the block reasons carry enough text to reconstruct the command
  shape even though bodies are redacted. Mining it should expose false positives
  the suite cannot, because the suite only encodes shapes someone already
  imagined.

- prev-chain: sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855

### n=2 — campaign candidate set and idea-level screening (instrument, preregistered 2026-11-21)

- **hypothesis (falsifiable, registered before any evaluation):** this
  campaign's premise is that the guard's telemetry names false positives worth
  fixing. The audit journal at
  `~/.local/state/opencode/workflow-guard/workflow-guard.jsonl` holds 10,395
  records: 9,978 allows, 249 blocks, 168 abstains. Command bodies are redacted
  by design (byte count plus sha256), so the reconstructable evidence is the
  policy code, the block-reason string, and the tool. Falsified if the reasons
  name no legitimate command shape.

- **trace evidence (the frozen ruler for this campaign):** block counts by
  policy code: `stale-write/stale_write` 26,
  `shell-safety/dynamic_shell_syntax` 26, `todo/todo_lifecycle` 18,
  `boundary/workspace_escape` 16, `git/protected_branch` 14,
  `boundary/shell_mutation` 9, `pr-preflight/pr_preflight_failed` 8,
  `todo/no_active_todo` 7, `todo/todo_completion_unverified` 7,
  `destructive/live_mutation` 7, `shell-safety/interactive_tty` 5, and a long
  tail of 1-3. 85 of the 249 are `workspace.binding` /
  `workspace_rebind_refused` journal events, which are observations rather than
  tool blocks. Repeated identical blocked payloads isolate the friction loops:
  `todo_lifecycle` on `todowrite` appears 7, 7 and 6 times in single sessions.
  The `interactive_tty` reasons include
  `command -v unshare fakeroot sudo systemd-tmpfiles getent; id` and a
  `git commit -m` message, both refused as "sudo with password prompt". The
  `todo_lifecycle` reasons show text refinement read as deletion, for example
  `'Verify the doc change and open its PR'` then
  `'Verify the doc change, pass review, and open its PR'`. Live reproduction
  during this campaign added a fourth class: any backtick in a shell command is
  refused as command substitution, so a Markdown payload written through a
  quoted heredoc cannot be written at all.

- **candidate set (built before iterating, one hypothesis each, with the
  change-type the selection phase checks for diversity):**
  - **C1 [gate]** `src/policies/shell-safety.ts:47-83` applies
    `INTERACTIVE_COMMAND_PATTERNS` with `regex.test(WHOLE_COMMAND)`, so an
    editor name, `sudo`, `npm init`, `apt` or `yum` anywhere in the text blocks
    the call, while monitors and pagers already resolve command position
    (`containsMonitorCommand` line 97, `containsPagerCommand` line 126).
  - **C2 [gate]** `src/policies/todo.ts:312-372` matches task identity by exact
    normalized text, so sharpening an in-progress task's wording reads as a
    silent deletion and blocks the whole `todowrite`.
  - **C3 [routing]** `src/lib/state.ts:292-330` binds a session to its creation
    directory on the first host announcement, so the session's own first
    tool-call context (`registerSessionWorkspaceFromToolCall`, line 211) can
    never bind and is journaled as a refused widening.
  - **C4 [security]** the tamper policy treats any mention of
    `~/.config/opencode/*` in a shell command as a write, so a `cp` from
    `~/.config/opencode/templates/rsi/` into a workspace file is refused as
    tampering, although reading the same path is explicitly allowed and
    Policy 6 already sanctions copying *from* a config path.
  - **C5 [instrument]** 85 of the 249 `decision:"block"` records are
    journal-only boundary observations, so a naive block count overstates
    policy blocks by 34%.
  - **C6 [gate] (considered, then deferred, not denied on merit):** a redirect
    to `/dev/null` is boundary-refused (`curl output to '/dev/null' targets a
    path outside the workspace`) although three code paths already treat it as
    a sink for observation seeding (`workflow-guard.ts:574`,
    `src/lib/v2-plugin.ts:394`, `boundary.ts:241`).

- **screening (idea level, before evaluation budget):** the `screener`
  subagent ranked C2 > C1 > C4 and denied C3 and C5. Its C5 reason holds: an
  audit-schema change moves the column but a naive reader still counts the same
  rows, so it fixes no decision. Its C3 reason does not hold: it declined to
  read `src/lib/state.ts` and denied on "unverified line numbers", while the
  function, its binding behaviour and the 85 journaled refusals are all present
  in the evidence above. The deny is recorded as-is rather than silently
  reversed, and C3 is archived for a later campaign with a narrower brief.

- **appraisal against the two bounds (HSI, 2608.08466):** all retained
  candidates have an informative signal (a named command shape or lifecycle
  update, plus a block code) and none asks the frozen model to exceed its
  ceiling; each is a deterministic classifier change with a regression case.
  C2 and C1 clear both bounds. C4's feedback is thinner (one journal record,
  one live reproduction) but its signal is exact. C6 was deferred on the RRSI
  pruner's "too small" rule (2609.24972), not on evidence.

- **selection decision (archive, not lineage, per 2505.22954 and 2609.26457):**
  iteration order is **C2 (gate), C4 (security), C1 (gate)**. That order obeys
  the diversity brake (no two consecutive iterations of one change-type) while
  spending the first iteration on the candidate with the most durable evidence
  and the clearest spirit argument: the rule exists to stop dropped work, not
  to forbid sharper wording. The rejected and deferred candidates stay above,
  graded, so a later campaign can re-open one without re-deriving the evidence.

- **selection score (5 items, deterministic):** (a) C2 has 18 journal records
  and three retry loops of 7, 7 and 6; (b) C2's fix generalizes an existing
  carve-out at `todo.ts:326-357` rather than inventing a mechanism; (c) C1 is
  live-reproduced twice in this campaign and reuses `unwrapShellWords`; (d) C4
  is live-reproduced once; (e) each candidate is a single source file plus
  tests and docs, inside the annealed edit budget.

- **held-out score:** pending, scored at each iteration's evaluation (2 items,
  never used for selection): the repository's own suite (`npm run typecheck &&
  npm test`) and an independent probe bank written at evaluation time.

- **disjointness:** the selection items are journal records from past sessions'
  command shapes. The held-out items are the deterministic suite plus fresh
  probes invented after the fix. Held-out items are never used for selection.

- **eval job path:** none. Deterministic verifier, no model in the scoring loop,
  so the matched-budget control and the answer-rescue audit do not apply
  (2607.12227, 2610.05533).

- **result:** the candidate set is built, screened and archived; the campaign
  proceeds with C2.

- **next hypothesis:** if C2 lands, the same replacement-by-refinement question
  recurs for `[read-only]` marker stripping and for duplicate-text matching,
  the other two places task identity is normalized.

- prev-chain: sha256:c7f964d3dd285f1d02eba1ccd0ee200ec8dcca8b94d05d0b03d5f81403aad669

### n=3 — a reworded active task is a refinement, not a silent deletion (gate, preregistered 2026-11-21)

- **hypothesis (falsifiable, registered before the edit):** `validateTodoLifecycle`
  (`src/policies/todo.ts:312-372`) decides task identity with exact normalized
  text (`todoTaskKey`, line 117). An agent that sharpens an in-progress task's
  wording therefore loses the old key, the function reports the old task as
  "removed without being marked completed or cancelled", and the whole
  `todowrite` is refused. Falsified if the journal's `todo_lifecycle` records
  show no text refinement, or if a refinement already passes today.

- **pre-change probe (recorded before the edit):** the journal holds 18
  `todo/todo_lifecycle` blocks. Three sessions repeat the identical payload 7,
  7 and 6 times. The reason strings name refinement pairs, not dropped work:
  `'Verify the doc change and open its PR'` then `'Verify the doc change, pass
  review, and open its PR'`; `'Push the branch, open PR #245 with Fixes #245'`
  then `'Push the branch, open PR for #245 with Fixes #245'`; `'Open PR for
  issue #42 and clean up the branch'` then `'Re-run review, record verdict, open
  PR for issue #42 and clean up the branch'`. In every pair the removed text's
  tokens are a subset of the retained text's tokens. The code already accepts
  one replacement shape for this reason: the review-obligation carve-out at
  line 326-357, and `todoTaskKey` already strips the `[read-only]` annotation
  because "the marker is an annotation about a task, not part of which task it
  is" (line 108-116).

- **prediction (expected gain):** a removed active task is treated as refined,
  not deleted, when an unclaimed active task in the new list strictly contains
  its token set (at least two distinct tokens in the removed text, at least one
  more in the retained text). The refinement carries the removed task's
  mutation window, so the completion-evidence gate keeps the work it already
  counted, and the pass is journaled as `todo_refined`. Expected effect: the
  refinement class stops producing `todo_lifecycle` blocks, and an agent no
  longer burns retries folding the old wording back in. **at-risk
  regressions:** (i) a genuine work drop that happens to extend the text now
  passes, which is accepted because the tracker is textual and the new task
  strictly contains the old tokens; (ii) two removed tasks could both claim one
  retained task, so the claim is count-bounded; (iii) a one-word task has too
  little signal and must stay strict. **non-goals:** no semantic comparison, no
  change to the completion-evidence rule, no change to the read-only marker, no
  fuzzy edit distance.

- **accept/reject rule:** accept if (a) the three journal pairs above now pass,
  (b) an unrelated replacement of equal-length wording still blocks, (c) a
  removed task with no retained successor still blocks, (d) the carried window
  lets a refined task complete on the mutation already recorded, (e) a
  refinement with no mutation still fails completion evidence, (f) `npm run
  typecheck` and `npm test` are green, and (g) the held-out probes do not
  regress. Reject if any genuine removal passes, if an existing lifecycle
  assertion is weakened, or if the held-out set regresses.

- **selection score (5 items, deterministic):** (a) 18 journal records with
  three retry loops of 7, 7 and 6; (b) the rule generalizes an existing
  carve-out instead of inventing a mechanism (`todo.ts:326-357`); (c)
  `todoTaskKey` already defines identity as annotated-normalized text, so the
  change extends the same concept; (d) the diff is one policy file plus tests
  and docs; (e) the failure is silent from the model's side, so the block
  message alone cannot fix it.

- **held-out score:** 5/5 passed (5 items, never used for selection): the full
  `npm test` suite (1726 passed, 0 failed), plus four probes written after the
  fix. Those probes are an unrelated equal-length replacement (still blocks), a
  one-word reword (still blocks), two removed tasks competing for one successor
  (still blocks), and mutations before the inherited window (never count).

- **disjointness:** the selection items are journal reason strings from past
  sessions. The held-out items are the repository's deterministic suite plus
  probes invented after the fix. Nothing in the held-out set was used to choose
  the token rule or its thresholds.

- **eval job path:** none. Deterministic verifier, no model in the scoring loop,
  so the matched-budget control and the answer-rescue audit do not apply
  (2607.12227, 2610.05533).

- **result (appended after the evaluation run):** GAIN. All three journal pairs
  pass `validateTodoLifecycle`; the dispatcher accepts the reworded list and
  journals `todo_refined`. Restoring the `origin/main` sources makes 8 of the
  first-pass checks fail, which is the pre-change control. The remaining new
  checks are boundary guards and pass in both directions by design. The full
  suite is 1731 passed, 0 failed, and `npm run typecheck` is clean. The worktree
  is on `feature/rsi-campaign-telemetry`; commit and PR follow.

- **review round (recorded before the PR):** the secondary reviewer returned
  REQUEST-CHANGES. Its P1 held: the window carry and the completion gate each
  re-derived the predecessor, so one predecessor could carry its start to two
  successors. The fix makes the lifecycle verdict the only pairing authority:
  `inspectTodoLifecycle` returns the key-level pairs, and the dispatcher passes
  them to both `unverifiedTodoCompletions` and `recordTodoTaskStarts`. A split
  case (one predecessor, two successors) and a one-to-one case (two and two)
  are now regression tests; the second successor gets a fresh window, never the
  predecessor's. Its P2 on matcher looseness was declined: a strict token
  superset is the preregistered hypothesis, and the near-miss drop is its named,
  accepted at-risk regression. Tightening it (semantic distance, scope terms)
  would change the hypothesis mid-iteration and needs its own preregistration.

- **keep/revert:** keep.

- **next hypothesis:** the same identity question recurs wherever task text is
  normalized, and C4 (tamper source-operand classification) is the next distinct
  change-type in the archived candidate set.

- prev-chain: sha256:856438a0ed76a918a6acb324f0130adf0a2569c248a42229613120f330d775c2

### n=4 — a copy source under a config path is not a settings mutation (security, preregistered 2026-11-21)

- **hypothesis (falsifiable, registered before the edit):** in legacy mode
  (no `liveControlPlanePaths` declared), `isSettingsTamper`
  (`src/policies/tamper.ts:61-78`) applies `PATH_PATTERNS` to the whole command
  segment, so any guarded path operand after `cp`, `ln`, or `install` blocks
  the command, including a read-only source. The live-control-plane fact mode
  already decides by the mutation target and allows the same copy
  (`test/test.mts:8219-8233` pins both directions). Falsified if a guarded `cp`
  source already passes without declared roots, or if a guarded destination
  already blocks for a reason other than this pattern.

- **pre-change probe:** `test/test.mts` names the false positive "legacy: cp
  FROM a .config/opencode source is blocked without live roots" and calls it
  "the F3 false positive, pinned as current behavior". A live `cp` from
  `~/.config/opencode/templates/rsi/` into a workspace draft was refused with
  `PROTECTED_PATH_REASON` during this campaign.

- **prediction (expected gain):** legacy mode classifies `cp`, `ln`, and
  `install` operands by role. The destination (last operand, or the `-t` /
  `--target-directory` value) is checked against the guarded-path patterns; a
  guarded source alone is allowed, matching fact mode and Policy 6's read-only
  allowance. `mv`, `rm`, `tee`, `sed -i`, `chmod`, `chown`, `truncate`, `dd`,
  `patch`, and `perl -i` keep the broad any-operand match, because each mutates
  every operand it names. **at-risk regressions:** (i) a destination hidden in
  a flag value (`--suffix .config/opencode`) is treated as an operand and could
  be skipped; it is not a write target, so the residual risk is a missed
  non-writing mention, not a write; (ii) an unrecognized copy-like program
  (`rsync`) is out of scope and keeps its current behaviour; (iii) `mv` must
  stay blocked even when the guarded path is the source, because the move
  removes it. **non-goals:** no change to fact mode, no new path pattern, no
  change to the redirect rules, no change to `isProtectedPath`.

- **accept/reject rule:** accept if (a) the legacy copy-source probe now
  passes, (b) a copy into a guarded path still blocks, (c) `mv` from a guarded
  path still blocks, (d) `ln` from a guarded path is allowed and `ln` into one
  blocks, (e) `cp -t <guarded>` and `install -d <guarded>` block, (f) the
  facts-mode tests are unchanged and green, (g) `npm run typecheck` and
  `npm test` are green. Reject if any guarded destination passes, if `mv`
  loosens, or if a fact-mode assertion regresses.

- **selection score (5 items, deterministic):** (a) the false positive is
  pinned by an existing test and named finding F3; (b) fact mode already
  defines the intended semantics, so this aligns two modes instead of
  inventing a rule; (c) the change is one policy file plus tests and docs;
  (d) a live reproduction failed in this campaign; (e) the true-positive set
  is enumerable (`mv`, redirects, destinations).

- **held-out score:** pass. The full `npm test` suite is green, and every
  held-out probe from the bank behaves as predicted: `--target-directory=` and
  `-t` destinations block, `install -d <guarded>` blocks while `install -d
  ./build/out` passes, a multi-source `cp` with one guarded source passes, and
  a guarded source with a guarded destination blocks.

- **disjointness:** the selection items are the existing test and the live
  reproduction. The held-out probes are written after the fix. Neither was
  used to choose the operand parser.

- **eval job path:** none. Deterministic verifier, no model in the loop.

- **result (appended after the evaluation run):** GAIN. The four legacy
  false-positive probes pass (`cp FROM`, `cp FROM` with a `2>/dev/null`
  redirect, a multi-source `cp` with one guarded source, and `ln -s FROM`).
  Restoring the `origin/main` source makes exactly those four fail and leaves
  the eleven true-positive probes green in both directions, which is the
  pre-change control. The full suite is 1770 passed, 0 failed, and
  `npm run typecheck` is clean. Fact-mode assertions are unchanged. A
  residual, fail-closed limitation is recorded: `cp -tDIR src` parses the
  attached short value, while a copy whose destination cannot be identified
  (one operand) keeps the broad match.

- **keep/revert:** keep.

- prev-chain: sha256:998bc046eece56735087bbaaa86e0b1ac5e481a19ddfbead3816e8ec19682681
