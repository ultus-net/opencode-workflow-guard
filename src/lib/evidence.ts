import { createHash } from "node:crypto";
import type { ToolOutcome } from "./tool-outcomes.ts";
import type { DogfoodResult, EvidenceRecord, EvidenceSubject, PolicyDecision, ReviewResult, VerifyResult } from "./types.ts";
import { isSameGitRepo } from "./project-config.ts";

function evidenceId(kind: EvidenceRecord["kind"], observedAt: number, subject: EvidenceRecord["subject"], source: Record<string, unknown>): string {
	return createHash("sha256").update(JSON.stringify({ kind, observedAt, subject, source })).digest("hex");
}

export function verificationEvidence(result: VerifyResult, sessionID?: string): EvidenceRecord {
	const subject = { workspace: result.workspaceRoot, commitHash: result.commitHash, worktreeFingerprint: result.worktreeFingerprint, sessionID };
	const source = { command: result.command, passed: result.passed, durationMs: result.durationMs, gitStatus: result.gitStatus };
	return { id: evidenceId("verification", result.timestamp, subject, source), kind: "verification", confidence: "deterministic_observation", observedAt: result.timestamp, subject, source };
}

export function reviewEvidence(result: ReviewResult): EvidenceRecord {
	const subject = { workspace: result.workspace, commitHash: result.commitHash, worktreeFingerprint: result.worktreeFingerprint, sessionID: result.targetSessionID, actor: result.reviewer };
	const source = { reviewer: result.reviewer, passed: result.passed, summary: result.summary, gitStatus: result.gitStatus };
	return { id: evidenceId("review", result.timestamp, subject, source), kind: "review", confidence: "attestation", observedAt: result.timestamp, subject, source };
}

export function dogfoodEvidence(result: DogfoodResult): EvidenceRecord {
	const subject = { workspace: result.workspace, commitHash: result.commitHash, worktreeFingerprint: result.worktreeFingerprint, sessionID: result.sessionID, actor: result.host.label };
	// The digest pair is part of the source, so replaying a passing run onto a
	// different scenario or taxonomy changes the evidence id.
	const source = {
		verdict: result.verdict,
		scenarioId: result.scenarioId,
		scenarioSha256: result.scenarioSha256,
		taxonomySha256: result.taxonomySha256,
		taxonomyClass: result.taxonomyClass,
		checks: result.checks,
		runCount: result.runCount,
		host: result.host,
		gitStatus: result.gitStatus,
	};
	return { id: evidenceId("dogfood", result.timestamp, subject, source), kind: "dogfood", confidence: "attestation", observedAt: result.timestamp, subject, source };
}

export function toolOutcomeEvidence(outcome: ToolOutcome, observedAt: number, workspace?: string): EvidenceRecord {
	const subject = { workspace, sessionID: outcome.sessionID, callID: outcome.callID };
	const source = { tool: outcome.tool, status: outcome.status, durationMs: outcome.durationMs, repeatedFailureCount: outcome.repeatedFailureCount };
	return { id: evidenceId("tool_outcome", observedAt, subject, source), kind: "tool_outcome", confidence: "deterministic_observation", observedAt, subject, source };
}

export function policyDecisionEvidence(decision: PolicyDecision, observedAt: number, subject: EvidenceSubject): EvidenceRecord {
	const source = { status: decision.status, code: decision.code, policy: decision.policy };
	return { id: evidenceId("policy_evaluation", observedAt, subject, source), kind: "policy_evaluation", confidence: "deterministic_observation", observedAt, subject, source };
}

export function lifecycleStateEvidence(state: string, observedAt: number, subject: EvidenceSubject, source: Record<string, unknown> = {}): EvidenceRecord {
	const lifecycleSource = { state, ...source };
	return { id: evidenceId("lifecycle_state", observedAt, subject, lifecycleSource), kind: "lifecycle_state", confidence: "derived_state", observedAt, subject, source: lifecycleSource };
}

export function agentAssertionEvidence(assertion: string, observedAt: number, subject: EvidenceSubject): EvidenceRecord {
	const source = { assertion };
	return { id: evidenceId("agent_assertion", observedAt, subject, source), kind: "agent_assertion", confidence: "agent_assertion", observedAt, subject, source };
}

export function evidenceMatchesSubject(evidence: EvidenceRecord, subject: EvidenceSubject): boolean {
	const workspaceMatches =
		evidence.subject.workspace === subject.workspace ||
		(Boolean(evidence.subject.workspace && subject.workspace) &&
			isSameGitRepo(evidence.subject.workspace, subject.workspace));
	return workspaceMatches &&
		evidence.subject.commitHash === subject.commitHash &&
		evidence.subject.worktreeFingerprint === subject.worktreeFingerprint &&
		evidence.subject.sessionID === subject.sessionID;
}

export function isEvidenceFresh(evidence: EvidenceRecord, subject: EvidenceSubject, mutationTimestamp: number): boolean {
	// HEAD is legitimately absent in a freshly initialized repository, but the
	// worktree fingerprint remains available there and is required for freshness.
	if (!evidence.subject.worktreeFingerprint || !subject.worktreeFingerprint) return false;
	return evidence.observedAt >= mutationTimestamp && evidenceMatchesSubject(evidence, subject);
}
