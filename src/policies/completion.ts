import { sessionVerifyResults, lastVerify, sessionMutationTimestamps, lastMutationTimestamp } from "../lib/state.ts";
import type { VerifyResult } from "../lib/types.ts";

/**
 * Claims-vs-evidence check (Policy 24): when the assistant's final text
 * asserts that work is complete or that tests pass, compare the claim against
 * recorded verification evidence. This is observability, not gating - the
 * hook audits mismatches so a confident wrap-up cannot silently contradict a
 * failing or stale verification state.
 *
 * Heuristic by design: natural-language claims are matched on explicit
 * completion/verification phrases. Only high-signal assertions
 * ("all tests pass", "done", "verified", "green build") count; casual usage
 * of the same words ("testing the fix", "it passed earlier") should not trip
 * the detector on multi-sentence responses without assertion framing.
 */

const COMPLETION_CLAIM_RE =
	/\b(?:all\s+(?:tests?|checks?)\s+(?:pass(?:es|ed|ing)?|green|succeed(?:ed|ing)?)|tests?\s+(?:are\s+)?(?:all\s+)?(?:pass(?:ing|ed)?|green)|build\s+(?:is\s+)?green|(?:successfully\s+)?verif(?:ied|ication\s+(?:passed|succeeded|is\s+clean))|(?:work|task|implementation)\s+is\s+(?:complete|done|finished)|everything\s+(?:is\s+)?(?:done|complete|works)|(?:all|every)\s+(?:task|item)s?\s+(?:is|are)\s+(?:done|complete(?:d)?))\b/i;

const VERIFICATION_FRESH_WINDOW_MS = 120_000;

export interface CompletionClaimCheck {
	claimsCompletion: boolean;
	claim?: string;
	evidenceState?: "fresh-pass" | "stale-pass" | "failing" | "missing";
	reason?: string;
}

export function checkCompletionClaims(
	text: string,
	context?: { sessionID?: string },
): CompletionClaimCheck {
	if (!text) return { claimsCompletion: false };

	const match = text.match(COMPLETION_CLAIM_RE);
	if (!match) return { claimsCompletion: false };

	// Session-scoped evidence wins when the session has its own entry OR has
	// recorded mutations (evidence was invalidated); otherwise fall back to the
	// most recent global result.
	const sessionHadEvidence =
		context?.sessionID !== undefined &&
		(sessionVerifyResults.has(context.sessionID) ||
			(sessionMutationTimestamps.get(context.sessionID) ?? 0) > 0);
	const verifyResult: VerifyResult | undefined = context?.sessionID
		? (sessionVerifyResults.get(context.sessionID) ??
			(sessionHadEvidence ? undefined : lastVerify))
		: lastVerify;

	let evidenceState: CompletionClaimCheck["evidenceState"];
	const mutationTimestamp = context?.sessionID
		? (sessionMutationTimestamps.get(context.sessionID) ?? 0)
		: lastMutationTimestamp;
	if (!verifyResult) {
		// A session-scoped lookup that was invalidated by a later mutation is
		// stale, not merely missing - the agent verified and then changed code.
		evidenceState =
			context?.sessionID && mutationTimestamp > 0 ? "stale-pass" : "missing";
	} else if (!verifyResult.passed) {
		evidenceState = "failing";
	} else if (
		verifyResult.timestamp < mutationTimestamp ||
		Date.now() - verifyResult.timestamp > VERIFICATION_FRESH_WINDOW_MS
	) {
		evidenceState = "stale-pass";
	} else {
		evidenceState = "fresh-pass";
	}

	if (evidenceState === "fresh-pass") {
		return { claimsCompletion: true, claim: match[0], evidenceState };
	}

	const reasonByState = {
		missing:
			"the response asserts completion/verification, but no verification evidence has been recorded in this session.",
		failing: `the response asserts completion, but the latest verification (${verifyResult?.command}) FAILED.`,
		"stale-pass":
			"the response asserts completion, but the last passing verification is stale - mutations were recorded after it.",
		"fresh-pass": "",
	} as const;

	return {
		claimsCompletion: true,
		claim: match[0],
		evidenceState,
		reason: reasonByState[evidenceState],
	};
}
