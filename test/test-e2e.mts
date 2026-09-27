import { mkdtempSync, rmSync, existsSync, readFileSync, copyFileSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";

let pass = 0;
let fail = 0;
let unavailable = 0;
const check = (name: string, cond: unknown): boolean => {
	cond ? (pass++, console.log("  ok  " + name)) : (fail++, console.log("FAIL  " + name));
	return Boolean(cond);
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
	if (!process.env.WG_E2E_KEEP) rmSync(testDir, { recursive: true, force: true });
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail > 0 ? 1 : 0);
}
console.log(`  Found OpenCode version: ${opencodeCheck.stdout.trim()}`);

const opencodeDir = join(testDir, ".opencode");
const pluginsDir = join(opencodeDir, "plugins");
mkdirSync(pluginsDir, { recursive: true });

// Pre-seed .opencode with dependencies already installed into testDir
// so opencode does not execute a cold network install at runtime startup.
const opencodeVersionRaw = opencodeCheck.stdout.trim();
const opencodeSemver = opencodeVersionRaw.match(/(\d+\.\d+\.\d+)/)?.[1] ?? opencodeVersionRaw;
const opencodeMajor = Number(opencodeSemver.split(".")[0] ?? 1);
const isOpenCodeV2 = opencodeMajor >= 2;
const lockPath = join(testDir, "package-lock.json");
if (existsSync(lockPath) && existsSync(join(testDir, "node_modules"))) {
	try {
		const lock = JSON.parse(readFileSync(lockPath, "utf8"));
		lock.name = ".opencode";
		const installedVersions: Record<string, string> = {};
		for (const key of ["node_modules/@opencode-ai/plugin", "node_modules/@opencode/plugin"]) {
			const version = lock.packages?.[key]?.version;
			if (typeof version === "string" && version) installedVersions[key.replace("node_modules/", "")] = version;
		}
		if (isOpenCodeV2) {
			// V2 loads .opencode deps with the real installed versions; rewriting
			// them to the CLI version string would produce invalid semver.
			const dependencies: Record<string, string> = {};
			for (const [name, version] of Object.entries(installedVersions)) dependencies[name] = version;
			if (!Object.keys(dependencies).length) dependencies["@opencode/plugin"] = "latest";
			if (lock.packages?.[""]) {
				lock.packages[""].dependencies = dependencies;
			}
			writeFileSync(join(opencodeDir, "package-lock.json"), JSON.stringify(lock, null, 2) + "\n");
			writeFileSync(join(opencodeDir, "package.json"), JSON.stringify({ name: ".opencode", dependencies }, null, 2) + "\n");
		} else {
			if (lock.packages?.["node_modules/@opencode-ai/plugin"]) {
				lock.packages["node_modules/@opencode-ai/plugin"].version = opencodeSemver;
			}
			if (lock.packages?.[""]) {
				lock.packages[""].dependencies = { "@opencode-ai/plugin": opencodeSemver };
			}
			writeFileSync(join(opencodeDir, "package-lock.json"), JSON.stringify(lock, null, 2) + "\n");
			writeFileSync(join(opencodeDir, "package.json"), JSON.stringify({ name: ".opencode", dependencies: { "@opencode-ai/plugin": opencodeSemver } }, null, 2) + "\n");
		}
		cpSync(join(testDir, "node_modules"), join(opencodeDir, "node_modules"), { recursive: true });
	} catch {}
}

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
import { Plugin } from "@opencode/plugin";

writeFileSync(${JSON.stringify(importedMarker)}, "imported\\n");

// Load the shipped dual plugin: V1 probes call server(), V2 runs the real
// setup(ctx) against the real plugin context and probes the REGISTERED tools.
const loaded = await import("../workflow-guard-source/workflow-guard.ts");

const headlessToolContext = { sessionID: "headless-e2e", agent: "build", messageID: "msg_headless", id: "call_headless", progress: async () => {} };

const runV2Probes = async (ctx: any) => {
\tawait loaded.default.setup(ctx);
\tconst tools = await ctx.tool.list();
\tconst byId = (id: string) => tools.find((t: any) => t.id === id);
\tconst todowrite = byId("todowrite");
\tconst guardStatus = byId("guard_status");
\tconst guardWhy = byId("guard_why");
\tconst pick = (r: any) => (typeof r?.content === "string" ? r.content : JSON.stringify(r));
\tconst statusRes = guardStatus ? await guardStatus.execute({}, headlessToolContext) : undefined;
\tconst whyProbes: Record<string, { tool: string; input: Record<string, unknown> }> = {
\t\tgit: { tool: "bash", input: { command: "git push origin main" } },
\t\t"secrets-read": { tool: "read", input: { filePath: ".env" } },
\t\t"secrets-shell": { tool: "bash", input: { command: "cat .env" } },
\t\t"boundary-write": { tool: "write", input: { filePath: "../outside_escaped.txt", content: "probe" } },
\t\t"shell-tty": { tool: "bash", input: { command: "vim notes.txt" } },
\t};
\tconst whyResults: Record<string, any> = {};
\tfor (const [name, probe] of Object.entries(whyProbes)) {
\t\tconst res = guardWhy ? await guardWhy.execute(probe, headlessToolContext) : undefined;
\t\twhyResults[name] = res === undefined ? null : JSON.parse(pick(res));
\t}
\twriteFileSync(${JSON.stringify(accountabilityMarker)}, JSON.stringify({
\t\ttools: tools.map((t: any) => t.id),
\t\ttodowriteEnriched: Boolean(todowrite?.description?.includes("Workflow Guard lifecycle")),
\t\tstatus: JSON.parse(pick(statusRes)),
\t\twhy: whyResults.git,
\t\twhyProbes: whyResults,
\t}) + "\\n");
\twriteFileSync(${JSON.stringify(initializedMarker)}, "initialized\\n");
};

const runV1Probes = async (ctx: any) => {
\tconst hooks = await loaded.default.server(ctx);
\tconst directory = ctx?.location?.directory ?? ctx?.directory ?? process.cwd();
\tconst toolCtx = { sessionID: "headless-e2e", directory, worktree: directory };
\tconst status = await hooks.tool?.guard_status?.execute({}, toolCtx);
\tconst whyProbes: Record<string, { tool: string; input: Record<string, unknown> }> = {
\t\tgit: { tool: "bash", input: { command: "git push origin main" } },
\t\t"secrets-read": { tool: "read", input: { filePath: ".env" } },
\t\t"secrets-shell": { tool: "bash", input: { command: "cat .env" } },
\t\t"boundary-write": { tool: "write", input: { filePath: "../outside_escaped.txt", content: "probe" } },
\t\t"shell-tty": { tool: "bash", input: { command: "vim notes.txt" } },
\t};
\tconst whyResults: Record<string, any> = {};
\tfor (const [name, probe] of Object.entries(whyProbes)) {
\t\tconst res = await hooks.tool?.guard_why?.execute(probe, toolCtx);
\t\twhyResults[name] = res === undefined ? null : JSON.parse(String(res));
\t}
\twriteFileSync(${JSON.stringify(accountabilityMarker)}, JSON.stringify({ status: JSON.parse(String(status)), why: whyResults.git, whyProbes: whyResults }) + "\\n");
\twriteFileSync(${JSON.stringify(initializedMarker)}, "initialized\\n");
\treturn hooks;
};

export default {
\t...Plugin.define({
\t\tid: "workflow-guard-e2e",
\t\tasync setup(ctx: any) {
\t\t\twriteFileSync(${JSON.stringify(importedMarker)}, "imported\\n");
\t\t\ttry {
\t\t\t\tawait runV2Probes(ctx);
\t\t\t} catch (error) {
\t\t\t\twriteFileSync(${JSON.stringify(accountabilityMarker)}, JSON.stringify({ error: String((error as Error)?.message ?? error), stack: String((error as Error)?.stack ?? "") }) + "\\n");
\t\t\t\tthrow error;
\t\t\t}
\t\t},
\t}),
\tserver: async (ctx: any) => {
\t\treturn await runV1Probes(ctx);
\t},
};
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
delete runtimeEnv.OPENCODE;
if (isOpenCodeV2) {
	// V2 runs a shared managed service on a fixed default port. Each run uses
	// its own isolated XDG dirs, so pick a run-unique port to keep concurrent
	// and sequential runs from colliding on service startup.
	const servicePort = 49400 + (process.pid % 1000);
	spawnSync("opencode", ["service", "set", "port", String(servicePort)], { cwd: testDir, encoding: "utf8", env: runtimeEnv, timeout: 30_000 });
}
const runOpenCode = (args: string[], timeout: number) =>
	spawnSync("opencode", ["run", "--dir", testDir, ...args], { cwd: testDir, encoding: "utf8", timeout, env: runtimeEnv });
const configProbe = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
	const child = spawn("opencode", ["debug", "config"], { cwd: testDir, env: runtimeEnv });
	let stdout = "";
	let stderr = "";
	let timer: NodeJS.Timeout | undefined;
	let pollInterval: NodeJS.Timeout | undefined;

	const done = (status: number | null) => {
		if (timer) clearTimeout(timer);
		if (pollInterval) clearInterval(pollInterval);
		try { child.kill("SIGTERM"); } catch {}
		resolve({ status: status ?? 0, stdout, stderr });
	};

	const checkReady = () => {
		try {
			const parsed = JSON.parse(stdout);
			// V1 prints an object with plugin_origins; V2 prints a config document
			// array. Either way, the adapter's setup/server must have run.
			const hasConfig = Boolean(parsed?.plugin_origins) || Array.isArray(parsed);
			if (hasConfig && existsSync(initializedMarker)) {
				done(0);
			}
		} catch {}
	};

	pollInterval = setInterval(checkReady, 50);

	child.stdout?.on("data", (d) => {
		stdout += d.toString();
		checkReady();
	});
	child.stderr?.on("data", (d) => { stderr += d.toString(); });
	child.on("close", (code) => done(code));
	child.on("error", () => done(null));

	timer = setTimeout(() => done(null), 30_000);
});
if (isOpenCodeV2) {
	// V2's debug config can exit before plugin setup completes; wait briefly
	// for the adapter's initialized marker before evaluating plugin checks.
	for (let i = 0; i < 200 && !existsSync(initializedMarker); i++) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}
let configLoadsLocalPlugin = false;
try {
	if (isOpenCodeV2) {
		// V2 has no plugin_origins in debug config output; the adapter's setup
		// writing the imported marker is the plugin-load proof.
		configLoadsLocalPlugin = existsSync(importedMarker) && existsSync(initializedMarker);
	} else {
		const config = JSON.parse(configProbe.stdout);
		configLoadsLocalPlugin = config.plugin_origins?.some(
			(origin: { spec?: unknown; source?: unknown; scope?: unknown }) =>
				typeof origin.spec === "string" &&
				origin.spec.endsWith("/.opencode/plugins/workflow-guard.ts") &&
				origin.scope === "local",
		);
	}
} catch {}
const configCheckPassed = Boolean(check("OpenCode resolves isolated local plugin config without a model provider", configProbe.status === 0 && configLoadsLocalPlugin));
if (!configCheckPassed) {
	console.log(`  configProbe stderr: ${configProbe.stderr.slice(0, 2000)}`);
	console.log(`  configProbe stdout: ${configProbe.stdout.slice(0, 2000)}`);
	console.log(`  importedMarker: ${existsSync(importedMarker)} initializedMarker: ${existsSync(initializedMarker)}`);
}
let headlessAccountability: any;
try {
	headlessAccountability = JSON.parse(readFileSync(accountabilityMarker, "utf8"));
} catch {}
check("headless OpenCode runtime exposes structured guard status and why without TUI", headlessAccountability?.status?.workspaceRoot === testDir && headlessAccountability?.why?.policy === "git" && headlessAccountability?.why?.code === "protected_branch_push");
const whyProbe = (name: string): any => headlessAccountability?.whyProbes?.[name];
check("headless guard_why simulates secret read policy via read tool", whyProbe("secrets-read")?.policy === "secrets" && whyProbe("secrets-read")?.code === "secret_read" && whyProbe("secrets-read")?.status === "blocked");
check("headless guard_why simulates secret read policy via shell", whyProbe("secrets-shell")?.policy === "secrets" && whyProbe("secrets-shell")?.code === "secret_read" && whyProbe("secrets-shell")?.status === "blocked");
check("headless guard_why simulates workspace boundary policy via write tool", whyProbe("boundary-write")?.policy === "boundary" && whyProbe("boundary-write")?.code === "workspace_escape" && whyProbe("boundary-write")?.status === "blocked");
check("headless guard_why simulates interactive tty shell-safety policy", whyProbe("shell-tty")?.policy === "shell-safety" && whyProbe("shell-tty")?.code === "interactive_tty" && whyProbe("shell-tty")?.status === "blocked");
if (isOpenCodeV2) {
	// The V2 adapter runs the shipped setup(ctx) for real; verify the
	// registered tool surface. Builtin description enrichment is best-effort:
	// builtins are not visible to ctx.tool.list() during plugin setup, so
	// todowriteEnriched is reported but not asserted.
	check("V2 setup registers custom guard tools", (headlessAccountability?.tools ?? []).includes("guard_status") && (headlessAccountability?.tools ?? []).includes("guard_why"));
	console.log(`  note: builtin todowrite description enriched under V2: ${headlessAccountability?.todowriteEnriched === true ? "yes" : "unknown at setup time"}`);
}

if (process.env.WORKFLOW_GUARD_LIVE_E2E !== "1") {
	console.log("SKIP: model-driven policy probes require WORKFLOW_GUARD_LIVE_E2E=1.");
	if (!process.env.WG_E2E_KEEP) rmSync(testDir, { recursive: true, force: true });
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
	if (!process.env.WG_E2E_KEEP) rmSync(testDir, { recursive: true, force: true });
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
if (!process.env.WG_E2E_KEEP) rmSync(testDir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed, ${unavailable} live unavailable`);
process.exit(fail ? 1 : 0);
