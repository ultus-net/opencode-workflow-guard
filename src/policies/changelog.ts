import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { getWorkspaceRoot } from "../lib/state.ts";
import { splitShellSegments, unwrapShellCommand, unwrapShellWords } from "../lib/shell.ts";

export const CHANGELOG_SECTION_RE = /^\s*(?:#{1,6}\s*)?(?:changelog|changes|release notes?|summary)\s*(?::\s*\S.+|:?\s*\r?\n\s*(?![\\#])\S.+)/im;

export function hasPrCreateInvocation(command: string): boolean {
	return splitShellSegments(command)
		.some((seg) => {
			const trimmed = unwrapShellCommand(seg);
			return (
				/^gh\b[^|;&]*\bpr\s+create\b/.test(trimmed) ||
				/^az\b[^|;&]*\brepos\s+pr\s+create\b/.test(trimmed)
			);
		});
}

// Accepts either a CHANGELOG file modification or a .changeset/*.md file.
const CHANGELOG_OR_CHANGESET_RE = /(?:changelog|\.changeset\/[^/]+\.md$)/i;

function decodeAnsiCLineBreaks(value: string): string {
	let decoded = "";
	for (let i = 0; i < value.length; i += 1) {
		if (value[i] !== "\\" || i + 1 >= value.length) {
			decoded += value[i];
			continue;
		}
		const next = value[++i];
		if (next === "n") decoded += "\n";
		else if (next === "r") decoded += "\r";
		else if (next === "\\") decoded += "\\";
		else decoded += `\\${next}`;
	}
	return decoded;
}

function preserveAnsiCLineBreaks(command: string): string {
	return command.replace(/\$'((?:\\.|[^'])*)'/g, (_match, value: string) => {
		const decoded = decodeAnsiCLineBreaks(value).replace(/'/g, "'\\''");
		return `'${decoded}'`;
	});
}

function prShellWords(command: string): string[] {
	const words: string[] = [];
	let word = "";
	let quote: "'" | '"' | "ansi" | undefined;
	let started = false;
	for (let i = 0; i < command.length; i += 1) {
		const char = command[i]!;
		if (!quote && char === "$" && command[i + 1] === "'") {
			quote = "ansi";
			started = true;
			i += 1;
			continue;
		}
		if (quote === "ansi") {
			if (char === "'") {
				quote = undefined;
				continue;
			}
			if (char === "\\" && i + 1 < command.length) {
				let escape = char + command[++i];
				word += decodeAnsiCLineBreaks(escape);
				continue;
			}
			word += char;
			continue;
		}
		if (char === "'" || char === '"') {
			if (!quote) quote = char;
			else if (quote === char) quote = undefined;
			else word += char;
			started = true;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			const next = command[++i];
			if (next !== "\n") {
				if (quote === '"' && next && !['$', '`', '"', '\\'].includes(next)) word += "\\";
				word += next ?? "\\";
			}
			started = true;
			continue;
		}
		if (!quote && /\s/.test(char)) {
			if (started) words.push(word);
			word = "";
			started = false;
			continue;
		}
		word += char;
		started = true;
	}
	if (started) words.push(word);
	return words;
}

export function branchHasChangelogChange(root: string): boolean {
	try {
		const baseCandidates = ["origin/HEAD", "origin/main", "origin/master"];
		for (const base of baseCandidates) {
			const mergeBase = spawnSync(
				"git",
				["merge-base", "HEAD", base],
				{ cwd: root, encoding: "utf8", timeout: 10_000 },
			);
			if (mergeBase.status !== 0 || !mergeBase.stdout.trim()) continue;
			const diff = spawnSync(
				"git",
				["diff", "--name-only", `${mergeBase.stdout.trim()}...HEAD`],
				{ cwd: root, encoding: "utf8", timeout: 10_000 },
			);
			if (diff.status !== 0) continue;
			if (diff.stdout.split("\n").some((f) => CHANGELOG_OR_CHANGESET_RE.test(f))) {
				return true;
			}
		}
		const last = spawnSync("git", ["diff", "--name-only", "HEAD~1"], {
			cwd: root,
			encoding: "utf8",
			timeout: 10_000,
		});
		return (
			last.status === 0 &&
			last.stdout.split("\n").some((f) => CHANGELOG_OR_CHANGESET_RE.test(f))
		);
	} catch {
		return false;
	}
}

export function prBodyIncludesChangelog(command: string, invocationRoot: string | null = getWorkspaceRoot()): boolean {
	const parsedWords = prShellWords(command);
	const envIndex = parsedWords.indexOf("env");
	const usesEnvSplitString = envIndex >= 0 && parsedWords.slice(envIndex + 1).some((word) =>
		word === "-S" || word.startsWith("-S") || word === "--split-string" || word.startsWith("--split-string="));
	const commandWords = usesEnvSplitString
		? unwrapShellWords(preserveAnsiCLineBreaks(command))
		: parsedWords;
	const cliIndex = commandWords.findIndex((word) => word === "gh" || word === "az");
	const words = cliIndex >= 0 ? commandWords.slice(cliIndex) : [];
	let body = "";
	let bodyFile: string | undefined;
	const valueOptions = new Set([
		"--assignee", "--base", "--head", "--head-repo", "--label", "--milestone",
		"--project", "--recover", "--reviewer", "--template", "--title",
		"--bypass-policy-reason", "--labels", "--merge-commit-message", "--org",
		"--repository", "--required-reviewer-ids", "--reviewer-ids", "--source-branch",
		"--target-branch", "--work-items", "-a", "-B", "-H", "-l", "-m", "-p", "-r", "-T", "-t",
	]);
	for (let i = 0; i < words.length; i += 1) {
		const word = words[i]!;
		if (["--description", "-d"].includes(word)) {
			const lines: string[] = [];
			while (i + 1 < words.length && !words[i + 1]!.startsWith("-")) lines.push(words[++i]!);
			body = lines.join("\n");
		}
		else if (["--body", "-b"].includes(word)) body = words[++i] ?? "";
		else if (/^(?:--body|--description)=/.test(word)) body = word.slice(word.indexOf("=") + 1);
		else if (["--body-file", "--description-file", "-F"].includes(word)) bodyFile = words[++i];
		else if (/^(?:--body-file|--description-file)=/.test(word)) bodyFile = word.slice(word.indexOf("=") + 1);
		else if (valueOptions.has(word)) i += 1;
	}
	if (CHANGELOG_SECTION_RE.test(body)) return true;
	if (bodyFile) {
		try {
			if (!isAbsolute(bodyFile) && invocationRoot === null) return false;
			return CHANGELOG_SECTION_RE.test(
				readFileSync(isAbsolute(bodyFile) ? bodyFile : resolve(invocationRoot!, bodyFile), "utf8"),
			);
		} catch {
			return false;
		}
	}
	return false;
}

export function checkLockfileSync(root: string): { isOutOfSync: boolean; manifest?: string; lockfile?: string; reason?: string } {
	try {
		let modifiedFiles: string[] = [];
		const baseCandidates = ["origin/HEAD", "origin/main", "origin/master", "main", "master"];
		for (const base of baseCandidates) {
			const mergeBase = spawnSync("git", ["merge-base", "HEAD", base], { cwd: root, encoding: "utf8", timeout: 10_000 });
			if (mergeBase.status !== 0 || !mergeBase.stdout.trim()) continue;
			const diff = spawnSync("git", ["diff", "--name-only", `${mergeBase.stdout.trim()}...HEAD`], { cwd: root, encoding: "utf8", timeout: 10_000 });
			if (diff.status === 0 && diff.stdout.trim()) {
				modifiedFiles = diff.stdout.split("\n").map((f) => f.trim()).filter(Boolean);
				break;
			}
		}
		const headDiff = spawnSync("git", ["diff", "--name-only", "HEAD"], { cwd: root, encoding: "utf8", timeout: 10_000 });
		if (headDiff.status === 0 && headDiff.stdout.trim()) {
			const uncommitted = headDiff.stdout.split("\n").map((f) => f.trim()).filter(Boolean);
			modifiedFiles = Array.from(new Set([...modifiedFiles, ...uncommitted]));
		}
		const untracked = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8", timeout: 10_000 });
		if (untracked.status === 0 && untracked.stdout.trim()) {
			const files = untracked.stdout.split("\n").map((l) => l.slice(3).trim()).filter(Boolean);
			modifiedFiles = Array.from(new Set([...modifiedFiles, ...files]));
		}

		const manifestToLockfiles: Array<{ manifest: RegExp; lockfiles: RegExp; name: string }> = [
			{
				manifest: /(?:^|\/)package\.json$/,
				lockfiles: /(?:^|\/)(?:package-lock\.json|bun\.lock|bun\.lockb|pnpm-lock\.yaml|yarn\.lock)$/,
				name: "package.json",
			},
			{
				manifest: /(?:^|\/)Cargo\.toml$/,
				lockfiles: /(?:^|\/)Cargo\.lock$/,
				name: "Cargo.toml",
			},
			{
				manifest: /(?:^|\/)go\.mod$/,
				lockfiles: /(?:^|\/)go\.sum$/,
				name: "go.mod",
			},
		];

		for (const item of manifestToLockfiles) {
			const hasManifest = modifiedFiles.some((f) => item.manifest.test(f));
			if (hasManifest) {
				const hasLockfile = modifiedFiles.some((f) => item.lockfiles.test(f));
				if (!hasLockfile) {
					return {
						isOutOfSync: true,
						manifest: item.name,
						reason: `Package manifest '${item.name}' was modified without updating its corresponding lockfile. Run the package manager install/lock command before opening a PR.`,
					};
				}
			}
		}
	} catch {}
	return { isOutOfSync: false };
}
