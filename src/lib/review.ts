import {
	recordReviewResult,
	getLastReviewResult,
	resetReviewState,
	lastReview,
	sessionReviews,
} from "./state.ts";

export { recordReviewResult, getLastReviewResult, resetReviewState, lastReview, sessionReviews };

export function buildReviewRubric(diffText: string, taskPrompt?: string): string {
	return [
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
		taskPrompt ? `### User Request / Context:\n${taskPrompt}\n` : "",
		"### Code Diff Under Review:",
		"```diff",
		diffText.slice(0, 30_000),
		"```",
		"",
		"Provide your verdict: `[APPROVE]` or `[REQUEST_CHANGES]` with concise, actionable findings.",
	].join("\n");
}
