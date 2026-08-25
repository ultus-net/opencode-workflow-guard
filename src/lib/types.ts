export interface TodoItem {
	content?: unknown;
	status?: unknown;
}

export interface TodoSdkClient {
	session?: {
		todo?: (opts: { path: { id: string } }) => Promise<{ data?: unknown }>;
		get?: (opts: { path: { id: string } }) => Promise<{ data?: { parentID?: unknown } }>;
		promptAsync?: (opts: {
			path: { id: string };
			body: { messageID?: string; parts: Array<{ type: "text"; text: string }> };
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
	maxSubagentMutations?: number;
	maxLearningInterventions?: number;
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

export interface AuditEntry {
	ts: string;
	sessionID?: string;
	tool: string;
	decision: "allow" | "block";
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
