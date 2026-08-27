# Accountability Evolution Plan

## Purpose

Evolve Workflow Guard's existing policy, audit, verification, review, memory, and learning mechanisms into a clearer accountability model without turning Workflow Guard into an agent orchestrator.

The architectural boundary is deliberate:

- Core enforcement owns deterministic safety and workflow invariants at supported OpenCode policy boundaries.
- Evidence records what happened and whether required proof is fresh.
- Continuity preserves bounded state across sessions, compaction, and handoffs.
- Guidance helps the model or user understand state without assigning, prioritizing, delegating, retrying, or sequencing work.
- Behavior that crosses from enforcement/accountability into workflow preference or orchestration-adjacent behavior must be optional and independently toggleable. Such capabilities are add-ons, not new core authority.

Project memory and Socratic learning remain optional context features with their own lifecycle semantics. They may share provenance conventions with operational evidence, but they are not policy evidence and do not gain enforcement authority.

## Contracts

Policy decisions and operational evidence are separate concepts.

`PolicyDecision` is the result of evaluating whether an operation may proceed. It should provide a stable machine-readable status and code, an optional policy identifier, a human-readable message, and bounded structured details. Human block text, audit entries, `guard_why`, and controller-facing output should derive from this result rather than independently interpreting policy state.

`EvidenceRecord` represents operational proof or observation such as verification, secondary review, tool outcome, policy evaluation, or lifecycle state. Evidence records should carry common project/session/worktree provenance where applicable. Existing purpose-built stores remain authoritative; this work should introduce a common representation rather than another database.

Evidence must be bound to the subject it actually establishes. Where applicable, that means identifying the workspace/worktree, commit or worktree fingerprint, session/call, actor or reviewer, policy/version, and observation time. A historical fact such as "verification passed" is not sufficient to establish that the current worktree is verified unless its subject still matches current state.

Operational evidence should distinguish confidence classes rather than treating all machine-readable claims as equivalent:

- Deterministic observation: repository state, changed files, tool execution/outcome, test exit status, or another directly observed fact.
- Attestation: a reviewer, model, or human records a judgment such as approval. The fact that the attestation occurred is observable; the judgment is not converted into deterministic truth.
- Derived state: a reproducible conclusion such as "verification is fresh" computed from subject-bound observations and current state.
- Agent assertion: natural-language claims such as "tests pass" or "review is complete". These may be useful diagnostics but are never sufficient evidence for a safety or finalization gate by themselves.

Prefer outcome and state predicates over prescribed trajectories. Workflow Guard may require demonstrable end state or consequential checkpoints, but should not require one exact sequence of otherwise-valid agent actions when the desired state can be established directly.

Project memory and learning evidence remain separate from `EvidenceRecord`. Project memory represents durable repository knowledge. Learning evidence represents observations from real Socratic interactions. Neither should be forced into an allow/block or operational-proof model.

## Implementation Sequence

1. Add a structured `PolicyDecision` contract. Convert the internal policy dispatcher to return it while preserving current human-facing block behavior at the OpenCode hook boundary.
2. Make audit serialization consume the structured decision. Add stable decision codes and optional policy identifiers without removing useful human diagnostics.
3. Add an `EvidenceRecord` contract and projection helpers over existing verification, review, tool-outcome, policy, and lifecycle state. Make subject/provenance binding part of the initial contract rather than a later enhancement. Do not introduce a second evidence database.
4. Unify verification and review provenance/freshness comparison on top of the subject-bound evidence contract. Verification should carry the same relevant worktree provenance already used by review, and mutations must continue to invalidate parent/session evidence correctly.
5. Upgrade `guard_status` into a stable machine-readable accountability surface exposing effective configuration, high-signal evidence references/freshness, and outstanding requirements. Make `guard_why` return the real structured policy decision rather than parsing or reconstructing text. Prefer bounded summaries plus evidence references over dumping historical state into agent context.
6. Add optional operation profiles only after the contracts and freshness semantics settle. Start with a small set such as `interactive` and `autonomous` if concrete behavior differences justify them. Explicit feature settings override profile defaults.
7. Expand adversarial tests for stable decision codes, provenance invalidation, option/profile precedence, and machine-readable status. Add headless/server coverage proving core enforcement does not depend on the TUI or interactive approval.
8. Update policy, installation, and managed-deployment documentation as behavior becomes user-visible.

The accountability contracts now support an opt-in bounded autonomous-continuation add-on ("Ralph mode"). Its initial implementation only continues an agent while explicitly owned native todos remain unfinished; it does not interpret configured documents or invent completion criteria. It is disabled by default (including under the `autonomous` profile), user-interruptible, iteration-bounded, and preserves all core guardrails. It reports observable outcomes such as `completed`, `budget_exhausted`, or `user_stopped`; `blocked` is reserved for a demonstrable guard state rather than inferred from repeated idle events. Ralph remains an optional orchestration consumer rather than part of the accountability kernel.

## Configuration Boundary

Safety invariants stay core and are not weakened by operation profiles or optional add-ons. Examples include secret protection, protected-path/tamper protection, workspace boundaries, protected-branch safeguards, and deterministic checks needed to prevent bypass of those invariants.

Capabilities that express user workflow preference, add continuity/context, or approach orchestration must be configurable. Examples include project memory, Socratic learning, recovery checkpoints, review/documentation requirements, bounded continuation behavior, and future autonomous-operation conveniences. Optional capabilities must fail independently where practical so disabling or failing an add-on does not disable core enforcement.

Workflow Guard must not become responsible for planning work, choosing the next task, delegating tasks, autonomous retry loops, sequencing agents, or deciding when an external job should terminate. External SDK/server clients or dedicated add-ons own orchestration. The existing bounded `session.idle` continuation may enforce already-owned unfinished work but must not grow into an orchestration loop.

The same boundary applies to review. Workflow Guard can prove that a review occurred against a particular subject, preserve the reviewer's disposition and findings, and enforce a configured review requirement. It must not infer that an approval proves correctness, choose reviewers, launch review loops, negotiate findings, or decide what work should happen next.

## External Research Rationale

Recent OpenAI and Anthropic engineering/research material independently supports this architecture. These sources are design inputs rather than normative dependencies; Workflow Guard should continue to rely on supported OpenCode APIs and its own tested contracts.

- OpenAI's February 2026 [Harness engineering: leveraging Codex in an agent-first world](https://openai.com/index/harness-engineering/) describes mechanically enforced architectural invariants around agent autonomy. The applicable inference for Workflow Guard is to enforce boundaries centrally while leaving implementation strategy and task execution to the agent.
- OpenAI's March 2025 [Detecting misbehavior in frontier reasoning models](https://openai.com/index/chain-of-thought-monitoring/) reports coding agents exploiting evaluation loopholes, including weakening or altering verification. The applicable inference is to retain independent provenance about changed artifacts and verification subjects rather than trusting reported success or an undifferentiated test-pass signal.
- OpenAI's May 2025 [Introducing Codex](https://openai.com/index/introducing-codex/) emphasizes verifiable evidence from terminal/test activity and traceable results. The applicable inference is that guard decisions should reference operational facts that can be inspected independently of an agent's completion claim.
- OpenAI's August 2025 [Anthropic-OpenAI alignment evaluation exercise](https://openai.com/index/openai-anthropic-safety-evaluation/) notes errors in automated grading and the value of independent/manual inspection. The applicable inference is to record review/model judgments as attestations rather than elevate them to deterministic proof.
- Anthropic's January 2026 [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) explicitly distinguishes a transcript from the final environment outcome and recommends deterministic graders where possible. The applicable inference is to prefer observable state/outcome evidence and avoid brittle enforcement of one expected action sequence.
- Anthropic's June 2025 [How we built our multi-agent research system](https://www.anthropic.com/engineering/built-multi-agent-research-system) recommends end-state evaluation for state-mutating agents and describes provenance-preserving artifacts, observability, and checkpoints. The applicable inference is to validate consequential state while leaving valid execution paths open.
- Anthropic's September 2025 [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) recommends the smallest high-signal context and just-in-time retrieval. The applicable inference is that `guard_status` should expose compact current state and stable evidence references rather than inject an ever-growing accountability transcript.
- Anthropic's December 2024 [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) separates deterministic workflows from model-directed agents, recommends simple composable mechanisms, and uses programmatic gates where checks are appropriate. The applicable inference is to keep Workflow Guard a guardrail/accountability layer, not an orchestrator-worker or evaluator-optimizer implementation.

The combined design principle is: Workflow Guard should answer, "May this operation happen, given what can actually be demonstrated about the current state?" It should not answer, "What should the agent do next?"

## OpenCode API Boundary

Use supported semantic OpenCode APIs wherever they provide enough information. `tool.execute.before` is the supported deterministic tool-blocking boundary. Current `session.idle` events and `experimental.text.complete` do not expose an explicit supported completion-veto result, so Workflow Guard must not emulate a hard completion gate through undocumented exception behavior.

Machine-readable controller outcomes should therefore come from Workflow Guard's own structured contracts, tools, and audit trail until OpenCode exposes a stronger lifecycle decision hook.

Shell matching remains defense in depth rather than a sandbox. Prefer structured tool/API boundaries when available, while retaining adversarial shell coverage for channels that only expose command text.

## Compatibility And Non-Goals

- Preserve existing human-readable block messages at the hook boundary while internal consumers migrate to structured decisions.
- Preserve existing verification history, review state, project-memory databases, learning profiles, and review-follow-up storage; migrate representations before considering storage changes.
- Do not merge project memory, learner evidence, and operational evidence into a universal event store.
- Do not claim managed deployment proves plugin provenance when OpenCode cannot provide that guarantee.
- Do not add a hard completion gate until OpenCode exposes a supported block/continue lifecycle hook.
- Do not pin dependency versions as part of this work. Dependency update policy remains intentionally separate from the accountability architecture.
- Keep one cohesive package. Orchestration-adjacent additions belong behind explicit options/add-on surfaces rather than expanding core policy authority.

## Acceptance Criteria

- Policy evaluation has one structured result from which blocking text and audit data are derived.
- External/controller-facing status does not require parsing human log messages.
- Operational evidence identifies the subject it establishes and does not silently transfer validity to a changed worktree, commit, session, or call.
- Deterministic observations, attestations, derived state, and agent assertions are not treated as interchangeable proof.
- Verification and review freshness are provenance-aware and invalidate consistently after relevant mutations.
- Safety and finalization gates depend on observable/derived evidence rather than an agent's natural-language assertion of success.
- Where an end-state predicate is sufficient, enforcement does not prescribe an unnecessary exact tool/action trajectory.
- Existing core guardrails behave the same unless a change is explicitly documented and tested.
- Preference-heavy and orchestration-adjacent behavior is independently toggleable and does not weaken unrelated enforcement when disabled.
- Memory, learning, and review follow-ups retain their current durable accountability value without becoming orchestration mechanisms.
- Unit/adversarial and headless integration coverage pass without requiring the optional TUI.
