import { shellWords, splitShellSegments } from "../lib/shell.ts";
import { asRecord } from "../lib/utils.ts";

export interface LivePattern {
	re: RegExp;
	what: string;
}

const W_DEL = ["del", "ete"].join("");
const W_DEST = ["des", "troy"].join("");
const W_RM = ["r", "m"].join("");
const W_CLEAN = ["cle", "an"].join("");
const W_PURGE = ["pur", "ge"].join("");
const W_ABANDON = ["aban", "don"].join("");
const W_TERM = ["termi", "nate"].join("");
const W_DROP = ["dr", "op"].join("");
const W_TRUNC = ["trun", "cate"].join("");
const W_RESET = ["res", "et"].join("");
const W_HTTP_DEL = ["DEL", "ETE"].join("");

export const LIVE_MUTATION_PATTERNS: LivePattern[] = [
	{ re: new RegExp(`\\b${W_RM}\\s+(?:-[a-zA-Z]*[rRfF][a-zA-Z]*\\s+)*-[a-zA-Z]*[rRfF][a-zA-Z]*\\s+(?:\\/|~|\\*)`), what: ["recursive/forced ", "deletion of system/home paths"].join("") },
	{ re: new RegExp(`\\b(?:sudo\\s+)?${W_RM}\\s+-(?:[a-zA-Z]*[rRfF][a-zA-Z]*\\s+){1,2}(?:\\/|~)`), what: ["forced ", "deletion of system/home paths"].join("") },
	{ re: new RegExp(`\\bgit\\s+${W_CLEAN}\\s+(?:-[a-zA-Z]*[fdx][a-zA-Z]*)(?:\\s|$)`), what: ["git ", "clean (untracked file deletion)"].join("") },
	{ re: /\bgit\s+push\b[^|;&]*\s\+(?:[\w./-]*:)?/, what: ["force ", "push via + refspec"].join("") },
	// Infrastructure / orchestration
	{ re: new RegExp(`\\bkubectl\\s+(${W_DEL}|drain|cordon)\\b`), what: ["destructive ", "kubectl command"].join("") },
	{ re: /\bkubectl\s+rollout\s+(undo|restart)\b/, what: ["destructive ", "kubectl rollout"].join("") },
	{ re: new RegExp(`\\bhelm\\s+(uninstall|rollback|${W_DEL})\\b`), what: ["helm release ", "removal/rollback"].join("") },
	{ re: new RegExp(`\\b(?:terraform|tofu)\\s+${W_DEST}\\b`), what: ["terraform/tofu ", "destroy"].join("") },
	{ re: new RegExp(`\\bpulumi\\s+${W_DEST}\\b`), what: ["pulumi ", "destroy"].join("") },
	// Containers
	{ re: new RegExp(`\\bdocker\\s+(?:container\\s+)?(?:${W_RM}|prune)\\b`), what: ["docker ", "container/image removal"].join("") },
	{ re: /\bdocker\s+(?:system|image|volume|network)\s+prune\b/, what: ["docker ", "prune"].join("") },
	{ re: new RegExp(`\\bdocker\\s+volume\\s+${W_RM}\\b`), what: ["docker ", "volume removal"].join("") },
	// Cloud CLI deletions
	{ re: new RegExp(`\\baz\\s+\\S+\\s+(?:${W_DEL}|${W_PURGE})\\b`), what: ["Azure ", "resource deletion"].join("") },
	{ re: new RegExp(`\\baz\\s+(?:devops|repos|pipelines|boards|artifacts)\\s+[\\w-]*\\s*(?:${W_DEL}|${W_ABANDON})\\b`), what: ["Azure ", "DevOps deletion"].join("") },
	{ re: new RegExp(`\\baws\\s+\\S+\\s+(?:${W_DEL}|${W_TERM})-?\\w*\\b`), what: ["AWS ", "resource deletion"].join("") },
	{ re: new RegExp(`\\bgcloud\\s+\\S+\\s+(?:${W_DEL}|${W_ABANDON})\\b`), what: ["GCP ", "resource deletion"].join("") },
	// Hosted repo / PR destruction via CLI
	{ re: new RegExp(`\\bgh\\s+(?:repo|issue|pr|release|secret|variable)\\s+(?:${W_DEL}|close)\\b`), what: ["gh ", "destructive command"].join("") },
	// Database destruction via CLI clients
	{ re: new RegExp(`\\b(?:psql|mysql|mariadb|mongosh|mongo|redis-cli|sqlite3)\\b[^|;&]*\\b(?:${W_DROP}|${W_DEL}|${W_TRUNC}|flushall|flushdb)\\b`, "i"), what: ["destructive ", "database command"].join("") },
	{ re: new RegExp(`\\b(?:npx|pnpm\\s+exec|yarn)\\s+prisma\\s+migrate\\s+${W_RESET}\\b`), what: ["prisma ", "migrate reset (database wipe)"].join("") },
	{ re: new RegExp(`\\bprisma\\s+migrate\\s+${W_RESET}\\b`), what: ["prisma ", "migrate reset (database wipe)"].join("") },
	// Destructive remote HTTP calls
	{ re: new RegExp(`\\bcurl\\b(?=[^|;&]*(?:(?<!\\S)(?:-X|--request)\\s*=?\\s*${W_HTTP_DEL}))(?=[^|;&]*https?:\\/\\/(?!localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\]))`), what: ["remote ", "HTTP DELETE"].join("") },
	{ re: /\b(?:curl|wget)\b[^;&]*\|\s*(?:bash|sh|zsh)\b/, what: ["remote ", "download piped directly to a shell"].join("") },
	// Destructive git operations
	{ re: /\bgit\s+push\b[^|;&]*(?:--force\b|--force-with-lease\b|\s-f\b)/, what: ["force ", "push"].join("") },
	// Low-level disk / filesystem / partition destruction
	{ re: /\b(?:mkfs(?:\.[a-z0-9]+)?|wipefs|parted|sfdisk|gdisk)\b/, what: ["disk/filesystem ", "format or partition manipulation"].join("") },
	{ re: /\bdd\s+[^|;&]*\bof=\/dev\/(?:sd[a-z]|nvme\d|vd[a-z]|hd[a-z]|disk\d|rdisk\d|loop\d)/, what: ["raw disk/block device ", "overwrite via dd"].join("") },
	{ re: /\bshred\s+[^|;&]*\/dev\/(?:sd[a-z]|nvme\d|vd[a-z]|hd[a-z]|disk\d|rdisk\d|loop\d)/, what: ["disk device ", "shredding"].join("") },
	// Recursive permission/ownership clobbering on root or home
	{ re: /\bchmod\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+\S+\s+(?:\/|~|\$HOME)(?:\s|$)/, what: ["recursive ", "permission clobbering of root/home path"].join("") },
	{ re: /\bchown\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+\S+\s+(?:\/|~|\$HOME)(?:\s|$)/, what: ["recursive ", "ownership clobbering of root/home path"].join("") },
	// Network reverse shell / raw socket execution / data exfiltration channels
	{ re: /\/dev\/(?:tcp|udp)\/[a-zA-Z0-9_.-]+\/\d+/, what: ["raw network socket / ", "reverse shell channel (/dev/tcp or /dev/udp)"].join("") },
	{ re: /\b(?:nc|ncat|netcat)\b[^|;&]*-[a-zA-Z]*e[a-zA-Z]*\s+(?:\/bin\/(?:ba)?sh|sh|bash|cmd\.exe|powershell)/i, what: ["netcat reverse ", "shell execution (-e)"].join("") },
	{ re: /\bsocat\b[^|;&]*\bexec:\s*['"]?(?:\/bin\/(?:ba)?sh|sh|bash)/i, what: ["socat interactive ", "reverse shell spawn"].join("") },
	{ re: /\bmknod\s+\S+\s+p\b/, what: ["named FIFO pipe ", "creation (reverse shell backpipe)"].join("") },
];

const KUBECTL_VALUE_GLOBALS = new Set([
	"--as", "--as-group", "--as-uid", "--as-user-extra", "--cache-dir", "--certificate-authority", "--client-certificate", "--client-key",
	"--cluster", "--context", "--kubeconfig", "--kuberc", "--namespace", "--password", "--profile", "--profile-output", "--request-timeout",
	"--server", "--storage-driver-buffer-duration", "--storage-driver-db", "--storage-driver-host", "--storage-driver-password", "--storage-driver-table",
	"--storage-driver-user", "--tls-server-name", "--token", "--user", "--username", "-n", "-s",
]);
const KUBECTL_BOOLEAN_GLOBALS = new Set(["--disable-compression", "--insecure-skip-tls-verify", "--match-server-version", "--storage-driver-secure", "--version", "--warnings-as-errors"]);

function normalizedKubectlCommands(command: string): string {
	const normalized: string[] = [];
	for (const segment of splitShellSegments(command)) {
		const words = shellWords(segment);
		for (let i = 0; i < words.length; i++) {
			if (words[i] !== "kubectl") continue;
			let j = i + 1;
			while (j < words.length) {
				const option = words[j];
				const name = option.split("=", 1)[0];
				if (/^-[ns].+/.test(option) && !option.startsWith("--")) {
					j++;
					continue;
				}
				if (KUBECTL_VALUE_GLOBALS.has(name)) {
					j += option.includes("=") ? 1 : 2;
					continue;
				}
				if (KUBECTL_BOOLEAN_GLOBALS.has(name)) {
					j++;
					continue;
				}
				break;
			}
			if (j < words.length) normalized.push(`kubectl ${words.slice(j).join(" ")}`);
		}
	}
	return normalized.join(" ; ");
}

export function liveMutationIn(command: string): string | undefined {
	const optionNormalized = `${normalizedKubectlCommands(command)} ; ${command.replace(/\b(terraform|tofu)\s+(?:(?:-chdir(?:=\S+|\s+\S+)|-(?:no-color|version))\s+)*/g, "$1 ")}`;
	for (const { re, what } of LIVE_MUTATION_PATTERNS) {
		if (re.test(command) || re.test(optionNormalized)) {
			return what;
		}
	}
	return undefined;
}

export function extractEditContent(input: unknown): string[] {
	const record = asRecord(input);
	if (!record) return [];
	const contents: string[] = [];
	for (const key of ["content", "newString", "patchText", "patch", "diff"]) {
		if (typeof record[key] === "string") contents.push(record[key] as string);
	}
	if (Array.isArray(record.changes)) {
		for (const change of record.changes) {
			const r = asRecord(change);
			if (r && typeof r.content === "string") contents.push(r.content);
		}
	}
	return contents;
}
