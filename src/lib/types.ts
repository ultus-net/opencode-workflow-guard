export interface TodoItem {
	content?: unknown;
	status?: unknown;
}

export interface TodoSdkClient {
	app?: {
		log?: (opts: { body: { service: string; level: "debug" | "info" | "warn" | "error"; message: string } }) => Promise<unknown>;
	};
	session?: {
		todo?: (opts: { path: { id: string } }) => Promise<{ data?: unknown }>;
		get?: (opts: { path: { id: string } }) => Promise<{ data?: { parentID?: unknown; title?: unknown } }>;
		promptAsync?: (opts: {
			path: { id: string };
			body: { messageID?: string; parts: Array<{ type: "text"; text: string; synthetic?: boolean }> };
		}) => Promise<unknown>;
	};
	tui?: {
		showToast?: (opts: { body: { title?: string; message: string; variant?: string } }) => Promise<unknown>;
	};
	lsp?: {
		status?: () => Promise<{ data?: unknown }>;
	};
}

export interface ProjectConfig {
	profile?: "interactive" | "autonomous";
	protectedBranches?: string[];
	verifyCommand?: string;
	postEditValidators?: Array<{
		pattern: string;
		command: string;
		timeoutMs?: number;
	}>;
	requireReview?: boolean;
	requireDocumentation?: boolean;
	recoveryCheckpoints?: boolean;
	projectMemory?: boolean;
	learning?: boolean;
	titleSettleWorkaround?: boolean;
	ralphMode?: boolean;
	ralphMaxIterations?: number;
	maxSubagentMutations?: number;
	maxLearningInterventions?: number;
}

export type PolicyDecisionStatus = "allowed" | "blocked" | "needs_approval" | "verification_failed";

export interface PolicyDecision {
	status: PolicyDecisionStatus;
	code: string;
	policy?: string;
	message: string;
	details?: Record<string, unknown>;
}

export interface VerifyResult {
	passed: boolean;
	command: string;
	output: string;
	timestamp: number;
	durationMs?: number;
	commitHash?: string;
	gitStatus?: string;
	workspaceRoot?: string;
	worktreeFingerprint?: string;
}

export interface ReviewResult {
	passed: boolean;
	reviewer: string;
	summary: string;
	timestamp: number;
	targetSessionID?: string;
	workspace?: string;
	commitHash?: string;
	gitStatus?: string;
	worktreeFingerprint?: string;
}

export type EvidenceConfidence = "deterministic_observation" | "attestation" | "derived_state" | "agent_assertion";

export interface EvidenceRecord {
	id: string;
	kind: "verification" | "review" | "tool_outcome" | "policy_evaluation" | "lifecycle_state" | "agent_assertion";
	confidence: EvidenceConfidence;
	observedAt: number;
	subject: {
		workspace?: string;
		commitHash?: string;
		worktreeFingerprint?: string;
		sessionID?: string;
		callID?: string;
		actor?: string;
	};
	source: Record<string, unknown>;
}

export type EvidenceSubject = EvidenceRecord["subject"];

export interface AuditEntry {
	ts: string;
	sessionID?: string;
	callID?: string;
	tool: string;
	decision: "allow" | "block";
	policyDecision?: PolicyDecision;
	phase?: "decision" | "outcome" | "event";
	durationMs?: number;
	reason?: string;
	input?: unknown;
	evidence?: {
		mutation?: boolean;
		targetPath?: string;
		verification?: {
			command: string;
			passed: boolean;
			fresh: boolean;
			durationMs?: number;
		};
		allowLive?: boolean;
		reviewVerdict?: "approved" | "changes_requested" | "rejected";
	};
}

export interface GitInvocation {
	repoDir: string;
	rest: string;
}

export interface ShellMutation {
	kind: "redirect" | "command";
	target?: string;
	what: string;
}

export type LearningStage = "exposed" | "developing" | "demonstrated" | "independent" | "critique";
export type LearningEvidenceKind = LearningStage | "needs-reinforcement";
export type LearningOpportunityType = "design" | "debugging" | "new-concept";

export interface LearningEvidence {
	concept: string;
	kind: LearningEvidenceKind;
	summary: string;
	timestamp: number;
	sessionID?: string;
	project?: string;
}

export interface LearnerConcept {
	stage: LearningStage;
	lastObservedAt: number;
	evidence: LearningEvidence[];
}

export interface LearnerProfile {
	version: 1;
	concepts: Record<string, LearnerConcept>;
}

export interface LearningOpportunity {
	type: LearningOpportunityType;
	concept: string;
	relevance: number;
	consequence: number;
}

export type ProjectMemoryKind = "fact" | "decision" | "constraint" | "lesson";
export type ProjectMemorySource = "user" | "file" | "git" | "tool" | "agent" | "portable";

export interface ProjectMemoryRecord {
	id: string;
	projectId: string;
	kind: ProjectMemoryKind;
	content: string;
	source: ProjectMemorySource;
	createdAt: number;
	sessionID?: string;
	commit?: string;
	paths: string[];
	supersedes?: string;
	status: "current" | "superseded";
}

export interface ProjectMemoryInput {
	kind: ProjectMemoryKind;
	content: string;
	source: ProjectMemorySource;
	sessionID?: string;
	commit?: string;
	paths?: string[];
	supersedes?: string;
}

export type ReviewFollowupSeverity = "P2" | "P3";

export interface ReviewFollowup {
	id: string;
	projectId: string;
	severity: ReviewFollowupSeverity;
	summary: string;
	reviewer: string;
	createdAt: number;
	resolvedAt?: number;
	sessionID?: string;
	commit?: string;
	paths: string[];
	status: "open" | "resolved";
}

export interface ReviewFollowupInput {
	severity: ReviewFollowupSeverity;
	summary: string;
	reviewer: string;
	sessionID?: string;
	commit?: string;
	paths?: string[];
}
