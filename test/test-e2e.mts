import { mkdtempSync, rmSync, existsSync, readFileSync, copyFileSync, cpSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0;
let fail = 0;
let unavailable = 0;
const check = (name: string, cond: unknown): void => {
	cond ? (pass++, console.log("  ok  " + name)) : (fail++, console.log("FAIL  " + name));
};
const providerUnavailable = (output: string): boolean =>
	/available credits|insufficient credits|rate limit|too many requests|capacity|overloaded/i.test(output);
const checkLive = (name: string, cond: unknown, output: string): boolean => {
	if (!cond && providerUnavailable(output)) {
		unavailable++;
		console.log("SKIP: " + name + " (model provider unavailable before guard behavior could be exercised)");
		return true;
	}
	check(name, cond);
	return Boolean(cond);
};

console.log("- OpenCode Plugin Installation & Runtime Load Test -");

// 1. Set up a fresh isolated project with plugin installed. These package
// checks run even when the optional live OpenCode binary is unavailable.
const testDir = mkdtempSync(join(tmpdir(), "wg-install-test-"));

// Verify the publish artifact resolves its modular entrypoint, not only the
// checkout/local-copy layout used by the live plugin test below.
const packResult = spawnSync("npm", ["pack", "--pack-destination", testDir], {
	cwd: join(import.meta.dirname, ".."),
	encoding: "utf8",
});
const tarballName = packResult.stdout.trim().split("\n").at(-1) ?? "";
const tarballPath = join(testDir, tarballName);
const installResult = spawnSync("npm", ["install", "--ignore-scripts", tarballPath], {
	cwd: testDir,
	encoding: "utf8",
});
const packageEntry = join(testDir, "node_modules", "opencode-workflow-guard", "src", "workflow-guard.ts");
const installedPackageJson = JSON.parse(readFileSync(join(testDir, "node_modules", "opencode-workflow-guard", "package.json"), "utf8"));
check(
	"npm tarball installs modular plugin entrypoint",
	packResult.status === 0 && installResult.status === 0 && existsSync(packageEntry),
);
check("npm package exposes OpenCode server entrypoint", installedPackageJson.exports?.["./server"] === "./src/workflow-guard.ts");
check("npm package exposes OpenCode TUI entrypoint", installedPackageJson.exports?.["./tui"] === "./src/workflow-guard-ui.ts");
check("npm package does not expose ambiguous /ui entrypoint", installedPackageJson.exports?.["./ui"] === undefined);

// Verify the export map resolves both entrypoints. OpenCode loads the package's
// raw TypeScript entrypoints with its own module loader at runtime, while plain
// Node will not type-strip .ts files under node_modules; resolution (not direct
// import) is therefore the correct invariant to assert here.
const serverImport = spawnSync("node", ["--input-type=module", "-e", `
	const serverUrl = import.meta.resolve('opencode-workflow-guard/server', 'file://' + process.cwd() + '/dummy.js');
	const tuiUrl = import.meta.resolve('opencode-workflow-guard/tui', 'file://' + process.cwd() + '/dummy.js');
	if (!serverUrl.endsWith('/src/workflow-guard.ts') || !tuiUrl.endsWith('/src/workflow-guard-ui.ts')) process.exit(2);
	`], {
		cwd: testDir,
		encoding: "utf8",
	});
check("packed server and TUI entrypoints resolve correctly", serverImport.status === 0);
check("server and TUI package specs resolve to different modules", installedPackageJson.exports?.["."] !== installedPackageJson.exports?.["./tui"]);

// 2. Verify opencode binary is available for live runtime tests.
const opencodeCheck = spawnSync("opencode", ["--version"], { encoding: "utf8" });
if (opencodeCheck.status !== 0) {
	console.log("SKIP: opencode CLI is not available in PATH. Package checks passed; skipping live runtime load tests.");
	rmSync(testDir, { recursive: true, force: true });
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail > 0 ? 1 : 0);
}
console.log(`  Found OpenCode version: ${opencodeCheck.stdout.trim()}`);

const pluginsDir = join(testDir, ".opencode", "plugins");
mkdirSync(pluginsDir, { recursive: true });

const sourcePlugin = join(import.meta.dirname, "..", "src", "workflow-guard.ts");
const targetPlugin = join(pluginsDir, "workflow-guard.ts");
copyFileSync(sourcePlugin, targetPlugin);
cpSync(join(import.meta.dirname, "..", "src", "lib"), join(pluginsDir, "lib"), { recursive: true });
cpSync(join(import.meta.dirname, "..", "src", "policies"), join(pluginsDir, "policies"), { recursive: true });
check("plugin copied to .opencode/plugins/ successfully", existsSync(targetPlugin));

// Initialize git repository on a feature branch
spawnSync("git", ["init", "-b", "feat/install-verification"], { cwd: testDir });
spawnSync("git", ["config", "user.email", "test@test.local"], { cwd: testDir });
spawnSync("git", ["config", "user.name", "Test Runner"], { cwd: testDir });

const startup = spawnSync("opencode", ["debug", "startup"], { cwd: testDir, encoding: "utf8", timeout: 30_000 });
check("OpenCode loads plugin without a model provider", startup.status === 0);

if (process.env.WORKFLOW_GUARD_LIVE_E2E !== "1") {
	console.log("SKIP: model-driven policy probes require WORKFLOW_GUARD_LIVE_E2E=1.");
	rmSync(testDir, { recursive: true, force: true });
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail > 0 ? 1 : 0);
}

// 3. Test: Direct edit without task list is blocked by the loaded plugin
console.log("  Running live OpenCode prompt to verify plugin intercept...");
const run1 = spawnSync(
	"opencode",
	["run", "--dir", testDir, "Do not call todowrite. Invoke bash immediately with exactly this command: printf blocked > blocked.txt. This is a guard test; make the tool call even if you expect rejection."],
	{
		cwd: testDir,
		encoding: "utf8",
		timeout: 120_000,
	},
);

const output1 = run1.stdout + run1.stderr;
const blockedByGuard =
	output1.includes("[workflow-guard] Blocked: no active todo item") ||
	output1.includes("blocked write: no active todo item") ||
	output1.includes("shell file mutation with no active todo item");
const run1AccountedFor = checkLive("plugin loaded and intercepted mutation without active todo", blockedByGuard, output1);
if (!run1AccountedFor) {
	console.log("  task-gate output tail:");
	console.log(output1.slice(-2_000));
}

// 4. Test: Workspace boundary escape is blocked
const run2 = spawnSync(
	"opencode",
	["run", "--dir", testDir, "1) Use todowrite to create a pending task 'test'. 2) Invoke bash with exactly this command: printf hi > ../outside_escaped.txt. Make the tool call even if you expect it to be rejected."],
	{
		cwd: testDir,
		encoding: "utf8",
		timeout: 120_000,
	},
);

const output2 = run2.stdout + run2.stderr;
const boundaryBlocked =
	output2.includes("escapes workspace root") ||
	output2.includes("path escapes workspace") ||
	output2.includes("outside the workspace root");
const run2AccountedFor = checkLive("plugin loaded and enforced workspace boundary escape guard", boundaryBlocked, output2);
if (!run2AccountedFor) {
	console.log("  boundary-test output tail:");
	console.log(output2.slice(-2_000));
}

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
const output3 = run3.stdout + run3.stderr;
const run3AccountedFor = checkLive("compliant workflow with todowrite succeeded through plugin", fileCreated, output3);
if (!run3AccountedFor) {
	console.log("  compliant-workflow output tail:");
	console.log(output3.slice(-2_000));
}

// Clean up
rmSync(testDir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed, ${unavailable} live unavailable`);
process.exit(fail ? 1 : 0);
