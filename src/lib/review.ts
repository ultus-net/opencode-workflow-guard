import {
	recordReviewResult,
	getLastReviewResult,
	resetReviewState,
	lastReview,
	sessionReviews,
} from "./state.ts";

export { recordReviewResult, getLastReviewResult, resetReviewState, lastReview, sessionReviews };

/**
 * What a rubric actually graded. A session's own checkout and the checkout
 * holding the change are not always the same tree, so the rubric must name the
 * tree it read and the base it compared against.
 */
export interface RubricProvenance {
	/** Absolute workspace root the diff was taken from. */
	workspace: string;
	/** Base ref actually used, or null when the rubric was not produced. */
	base: string | null;
	/** Bytes in the diff the rubric grades, before its own truncation. */
	diffBytes: number;
	/**
	 * `HEAD~1` when the graded range is the last commit rather than a branch
	 * base. It says which range was graded, not who asked for it: an explicit
	 * `base: "HEAD~1"` marks it too, because the range is the same either way.
	 */
	fallback: "none" | "HEAD~1";
}

export function rubricProvenanceLine(provenance: RubricProvenance): string {
	return `Provenance: workspace=${provenance.workspace} base=${provenance.base ?? "none"} diff=${provenance.diffBytes} bytes fallback=${provenance.fallback}`;
}

export function buildReviewRubric(diffText: string, taskPrompt?: string, provenance?: RubricProvenance): string {
	const lines = [
		"# Secondary Review Agent Quality Gate",
		"",
		"Evaluate this code change independently with fresh context across these 5 core axes:",
		"",
		"### 1. Test Integrity & Truthfulness (CRITICAL)",
		"- Are test assertions testing real behavioral outcomes rather than trivial passes (e.g. `expect(true).toBe(true)`)?",
		"- Were existing tests disabled, bypassed, or weakened?",
		"- Are edge cases and error paths covered?",
		"",
		"### 2. Task Completeness & Intent Alignment",
		"- Does the implementation genuinely satisfy the user request without shortcut stubs (`// TODO`, `throw new Error('not implemented')`)?",
		"- Does it introduce regressions in surrounding code?",
		"",
		"### 3. Code Cleanliness & Hygiene",
		"- Is there any orphaned dead code, commented-out code blocks, or temporary debugging logs?",
		"- Is the logic straightforward and free of unnecessary cognitive complexity?",
		"",
		"### 4. Security & Safety Boundaries",
		"- Are there any hardcoded secrets, unprotected tokens, or unvalidated user inputs?",
		"- Does the code respect workspace confinement and safe environment practices?",
		"",
		"### 5. Platform & Architecture Fit (GitHub & Azure DevOps)",
		"- Does the change fit established repository patterns and CI/CD pipelines?",
		"",
		"### Finding Severity & Priority Tiers (inspired by OMP Advisor):",
		"- **P0**: Blocker / security vulnerability / data loss risk / release-blocking regression (must block approval).",
		"- **P1**: Major defect / missing core requirement / broken error handling (must block approval).",
		"- **P2**: Minor bug / edge case / hygiene issue / missing unit test.",
		"- **P3**: Suggestion / nitpick / optimization idea.",
		"",
		taskPrompt ? `### User Request / Context:\n${taskPrompt}\n` : "",
		"### Code Diff Under Review:",
		"```diff",
		diffText.slice(0, 30_000),
		"```",
		"",
		"Provide your verdict: `[APPROVE]` or `[REQUEST_CHANGES]` with concise, actionable findings ranked by priority (P0-P3).",
	];
	if (provenance) lines.unshift(rubricProvenanceLine(provenance), "");
	return lines.join("\n");
}
