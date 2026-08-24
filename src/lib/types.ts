export interface TodoItem {
	content?: unknown;
	status?: unknown;
}

export interface TodoSdkClient {
	session?: {
		todo?: (opts: { path: { id: string } }) => Promise<{ data?: unknown }>;
		get?: (opts: { path: { id: string } }) => Promise<{ data?: { parentID?: unknown } }>;
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
	requireReview?: boolean;
	requireDocumentation?: boolean;
	maxSubagentMutations?: number;
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
