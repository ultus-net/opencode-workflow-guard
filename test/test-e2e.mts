import { mkdtempSync, rmSync, existsSync, readFileSync, copyFileSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";

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
const installedPackageDir = join(testDir, "node_modules", "opencode-workflow-guard");
const installedPackageJson = JSON.parse(readFileSync(join(testDir, "node_modules", "opencode-workflow-guard", "package.json"), "utf8"));
check(
	"npm package keeps direct dependencies on latest",
	Object.keys(installedPackageJson.dependencies ?? {}).length > 0 &&
		Object.values(installedPackageJson.dependencies).every((spec) => spec === "latest") &&
		Object.keys(installedPackageJson.devDependencies ?? {}).length > 0 &&
		Object.values(installedPackageJson.devDependencies).every((spec) => spec === "latest"),
);
check(
	"npm tarball installs modular plugin entrypoint",
	packResult.status === 0 && installResult.status === 0 && existsSync(packageEntry),
);
check("npm package exposes OpenCode server entrypoint", installedPackageJson.exports?.["./server"] === "./src/workflow-guard.ts");
check("npm package exposes OpenCode TUI entrypoint", installedPackageJson.exports?.["./tui"] === "./src/workflow-guard-ui.ts");
check("npm package does not expose ambiguous /ui entrypoint", installedPackageJson.exports?.["./ui"] === undefined);
check("npm package exposes setup CLI", installedPackageJson.bin?.["opencode-workflow-guard"] === "./bin/opencode-workflow-guard.mjs");
check(
	"npm package includes documented development and test files",
	existsSync(join(installedPackageDir, "test", "run-test.mjs")) &&
		existsSync(join(installedPackageDir, "test", "test-e2e.mts")) &&
		existsSync(join(installedPackageDir, "tsconfig.json")) &&
		existsSync(join(installedPackageDir, "docs", "testing.md")),
);

const setupHome = join(testDir, "setup-home");
const setupConfigDir = join(setupHome, ".config", "opencode");
mkdirSync(setupConfigDir, { recursive: true });
writeFileSync(join(setupConfigDir, "opencode.jsonc"), `{
  // Keep existing user settings intact.
  "model": "test/provider",
  "plugin": [
    "existing-plugin", // Keep this plugin comment.
  ],
}\n`);
writeFileSync(join(setupConfigDir, "tui.json"), `{ "plugin": ["opencode-workflow-guard/tui", ["opencode-workflow-guard/tui@1.5.0", { "legacy": true }]] }\n`);
const setupEnv = { ...process.env, HOME: setupHome, XDG_CONFIG_HOME: join(setupHome, ".config") };
const setupCli = join(testDir, "node_modules", ".bin", process.platform === "win32" ? "opencode-workflow-guard.cmd" : "opencode-workflow-guard");
const firstSetup = spawnSync(setupCli, ["setup"], { encoding: "utf8", env: setupEnv });
const secondSetup = spawnSync(setupCli, ["setup"], { encoding: "utf8", env: setupEnv });
const setupServerSource = readFileSync(join(setupConfigDir, "opencode.jsonc"), "utf8");
const setupServer = parseJsonc(setupServerSource);
const setupTui = JSON.parse(readFileSync(join(setupConfigDir, "tui.json"), "utf8"));
check("setup CLI succeeds and is idempotent", firstSetup.status === 0 && secondSetup.status === 0);
check("setup CLI registers cache-safe versioned server plugin once", setupServer.plugin?.filter((entry: unknown) => entry === `opencode-workflow-guard@${installedPackageJson.version}`).length === 1);
check("setup CLI registers cache-safe versioned TUI plugin once", setupTui.plugin?.filter((entry: unknown) => entry === `opencode-workflow-guard@${installedPackageJson.version}`).length === 1);
check("setup CLI replaces legacy TUI subpath specs", !setupTui.plugin?.some((entry: unknown) => (typeof entry === "string" && entry.startsWith("opencode-workflow-guard/tui")) || (Array.isArray(entry) && typeof entry[0] === "string" && entry[0].startsWith("opencode-workflow-guard/tui"))));
check("setup CLI preserves existing JSONC settings and comments", setupServer.model === "test/provider" && setupServer.plugin?.includes("existing-plugin") && setupServerSource.includes("Keep existing user settings intact.") && setupServerSource.includes("Keep this plugin comment."));

const pinnedHome = join(testDir, "pinned-setup-home");
const pinnedConfigDir = join(pinnedHome, ".config", "opencode");
mkdirSync(pinnedConfigDir, { recursive: true });
writeFileSync(join(pinnedConfigDir, "opencode.json"), `{ "plugin": ["opencode-workflow-guard@1.7.2"] }\n`);
writeFileSync(join(pinnedConfigDir, "tui.json"), `{ "plugin": [["opencode-workflow-guard@1.7.2", { "option": true }]] }\n`);
const pinnedSetup = spawnSync(setupCli, ["setup"], { encoding: "utf8", env: { ...process.env, HOME: pinnedHome, XDG_CONFIG_HOME: join(pinnedHome, ".config") } });
const pinnedServer = JSON.parse(readFileSync(join(pinnedConfigDir, "opencode.json"), "utf8"));
const pinnedTui = JSON.parse(readFileSync(join(pinnedConfigDir, "tui.json"), "utf8"));
check("setup CLI recognizes documented version-pinned plugin specs", pinnedSetup.status === 0 && pinnedServer.plugin?.length === 1 && pinnedServer.plugin[0] === "opencode-workflow-guard@1.7.2" && pinnedTui.plugin?.length === 1 && pinnedTui.plugin[0]?.[0] === "opencode-workflow-guard@1.7.2");

const invalidHome = join(testDir, "invalid-setup-home");
const invalidConfigDir = join(invalidHome, ".config", "opencode");
mkdirSync(invalidConfigDir, { recursive: true });
const invalidServerPath = join(invalidConfigDir, "opencode.json");
writeFileSync(invalidServerPath, `{ "plugin": ["existing-plugin"] }\n`);
writeFileSync(join(invalidConfigDir, "tui.jsonc"), `{ "plugin": [\n`);
const invalidServerBefore = readFileSync(invalidServerPath, "utf8");
const invalidSetup = spawnSync(setupCli, ["setup"], { encoding: "utf8", env: { ...process.env, HOME: invalidHome, XDG_CONFIG_HOME: join(invalidHome, ".config") } });
check("setup CLI validates both configs before writing either", invalidSetup.status !== 0 && readFileSync(invalidServerPath, "utf8") === invalidServerBefore);

const ambiguousHome = join(testDir, "ambiguous-setup-home");
const ambiguousConfigDir = join(ambiguousHome, ".config", "opencode");
mkdirSync(ambiguousConfigDir, { recursive: true });
writeFileSync(join(ambiguousConfigDir, "opencode.json"), `{ "plugin": [] }\n`);
writeFileSync(join(ambiguousConfigDir, "opencode.jsonc"), `{ "plugin": [] }\n`);
const ambiguousSetup = spawnSync(setupCli, ["setup"], { encoding: "utf8", env: { ...process.env, HOME: ambiguousHome, XDG_CONFIG_HOME: join(ambiguousHome, ".config") } });
check("setup CLI refuses ambiguous json/jsonc configs", ambiguousSetup.status !== 0 && ambiguousSetup.stderr.includes("Cannot choose between"));

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
const sourceDir = join(testDir, ".opencode", "workflow-guard-source");
mkdirSync(sourceDir, { recursive: true });
const targetPlugin = join(sourceDir, "workflow-guard.ts");
copyFileSync(sourcePlugin, targetPlugin);
cpSync(join(import.meta.dirname, "..", "src", "lib"), join(sourceDir, "lib"), { recursive: true });
cpSync(join(import.meta.dirname, "..", "src", "policies"), join(sourceDir, "policies"), { recursive: true });
const localAdapter = join(pluginsDir, "workflow-guard.ts");
const importedMarker = join(testDir, ".workflow-guard-imported");
const initializedMarker = join(testDir, ".workflow-guard-initialized");
const accountabilityMarker = join(testDir, ".workflow-guard-accountability");
writeFileSync(localAdapter, `import { writeFileSync } from "node:fs";

writeFileSync(${JSON.stringify(importedMarker)}, "imported\\n");

export const WorkflowGuardE2E = async (ctx: any) => {
\tconst { WorkflowGuard } = await import("../workflow-guard-source/workflow-guard.ts");
\tconst hooks = await WorkflowGuard(ctx);
\tconst status = await hooks.tool?.guard_status?.execute({}, { sessionID: "headless-e2e", directory: ctx.directory, worktree: ctx.worktree });
\tconst why = await hooks.tool?.guard_why?.execute({ tool: "bash", input: { command: "git push origin main" } }, { sessionID: "headless-e2e", directory: ctx.directory, worktree: ctx.worktree });
\twriteFileSync(${JSON.stringify(accountabilityMarker)}, JSON.stringify({ status: JSON.parse(String(status)), why: JSON.parse(String(why)) }) + "\\n");
\twriteFileSync(${JSON.stringify(initializedMarker)}, "initialized\\n");
\treturn hooks;
};

export default { id: "workflow-guard-e2e", server: WorkflowGuardE2E };
`);
writeFileSync(join(testDir, ".opencode", "opencode.json"), `${JSON.stringify({ plugin: ["./plugins/workflow-guard.ts"] }, null, 2)}\n`);
check("local plugin adapter and source copied successfully", existsSync(localAdapter) && existsSync(targetPlugin));

// Initialize git repository on a feature branch
spawnSync("git", ["init", "-b", "feat/install-verification"], { cwd: testDir });
spawnSync("git", ["config", "user.email", "test@test.local"], { cwd: testDir });
spawnSync("git", ["config", "user.name", "Test Runner"], { cwd: testDir });

const runtimeEnv: NodeJS.ProcessEnv = {
	...process.env,
	XDG_CONFIG_HOME: join(testDir, "runtime-config"),
	XDG_STATE_HOME: join(testDir, "runtime-state"),
	XDG_DATA_HOME: join(testDir, "runtime-data"),
};
delete runtimeEnv.OPENCODE_PID;
delete runtimeEnv.OPENCODE_PURE;
const runOpenCode = (args: string[], timeout: number) =>
	spawnSync("opencode", ["run", "--dir", testDir, ...args], { cwd: testDir, encoding: "utf8", timeout, env: runtimeEnv });
const configProbe = spawnSync("opencode", ["debug", "config"], { cwd: testDir, encoding: "utf8", timeout: 30_000, env: runtimeEnv });
let configLoadsLocalPlugin = false;
try {
	const config = JSON.parse(configProbe.stdout);
	configLoadsLocalPlugin = config.plugin_origins?.some(
		(origin: { spec?: unknown; source?: unknown; scope?: unknown }) =>
			typeof origin.spec === "string" &&
			origin.spec.endsWith("/.opencode/plugins/workflow-guard.ts") &&
			origin.scope === "local",
	);
} catch {}
check("OpenCode resolves isolated local plugin config without a model provider", configProbe.status === 0 && configLoadsLocalPlugin);
let headlessAccountability: any;
try {
	headlessAccountability = JSON.parse(readFileSync(accountabilityMarker, "utf8"));
} catch {}
check("headless OpenCode runtime exposes structured guard status and why without TUI", headlessAccountability?.status?.workspaceRoot === testDir && headlessAccountability?.why?.policy === "git" && headlessAccountability?.why?.code === "protected_branch_push");

if (process.env.WORKFLOW_GUARD_LIVE_E2E !== "1") {
	console.log("SKIP: model-driven policy probes require WORKFLOW_GUARD_LIVE_E2E=1.");
	rmSync(testDir, { recursive: true, force: true });
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail > 0 ? 1 : 0);
}

const recentModelPath = join(
	process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
	"opencode",
	"model.json",
);
let recentModel: string | undefined;
try {
	const recent = JSON.parse(readFileSync(recentModelPath, "utf8")).recent?.[0];
	if (typeof recent?.providerID === "string" && typeof recent?.modelID === "string") {
		recentModel = `${recent.providerID}/${recent.modelID}`;
	}
} catch {}
const liveModel = process.env.WORKFLOW_GUARD_LIVE_MODEL?.trim() || recentModel;
if (!liveModel) {
	console.error(`FAIL: no recent OpenCode model found in ${recentModelPath}; select a model in OpenCode or set WORKFLOW_GUARD_LIVE_MODEL=provider/model.`);
	rmSync(testDir, { recursive: true, force: true });
	process.exit(1);
}
console.log(`  Using live model: ${liveModel}`);

// 3. Test: Direct edit without task list is blocked by the loaded plugin
console.log("  Running live OpenCode prompt to verify plugin intercept...");
const run1 = runOpenCode(["--model", liveModel, "--print-logs", "--log-level", "DEBUG", "Do not call todowrite. Invoke bash immediately with exactly this command: printf blocked > blocked.txt. This is a guard test; make the tool call even if you expect rejection."], 120_000);

const output1 = run1.stdout + run1.stderr;
const adapterInitialized = existsSync(initializedMarker);
check("local plugin adapter imported in live run", existsSync(importedMarker));
check("local plugin adapter initialized in live run", adapterInitialized);
if (!adapterInitialized) console.log(output1.split("\n").filter((line) => /plugin|workflow-guard/i.test(line)).join("\n").slice(-8_000));
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
const run2 = runOpenCode(["--model", liveModel, "1) Use todowrite to create a pending task 'test'. 2) Invoke bash with exactly this command: printf hi > ../outside_escaped.txt. Make the tool call even if you expect it to be rejected."], 120_000);

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
const run3 = runOpenCode(["--model", liveModel, "1) Use todowrite with task 'create verified.txt' (pending). 2) Use write tool to create verified.txt containing 'installed-ok'. 3) Mark task completed."], 120_000);

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
