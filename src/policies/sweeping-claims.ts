/**
 * Policy 26: Sweeping-Claim Grounding check (observability-only).
 *
 * Second failure mode: an agent skims one or two files and then asserts
 * sweeping facts about the repository ("every caller does X", "the entire
 * codebase uses Y", "nothing else references Z"). Prior art is explicit that
 * adding more context does not fix this: the EPISTEMIC LEDGER work (arXiv
 * 2602.07549) calls it a "bare assertion" - a claim with no supporting
 * retrieval - and the agent-control-tower study found agents self-reporting
 * completion/facts they never verified, with small models overclaiming most.
 *
 * This policy therefore does NOT block. Blocking on natural-language repo
 * claims is false-positive prone (a grep-heavy investigation may legitimately
 * support "no other callers" while touching few files), and Policy 24 already
 * keeps this class of check observability-only. Instead it journals a mismatch
 * between a sweeping claim and thin read coverage so the overclaim is visible
 * in the audit trail and the app log.
 *
 * Coverage signal: distinct files this session has read or authored
 * (`sessionReadFileCount`). A sweeping claim backed by fewer than
 * `MIN_SWEEPING_READ_COVERAGE` touched files is a skim, but treat a future
 * search/grep evidence channel as the authoritative breadth signal when it
 * exists - this is a conservative floor, not a verdict.
 */

import { sessionReadFileCount } from "./stale-write.ts";

/**
 * A sweeping claim is an explicit whole-repo/whole-set assertion. Kept narrow
 * to high-signal phrasings so casual wording ("check the whole file", "all
 * files under src") does not trip it; bare file quantifiers are deliberately
 * excluded and only named set nouns (codebase, repository, project, packages,
 * modules, components, sources) are matched.
 */
const SWEEPING_CLAIM_RE =
	/\b(?:the\s+)?(?:entire|whole|all|every)\s+(?:codebase|repository|repo|project|application|packages?|modules?|components?|sources?)\b|\b(?:throughout|across)\s+the\s+(?:codebase|repository|repo|project|code|app|application)\b|\bno\s+other\s+(?:place|occurrence|usage|reference|references|callers?|usages?)\b|\bnothing\s+else\s+(?:uses?|references?|calls?|depends\s+on)\b|\bnot\s+used\s+anywhere\s+else\b/i;

/** Distinct files that must be touched before a sweeping claim is "backed". */
export const MIN_SWEEPING_READ_COVERAGE = 2;

export interface SweepingClaimCheck {
	sweeping: boolean;
	claim?: string;
	readFileCount: number;
	reason?: string;
}

export function checkSweepingClaims(
	text: string,
	context?: { sessionID?: string },
): SweepingClaimCheck {
	const readFileCount =
		context?.sessionID !== undefined ? sessionReadFileCount(context.sessionID) : 0;
	if (!text) return { sweeping: false, readFileCount };

	const match = text.match(SWEEPING_CLAIM_RE);
	if (!match) return { sweeping: false, readFileCount };

	if (readFileCount >= MIN_SWEEPING_READ_COVERAGE) {
		return { sweeping: true, claim: match[0], readFileCount };
	}

	return {
		sweeping: true,
		claim: match[0],
		readFileCount,
		reason:
			`the response makes a sweeping repository claim ("${match[0]}") but this session has read or authored only ` +
			`${readFileCount} distinct file(s). Verify the claim with a broader search/read before stating it as fact.`,
	};
}
