import type {
	LearnerProfile,
	LearningEvidence,
	LearningOpportunity,
	LearningStage,
} from "./types.ts";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const STAGE_ORDER: LearningStage[] = ["exposed", "developing", "demonstrated", "independent", "critique"];
const TYPE_WEIGHT = { design: 0.3, debugging: 0.3, "new-concept": 0.2 } as const;

export function createLearnerProfile(): LearnerProfile {
	return { version: 1, concepts: {} };
}

export function getLearnerProfilePath(): string {
	const dataRoot = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
	return join(dataRoot, "opencode", "workflow-guard", "learner-profile.json");
}

export function loadLearnerProfile(path = getLearnerProfilePath()): LearnerProfile {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LearnerProfile>;
		const validConcepts = parsed.concepts && typeof parsed.concepts === "object" && !Array.isArray(parsed.concepts) &&
			Object.values(parsed.concepts).every((concept) =>
				concept && typeof concept === "object" &&
				STAGE_ORDER.includes(concept.stage) &&
				typeof concept.lastObservedAt === "number" && Number.isFinite(concept.lastObservedAt) &&
				Array.isArray(concept.evidence),
			);
		if (parsed.version === 1 && validConcepts) {
			return parsed as LearnerProfile;
		}
	} catch {}
	return createLearnerProfile();
}

export function saveLearnerProfile(profile: LearnerProfile, path = getLearnerProfilePath()): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify(profile, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, path);
}

export function updateLearnerProfile(
	update: (profile: LearnerProfile) => void,
	path = getLearnerProfilePath(),
): LearnerProfile {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const lockPath = `${path}.lock`;
	let lock: number;
	try {
		lock = openSync(lockPath, "wx", 0o600);
	} catch {
		throw new Error("Learner profile is busy; evidence was not recorded. Remove a stale .lock file before retrying if its owning process has terminated.");
	}
	try {
		writeFileSync(lock, String(process.pid));
		const profile = loadLearnerProfile(path);
		update(profile);
		saveLearnerProfile(profile, path);
		return profile;
	} finally {
		closeSync(lock);
		try { unlinkSync(lockPath); } catch {}
	}
}

export function recordLearningEvidence(profile: LearnerProfile, evidence: LearningEvidence): void {
	const current = profile.concepts[evidence.concept];
	const evidenceStage = evidence.kind === "needs-reinforcement" ? undefined : evidence.kind;
	const stage = evidenceStage ?? current?.stage ?? "exposed";
	const nextStage = current && STAGE_ORDER.indexOf(current.stage) > STAGE_ORDER.indexOf(stage)
		? current.stage
		: stage;

	profile.concepts[evidence.concept] = {
		stage: nextStage,
		lastObservedAt: evidence.timestamp,
		evidence: [...(current?.evidence ?? []), evidence].slice(-20),
	};
}

export function selectLearningOpportunity(
	profile: LearnerProfile,
	opportunities: LearningOpportunity[],
	options: { interventionsThisSession?: number; maxInterventionsPerSession?: number } = {},
): LearningOpportunity | undefined {
	const used = options.interventionsThisSession ?? 0;
	const budget = options.maxInterventionsPerSession ?? 3;
	if (used >= budget) return undefined;

	let best: { opportunity: LearningOpportunity; score: number } | undefined;
	for (const opportunity of opportunities) {
		const known = profile.concepts[opportunity.concept];
		const needsReinforcement = known?.evidence.at(-1)?.kind === "needs-reinforcement";
		const gap = needsReinforcement ? 1 : known ? 1 - (STAGE_ORDER.indexOf(known.stage) + 1) / STAGE_ORDER.length : 1;
		const score = opportunity.relevance * 0.4 + opportunity.consequence * 0.3 + gap * 0.3 + TYPE_WEIGHT[opportunity.type];
		if (!best || score > best.score) best = { opportunity, score };
	}
	return best && best.score >= 0.75 ? best.opportunity : undefined;
}
