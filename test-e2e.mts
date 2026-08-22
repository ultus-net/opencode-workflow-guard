import { mkdtempSync, rmSync, existsSync, readFileSync, copyFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0;
let fail = 0;
const check = (name: string, cond: unknown): void => {
	cond ? (pass++, console.log("  ok  " + name)) : (fail++, console.log("FAIL  " + name));
};

console.log("- OpenCode Plugin Installation & Runtime Load Test -");

// 1. Verify opencode binary is available
const opencodeCheck = spawnSync("opencode", ["--version"], { encoding: "utf8" });
if (opencodeCheck.status !== 0) {
	console.log("SKIP: opencode CLI is not available in PATH. Skipping live runtime load tests.");
	process.exit(0);
}
console.log(`  Found OpenCode version: ${opencodeCheck.stdout.trim()}`);

// 2. Set up a fresh isolated project with plugin installed
const testDir = mkdtempSync(join(tmpdir(), "wg-install-test-"));
const pluginsDir = join(testDir, ".opencode", "plugins");
mkdirSync(pluginsDir, { recursive: true });

const sourcePlugin = join(import.meta.dirname, "workflow-guard.ts");
const targetPlugin = join(pluginsDir, "workflow-guard.ts");
copyFileSync(sourcePlugin, targetPlugin);
check("plugin copied to .opencode/plugins/ successfully", existsSync(targetPlugin));

// Initialize git repository on a feature branch
spawnSync("git", ["init", "-b", "feat/install-verification"], { cwd: testDir });
spawnSync("git", ["config", "user.email", "test@test.local"], { cwd: testDir });
spawnSync("git", ["config", "user.name", "Test Runner"], { cwd: testDir });

// 3. Test: Direct edit without task list is blocked by the loaded plugin
console.log("  Running live OpenCode prompt to verify plugin intercept...");
const run1 = spawnSync(
	"opencode",
	["run", "--dir", testDir, "Use the write tool to create a file named blocked.txt with content 'should not exist'."],
	{
		cwd: testDir,
		encoding: "utf8",
		timeout: 120_000,
	},
);

const output1 = run1.stdout + run1.stderr;
const blockedByGuard =
	output1.includes("[workflow-guard] Blocked: no active todo item") ||
	output1.includes("blocked write: no active todo item");
check("plugin loaded and intercepted write without active todo", blockedByGuard);

// 4. Test: Workspace boundary escape is blocked
const run2 = spawnSync(
	"opencode",
	["run", "--dir", testDir, "1) Use todowrite to create a pending task 'test'. 2) Use the write tool to write 'hi' to /tmp/outside_escaped.txt."],
	{
		cwd: testDir,
		encoding: "utf8",
		timeout: 120_000,
	},
);

const output2 = run2.stdout + run2.stderr;
const boundaryBlocked =
	output2.includes("escapes workspace root") ||
	output2.includes("path escapes workspace");
check("plugin loaded and enforced workspace boundary escape guard", boundaryBlocked);

// 5. Test: Compliant workflow (todowrite -> write -> complete) succeeds
const run3 = spawnSync(
	"opencode",
	["run", "--dir", testDir, "1) Use todowrite with task 'create verified.txt' (pending). 2) Use write tool to create verified.txt containing 'installed-ok'. 3) Mark task completed."],
	{
		cwd: testDir,
		encoding: "utf8",
		timeout: 120_000,
	},
);

const targetFile = join(testDir, "verified.txt");
const fileCreated = existsSync(targetFile) && readFileSync(targetFile, "utf8").includes("installed-ok");
check("compliant workflow with todowrite succeeded through plugin", fileCreated);

// Clean up
rmSync(testDir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
