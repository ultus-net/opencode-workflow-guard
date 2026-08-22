import { mkdtempSync, writeFileSync, rmSync, symlinkSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginModule } from "@opencode-ai/plugin";
import {
	guardToolCall,
	setWorkspaceRoot,
	setSdkClient,
	WorkflowGuard,
	runVerify,
	getCleanEnv,
	resetVerifyState,
	recordMutation,
	getLastMutationTimestamp,
	recordVerifyResult,
	getAuditFilePath,
	buildReviewRubric,
	recordReviewResult,
	getLastReviewResult,
	resetReviewState,
	isSecretPath,
	loadProjectConfig,
	reloadProjectConfig,
	extractInterpreterPayload,
	isBranchAlreadyMergedOrClosed,
	checkMergeConflicts,
	checkBranchBaseIsUpToDate,
	branchHasDocumentationChange,
	isDocumentationRequired,
	default as defaultExport,
} from "./workflow-guard.ts";
import { WorkflowGuardTui } from "./workflow-guard-ui.ts";

let pass = 0;
let fail = 0;
const check = (name: string, cond: unknown): void => {
	cond ? (pass++, console.log("  ok  " + name)) : (fail++, console.log("FAIL  " + name));
};

const root = mkdtempSync(join(tmpdir(), "wg-test-"));
const prevLive = process.env.WORKFLOW_GUARD_ALLOW_LIVE;
delete process.env.WORKFLOW_GUARD_ALLOW_LIVE;
setWorkspaceRoot(root);

interface TestTodo {
	content: string;
	status: "pending" | "in_progress" | "completed" | "cancelled";
	priority: "high" | "medium" | "low";
}

// ── Fake SDK client mirroring the documented endpoints used by the guard:
//    GET /session/:id/todo -> { data: Todo[] }, GET /session/:id -> { data: Session }
const fakeTodos = new Map<string, TestTodo[]>();
const fakeParents = new Map<string, string>();
const todo = (sessionID: string, ...items: TestTodo[]): void => {
	fakeTodos.set(sessionID, items);
};
const item = (
	content: string,
	status: "pending" | "in_progress" | "completed" | "cancelled" = "pending",
	priority: "high" | "medium" | "low" = "medium",
): TestTodo => ({ content, status, priority });

const fakeClient = {
	session: {
		todo: async ({ path }: { path: { id: string } }) => ({
			data: fakeTodos.get(path.id) ?? [],
		}),
		get: async ({ path }: { path: { id: string } }) => ({
			data: { id: path.id, parentID: fakeParents.get(path.id) },
		}),
	},
};
setSdkClient(fakeClient);

const call = (toolName: string, input: unknown, context?: { sessionID?: string }) =>
	guardToolCall(toolName, input, context);
const shell = (cmd: string) => call("bash", { command: cmd });
const blocked = (r: unknown): boolean => typeof r === "string";

console.log("- Policy 1: native todo gate -");
todo("s-empty");
todo("s-done", item("a", "completed"), item("b", "completed"));
todo("s-cancelled", item("a", "completed"), item("b", "cancelled"));
todo("s-active", item("a", "pending"));
todo("s-progress", item("a", "in_progress"));
todo("s-mixed", item("a", "completed"), item("b", "pending"));
check("edit blocked with no todos", blocked(await call("edit", { filePath: join(root, "a.ts"), content: "x" }, { sessionID: "s-empty" })));
check("write blocked with no todos", blocked(await call("write", { filePath: join(root, "a.ts"), content: "x" }, { sessionID: "s-empty" })));
check("apply_patch blocked with no todos", blocked(await call("apply_patch", { patchText: "*** x" }, { sessionID: "s-empty" })));
check("edit blocked when all todos completed", blocked(await call("edit", { filePath: join(root, "a.ts"), content: "x" }, { sessionID: "s-done" })));
check("edit blocked when all todos completed/cancelled", blocked(await call("edit", { filePath: join(root, "a.ts"), content: "x" }, { sessionID: "s-cancelled" })));
check("edit allowed with pending todo", !(await call("edit", { filePath: join(root, "a.ts"), content: "x" }, { sessionID: "s-active" })));
check("edit allowed with in_progress todo", !(await call("edit", { filePath: join(root, "a.ts"), content: "x" }, { sessionID: "s-progress" })));
check("edit allowed with mixed pending/completed", !(await call("edit", { filePath: join(root, "a.ts"), content: "x" }, { sessionID: "s-mixed" })));
check("task gate is per session (other session's todos don't help)", blocked(await call("edit", { filePath: join(root, "a.ts"), content: "x" }, { sessionID: "s-empty" })));

console.log("- Policy 1: todowrite focus & lifecycle validation -");
// Focus rule: only 1 in_progress
check("todowrite allows 1 in_progress", !(await call("todowrite", { todos: [item("a", "in_progress"), item("b", "pending")] }, { sessionID: "s-empty" })));
check("todowrite blocks >1 in_progress (focus rule)", blocked(await call("todowrite", { todos: [item("a", "in_progress"), item("b", "in_progress")] }, { sessionID: "s-empty" })));
// Flexible out-of-order completion allows finishing independent items without artificial sequential blockers
check("todowrite allows flexible out-of-order completion", !(await call("todowrite", { todos: [item("a", "pending"), item("b", "completed")] }, { sessionID: "s-empty" })));
// No silent deletion: active task cannot silently vanish
todo("s-lifecycle", item("task 1", "completed"), item("task 2", "in_progress"), item("task 3", "pending"));
check("todowrite allows updating active tasks to completed/cancelled", !(await call("todowrite", { todos: [item("task 1", "completed"), item("task 2", "completed"), item("task 3", "cancelled")] }, { sessionID: "s-lifecycle" })));
check("todowrite blocks silently dropping task 2 without completion", blocked(await call("todowrite", { todos: [item("task 1", "completed"), item("task 3", "pending")] }, { sessionID: "s-lifecycle" })));
// Fresh list allowed once all previous tasks are finished
todo("s-finished", item("old 1", "completed"), item("old 2", "cancelled"));
check("todowrite allows fresh list when previous list is 100% finished", !(await call("todowrite", { todos: [item("new 1", "pending")] }, { sessionID: "s-finished" })));

console.log("- Policy 1: subagent parent-chain inheritance -");
fakeParents.set("s-sub", "s-active");
check("subagent inherits parent's active todos", !(await call("edit", { filePath: join(root, "a.ts"), content: "x" }, { sessionID: "s-sub" })));
fakeParents.set("s-sub2", "s-mid");
todo("s-mid"); // empty middle hop
fakeParents.set("s-mid", "s-active");
check("subagent walks up to grandparent's todos", !(await call("edit", { filePath: join(root, "a.ts"), content: "x" }, { sessionID: "s-sub2" })));
fakeParents.set("s-sub3", "s-active");
todo("s-sub3", item("own work", "completed"));
check("subagent's own todos take precedence (all completed -> blocked)", blocked(await call("edit", { filePath: join(root, "a.ts"), content: "x" }, { sessionID: "s-sub3" })));
fakeParents.set("s-sub-done", "s-done");
check("subagent blocked when parent's todos all completed", blocked(await call("edit", { filePath: join(root, "a.ts"), content: "x" }, { sessionID: "s-sub-done" })));
fakeParents.set("s-cycle-a", "s-cycle-b");
fakeParents.set("s-cycle-b", "s-cycle-a");
check("parent-chain cycles terminate (blocked, no hang)", blocked(await call("edit", { filePath: join(root, "a.ts"), content: "x" }, { sessionID: "s-cycle-a" })));

console.log("- Policy 1: fail-open when todos can't be determined -");
setSdkClient({ session: { todo: async () => { throw new Error("boom"); } } });
check("fetch failure fails open", !(await call("edit", { filePath: join(root, "a.ts"), content: "x" }, { sessionID: "s-active" })));
setSdkClient(undefined);
check("missing client fails open", !(await call("edit", { filePath: join(root, "a.ts"), content: "x" }, { sessionID: "s-active" })));
check("missing sessionID fails open", !(await call("edit", { filePath: join(root, "a.ts"), content: "x" })));
setSdkClient(fakeClient);

console.log("- Policy 2: push to main/master -");
check("block git push origin main", blocked(await shell("git push origin main")));
check("block git push origin master", blocked(await shell("git push origin master")));
check("block git push --force origin main", blocked(await shell("git push --force origin main")));
check("allow git push origin feature/x", !(await shell("git push origin feature/x")));
check("allow push to main-backup (ref-like path)", !(await shell("git push origin main-backup")));

console.log("- Policy 3: PR changelog (GitHub & Azure DevOps) -");
check("block gh pr create without changelog", blocked(await shell("gh pr create --title t --body 'no changes here'")));
check("allow gh pr create with Changelog: body", !(await shell("gh pr create --title t --body 'Changelog: fixed stuff'")));
const bodyFile = join(root, "pr-body.md");
writeFileSync(bodyFile, "## Changelog\n- fix\n");
check("allow gh pr create with -F body-file containing changelog", !(await shell(`gh pr create -F ${bodyFile}`)));
check("block az repos pr create without changelog", blocked(await shell("az repos pr create --title t --description 'no changes here'")));
check("allow az repos pr create with Changelog: description", !(await shell("az repos pr create --title t --description 'Changelog: added feature'")));
check("allow az repos pr create with -d Changelog", !(await shell("az repos pr create --title t -d 'Changelog: added feature'")));
check("allow az repos pr create with --description-file containing changelog", !(await shell(`az repos pr create --description-file ${bodyFile}`)));
check("allow git commit message mentioning gh pr create without changelog block", !(await shell("git commit -m 'feat: add gh pr create support'")));
console.log("- Policy 4: destructive commands -");
check("block kubectl delete", blocked(await shell("kubectl delete pod foo")));
check("block helm uninstall", blocked(await shell("helm uninstall my-release")));
check("block terraform destroy", blocked(await shell("terraform destroy -auto-approve")));
check("block tofu destroy", blocked(await shell("tofu destroy")));
check("block pulumi destroy", blocked(await shell("pulumi destroy")));
check("block az group delete", blocked(await shell("az group delete -g rg-prod")));
check("block aws ec2 terminate-instances", blocked(await shell("aws ec2 terminate-instances --instance-ids i-1")));
check("block psql drop table", blocked(await shell("psql -c 'DROP TABLE users'")));
check("block remote curl DELETE", blocked(await shell("curl -X DELETE https://api.example.com/thing/1")));
check("allow localhost curl DELETE", !(await shell("curl -X DELETE http://localhost:8080/thing")));
check("allow curl POST to remote", !(await shell("curl -X POST https://api.example.com/thing -d '{}'")));
check("allow kubectl apply", !(await shell("kubectl apply -f deploy.yaml")));
check("allow terraform apply", !(await shell("terraform apply -auto-approve")));
check("block git push --force", blocked(await shell("git push --force origin feat/x")));
check("# allow-live marker no longer overrides (removed)", blocked(await shell("kubectl delete pod foo # allow-live")));
process.env.WORKFLOW_GUARD_ALLOW_LIVE = "1";
check("allow destructive with env override (user-set)", !(await shell("kubectl delete pod foo")));
delete process.env.WORKFLOW_GUARD_ALLOW_LIVE;

console.log("- Policy 4: destructive command evasions (regression) -");
check("allow rm -rf on workspace dirs", !(await shell("rm -rf node_modules")));
check("allow rm -r on workspace dirs", !(await shell("rm -r build/")));
check("block rm -rf on system paths", blocked(await shell("rm -rf /")));
check("block rm -rf on home paths", blocked(await shell("rm -rf ~")));
check("block rm -f on / path", blocked(await shell("rm -f /etc/hosts")));
check("block git clean -fdx", blocked(await shell("git clean -fdx")));
check("block git clean -f", blocked(await shell("git clean -f")));
check("block docker rm", blocked(await shell("docker rm abc123")));
check("block docker container prune", blocked(await shell("docker container prune -f")));
check("block docker system prune", blocked(await shell("docker system prune")));
check("block docker volume rm", blocked(await shell("docker volume rm data")));
check("block gh repo delete", blocked(await shell("gh repo delete owner/repo --yes")));
check("block npx prisma migrate reset", blocked(await shell("npx prisma migrate reset --force")));
check("allow rm on a single file (not recursive)", !(await shell("rm README.md")));
check("allow docker ps", !(await shell("docker ps")));
check("allow gh repo list", !(await shell("gh repo list")));
check("block script file containing destructive command (laundering guard)", blocked(await call("write", { filePath: join(root, "deploy.sh"), content: "#!/bin/sh\nkubectl delete pod foo\n" }, { sessionID: "s-active" })));
check("block apply_patch containing destructive command", blocked(await call("apply_patch", { patchText: "*** Add File: script.sh\n+kubectl delete ns foo\n" }, { sessionID: "s-active" })));
check("allow write of benign script content", !(await call("write", { filePath: join(root, "ok.sh"), content: "#!/bin/sh\necho hello\n" }, { sessionID: "s-active" })));

console.log("- Policy 2: push evasions (regression) -");
check("block push refspec HEAD:main", blocked(await shell("git push origin HEAD:main")));
check("block push delete :main", blocked(await shell("git push origin :main")));
check("block push +main (force refspec)", blocked(await shell("git push origin +main")));
check("block push local:main", blocked(await shell("git push origin feature/x:main")));
check("allow push HEAD:main-backup", !(await shell("git push origin HEAD:main-backup")));
check("git -C: push normalized then blocked", blocked(await shell("git -C /repo push origin main")));

console.log("- Policy 5: MCP mutation guard -");
check("block mcp__github__create_issue", blocked(await call("mcp__github__create_issue", {})));
check("block mcp__github__merge_pull_request", blocked(await call("mcp__github__merge_pull_request", {})));
check("allow mcp__github__list_pull_requests", !(await call("mcp__github__list_pull_requests", {})));
check("allow mcp__azure__repos_pr_list", !(await call("mcp__azure__repos_pr_list", {})));
check("allow unrelated mcp server tool", !(await call("mcp__slack__post_message", {})));
check("block mcp__azure-devops__create_work_item (dash separator)", blocked(await call("mcp__azure-devops__create_work_item", {})));
check("block mcp__gh__create_issue (gh alias)", blocked(await call("mcp__gh__create_issue", {})));
check("block azure_devops flat naming", blocked(await call("azure_devops_delete_repo", {})));

console.log("- Policy 6: settings tamper (regression: quote/glob evasion) -");
check("block opencode auth", blocked(await shell("opencode auth login")));
check("block opencode config edit", blocked(await shell(`echo '{}' > ${root}/opencode.json`)));
check("block writing ~/.config/opencode/opencode.json", blocked(await shell(`echo '{}' > /var/home/x/.config/opencode/opencode.json`)));
check("block opencode run --auto", blocked(await shell("opencode run --auto 'do stuff'")));
check("allow prose mentioning opencode (not a config verb)", !(await shell("echo 'run opencode --help for details'")));
check("allow reading opencode.json (read-only, not a tamper)", !(await shell("cat opencode.json")));
check("block quote-concatenated write to opencode.json", blocked(await shell(`echo '{}' > open''code.json`)));
check("block glob write to opencode.jso?", blocked(await shell(`echo '{}' > opencode.jso?`)));
check("block sed -i on the guard plugin itself", blocked(await shell("sed -i 's/x/y/' ~/.config/opencode/plugins/workflow-guard.ts")));
check("block rm on the TUI plugin", blocked(await shell("rm ~/.config/opencode/ui/workflow-guard-ui.tsx")));
check("allow normal command", !(await shell("ls -la && git status")));

console.log("- Policy 6: tamper via edit tools (path protection) -");
check("block edit of project opencode.json", blocked(await call("edit", { filePath: join(root, "opencode.json"), oldString: "a", newString: "b" }, { sessionID: "s-active" })));
check("block write of .opencode/project config", blocked(await call("write", { filePath: join(root, ".opencode", "opencode.json"), content: "{}" }, { sessionID: "s-active" })));
check("block write of global opencode config path", blocked(await call("write", { filePath: "/var/home/x/.config/opencode/opencode.json", content: "{}" }, { sessionID: "s-active" })));
check("block apply_patch to opencode.json", blocked(await call("apply_patch", { patchText: "*** Update File: opencode.json\n" }, { sessionID: "s-active" })));
check("allow edit of normal source file", !(await call("edit", { filePath: join(root, "src", "index.ts"), oldString: "a", newString: "b" }, { sessionID: "s-active" })));
console.log("- Policy 7: branch guard -");
// Non-git workspace (current `root` is a plain temp dir): git writes allowed.
check("non-git workspace: git commit allowed", !(await shell("git commit -m test")));
check("non-git workspace: edit allowed", !(await call("edit", { filePath: join(root, "a.ts"), content: "x" }, { sessionID: "s-active" })));
// Real git repo on main.
const repo = mkdtempSync(join(tmpdir(), "wg-repo-"));
spawnSync("git", ["init", "-b", "main"], { cwd: repo });
setWorkspaceRoot(repo); // point the guard at the repo
check("on main: edit blocked (branch reason, todos active)", ((await call("edit", { filePath: join(repo, "a.ts"), content: "x" }, { sessionID: "s-active" })) ?? "").includes("protected branch"));
check("on main: git commit blocked", blocked(await shell("git commit -m test")));
check("on main: git merge blocked", blocked(await shell("git merge feature/x")));
check("on main: git switch -c allowed (branch creation)", !(await shell("git switch -c feat/x")));
check("on main: git status allowed", !(await shell("git status")));
todo("s-main-plan");
check("on main: todowrite allowed (not an edit tool)", !(await call("todowrite", { todos: [item("plan work")] }, { sessionID: "s-main-plan" })));
spawnSync("git", ["switch", "-c", "feat/x"], { cwd: repo });
check("on feature branch: edit allowed", !(await call("edit", { filePath: join(repo, "a.ts"), content: "x" }, { sessionID: "s-active" })));
check("on feature branch: git commit allowed", !(await shell("git commit -m test")));
check("on feature branch: edit still needs active todos", blocked(await call("edit", { filePath: join(repo, "a.ts"), content: "x" }, { sessionID: "s-done" })));
rmSync(repo, { recursive: true, force: true });
setWorkspaceRoot(root);

console.log("- Policy 7: git global-flag evasions (regression) -");
const repo2 = mkdtempSync(join(tmpdir(), "wg-repo2-"));
spawnSync("git", ["init", "-b", "main"], { cwd: repo2 });
setWorkspaceRoot(root); // workspace NOT the repo - repo2 on main tested via -C
check("git -C <main-repo> commit blocked (dir-aware branch guard)", blocked(await shell(`git -C ${repo2} commit -m x`)));
check("git --git-dir=<main-repo> commit blocked", blocked(await shell(`git --git-dir=${repo2}/.git commit -m x`)));
check("allow git -C <main-repo> status (read-only)", !(await shell(`git -C ${repo2} status`)));
check("git -C <main-repo> push to main blocked (dir-aware push check)", blocked(await shell(`git -C ${repo2} push origin main`)));
const repoMain = mkdtempSync(join(tmpdir(), "wg-repo-main-"));
spawnSync("git", ["init", "-b", "main"], { cwd: repoMain });
setWorkspaceRoot(repoMain);
check("on main: git update-ref blocked", blocked(await shell("git update-ref refs/heads/main HEAD")));
check("on main: git branch -D blocked", blocked(await shell("git branch -D feature/x")));
check("on main: git filter-branch blocked", blocked(await shell("git filter-branch --env-filter 'true'")));
setWorkspaceRoot(root);
rmSync(repo2, { recursive: true, force: true });
rmSync(repoMain, { recursive: true, force: true });

console.log("- Policies 1/7/8: shell file-mutation gates (regression) -");
check("redirect > file needs active todos", blocked(await call("bash", { command: "echo x > src/a.ts" }, { sessionID: "s-empty" })));
check("redirect > file allowed with active todos", !(await call("bash", { command: "echo x > src/a.ts" }, { sessionID: "s-active" })));
check("redirect to opencode.json always blocked (tamper)", blocked(await call("bash", { command: "echo x > opencode.json" }, { sessionID: "s-active" })));
check("redirect outside workspace blocked", blocked(await call("bash", { command: "echo x > /etc/a.ts" }, { sessionID: "s-active" })));
check("redirect .. escape blocked", blocked(await call("bash", { command: "echo x > ../outside.ts" }, { sessionID: "s-active" })));
check("tee file needs todos", blocked(await call("bash", { command: "echo x | tee src/a.ts" }, { sessionID: "s-empty" })));
check("tee allowed with todos", !(await call("bash", { command: "echo x | tee src/a.ts" }, { sessionID: "s-active" })));
check("sed -i needs todos", blocked(await call("bash", { command: "sed -i 's/a/b/' src/a.ts" }, { sessionID: "s-empty" })));
check("sed -i allowed with todos", !(await call("bash", { command: "sed -i 's/a/b/' src/a.ts" }, { sessionID: "s-active" })));
check("sed -i on opencode.json blocked (tamper)", blocked(await call("bash", { command: "sed -i 's/a/b/' opencode.json" }, { sessionID: "s-active" })));
check("git apply needs todos (patch via shell)", blocked(await call("bash", { command: "git apply patch.diff" }, { sessionID: "s-empty" })));
check("git apply allowed with todos", !(await call("bash", { command: "git apply patch.diff" }, { sessionID: "s-active" })));
check("non-mutating shell unaffected (ls, cat)", !(await call("bash", { command: "ls -la && cat file" }, { sessionID: "s-empty" })));

console.log("- Policy 8: workspace boundary guard -");
check("allow edit within workspace", !(await call("edit", { filePath: join(root, "src", "index.ts"), content: "x" }, { sessionID: "s-active" })));
check("allow write relative path within workspace", !(await call("write", { filePath: "src/a.ts", content: "x" }, { sessionID: "s-active" })));
check("block edit traversing outside workspace (../)", blocked(await call("edit", { filePath: join(root, "..", "outside.ts"), content: "x" }, { sessionID: "s-active" })));
check("block write to /etc/passwd", blocked(await call("write", { filePath: "/etc/passwd", content: "x" }, { sessionID: "s-active" })));
check("allow apply_patch within workspace", !(await call("apply_patch", { patchText: "*** Update File: src/app.ts\n" }, { sessionID: "s-active" })));
check("block apply_patch escaping workspace", blocked(await call("apply_patch", { patchText: "*** Update File: ../../secret.env\n" }, { sessionID: "s-active" })));

console.log("- Compaction focus preservation & TUI toast -");
let toasts: unknown[] = [];
const toastClient = {
	session: fakeClient.session,
	tui: {
		showToast: async (req: unknown) => { toasts.push(req); },
	},
};
const pluginWithToast = await (defaultExport?.server ?? WorkflowGuard)({
	directory: root,
	client: toastClient as any,
	project: {} as any,
	worktree: root,
	experimental_workspace: {} as any,
	serverUrl: new URL("http://localhost:4096"),
	$: undefined as any,
});
// Compaction hook injects active tasks
const compactOutput: { context: string[] } = { context: [] };
const compactFn = pluginWithToast["experimental.session.compacting"];
if (typeof compactFn === "function") {
	await compactFn({ sessionID: "s-active" } as any, compactOutput as any);
}
check("compaction hook injects active tasks into output.context", compactOutput.context.length > 0 && (compactOutput.context[0]?.includes("Active Tasks") ?? false));

// Blocked tool call throws cleanly without intrusive popup toasts
toasts = [];
const beforeFn = pluginWithToast["tool.execute.before"];
if (typeof beforeFn === "function") {
	try {
		await beforeFn({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "git push origin main" } });
	} catch {}
}
check("tool block throws clean error without intrusive popup toasts", toasts.length === 0);

console.log("- Input shapes -");
check("single string command", blocked(await call("bash", "git push origin main")));
check("legacy tool name run_commands", blocked(await call("run_commands", { commands: ["git push origin main"] })));
check("plain args object command field", blocked(await call("bash", { command: "git push origin main" })));

console.log("- Plugin export shape -");
// The default export must be a V1 PluginModule record - a bare function
// default export combined with the extra named exports would make opencode
// 1.18+ treat every export as a plugin and crash the server.
check("default export is a V1 PluginModule with id + server()", (() => {
	const def: unknown = defaultExport;
	const rec = typeof def === "object" && def !== null ? (def as PluginModule) : undefined;
	return (
		typeof rec?.id === "string" &&
		rec.id.length > 0 &&
		typeof rec.server === "function"
	);
})());
const pluginFn = WorkflowGuard ?? defaultExport?.server;
const hooks = await pluginFn({
	directory: root,
	client: fakeClient as any,
	project: {} as any,
	worktree: root,
	experimental_workspace: {} as any,
	serverUrl: new URL("http://localhost:4096"),
	$: undefined as any,
});
check("plugin returns tool.execute.before hook", typeof hooks["tool.execute.before"] === "function");
// Real opencode hook contract: args arrive on the SECOND parameter.
const invoke = (tool: string, args: unknown, sessionID = "s-hook") =>
	hooks["tool.execute.before"]?.({ tool, sessionID, callID: "c" }, { args });
let threw = false;
try {
	await invoke("bash", { command: "git push origin main" });
} catch {
	threw = true;
}
check("hook throws to block disallowed call (args on 2nd param)", threw);
let noThrow = true;
try {
	await invoke("bash", { command: "ls -la" });
} catch {
	noThrow = false;
}
check("hook passes allowed call through", noThrow);
let todoThrew = false;
try {
	await invoke("write", { filePath: join(root, "a.ts"), content: "x" }, "s-empty");
} catch (e) {
	todoThrew = String(e).includes("no active todo item");
}
check("hook blocks write without todos (uses input.sessionID)", todoThrew);
let todoPass = true;
try {
	await invoke("write", { filePath: join(root, "a.ts"), content: "x" }, "s-active");
} catch {
	todoPass = false;
}
check("hook allows write with active todos", todoPass);

// No startup toast on session.created (event hook may exist for
// command.executed guard, but must not toast).
check("event hook emits no intrusive startup toast", toasts.length === 0);

// ── New: audit trail ──
console.log("- Audit trail -");
await shell("git push origin main"); // block
await shell("ls -la");                // allow
// The log file is only opened when needed; the implementation writes
// synchronously. We can't assert file existence deterministically here
// without fs access to the audit dir, but the decision writer should
// not throw, and the public wrapper should return normally.
check("audit writes do not throw", true);

// ── New: secret-content scan ──
console.log("- Secret-content scan -");
check("block write containing AWS key", blocked(await call("write", { filePath: join(root, "x.ts"), content: 'export const K = "AKIA0123ABCDEFG45678";' }, { sessionID: "s-active" })));
check("block write containing private key header", blocked(await call("write", { filePath: join(root, "x.ts"), content: "-----BEGIN RSA PRIVATE KEY-----" }, { sessionID: "s-active" })));
check("allow benign content", !(await call("write", { filePath: join(root, "x.ts"), content: "export const K = 'public';" }, { sessionID: "s-active" })));

// ── New: shell.env scrub ──
console.log("- shell.env scrub -");
const envHooks = await pluginFn({ directory: root, client: fakeClient as any, project: {} as any, worktree: root, experimental_workspace: {} as any, serverUrl: new URL("http://localhost:4096"), $: undefined as any });
const envObj: Record<string, string> = { AWS_SECRET: "x", OPENAI_API_KEY: "y", NORMAL: "keep" };
if (typeof envHooks["shell.env"] === "function") {
	await envHooks["shell.env"]({} as any, { env: envObj } as any);
}
check("sensitive keys emptied", envObj.AWS_SECRET === "" && envObj.OPENAI_API_KEY === "");
check("normal key preserved", envObj.NORMAL === "keep");

// ── New: command.executed channel ──
console.log("- command.executed guard -");
const cmdEvt = await pluginFn({ directory: root, client: fakeClient as any, project: {} as any, worktree: root, experimental_workspace: {} as any, serverUrl: new URL("http://localhost:4096"), $: undefined as any });
let blockedEvt: string | undefined;
if (typeof cmdEvt.event === "function") {
	await cmdEvt.event({ event: { type: "command.executed", properties: { command: "git push origin main", sessionID: "s-active" } } } as any);
}
check("command.executed does not throw on blocked command", true);

// TUI companion plugin registers prompt status indicator slots
let registeredSlots: Record<string, Function> = {};
let registeredOrder: number | undefined;
const fakeTuiApi = {
	theme: { current: { success: "#00ff00" } },
	slots: {
		register: ({ order, slots }: { order?: number; slots: Record<string, Function> }) => {
			registeredOrder = order;
			registeredSlots = slots;
		},
	},
};
await WorkflowGuardTui(fakeTuiApi as any, undefined, {} as any);
check("tui plugin registers with order", registeredOrder === 1);
check("tui plugin registers session_prompt_right slot", typeof registeredSlots.session_prompt_right === "function");
check("tui plugin registers home_prompt_right slot", typeof registeredSlots.home_prompt_right === "function");

// ── Adversarial tests & hardened invariants ──
console.log("- Adversarial tests & hardened invariants -");

// 1. Symlink escape via path traversal
const outsideDir = mkdtempSync(join(tmpdir(), "wg-outside-"));
const symlinkPath = join(root, "symlink_dir");
try {
	symlinkSync(outsideDir, symlinkPath);
	check(
		"symlink pointing outside workspace is blocked on edit",
		blocked(
			await call(
				"edit",
				{ filePath: join(symlinkPath, "target.txt"), content: "pwn" },
				{ sessionID: "s-active" },
			),
		),
	);
} catch (e) {
	console.log("  skip symlink test (symlink creation not supported)", e);
} finally {
	rmSync(outsideDir, { recursive: true, force: true });
}

// 2. Compound shell mutation evasion (benign first, destructive / escaping second)
check(
	"compound shell: benign first, escaping second is blocked",
	blocked(
		await call(
			"bash",
			{ command: "echo ok > src/a.ts && echo x > /etc/passwd" },
			{ sessionID: "s-active" },
		),
	),
);
check(
	"compound shell: benign first, settings tamper second is blocked",
	blocked(
		await call(
			"bash",
			{ command: "echo ok > src/a.ts && echo x > opencode.json" },
			{ sessionID: "s-active" },
		),
	),
);

// 3. Git chained command normalization
check(
	"chained git command normalization (true && git push origin main)",
	blocked(await shell("true && git push origin main")),
);

// 4. Git external repository mutation outside workspace
const externalRepo = mkdtempSync(join(tmpdir(), "wg-external-repo-"));
spawnSync("git", ["init", "-b", "feat/external"], { cwd: externalRepo });
check(
	"git -C to external repository outside workspace is blocked for writes",
	blocked(await shell(`git -C ${externalRepo} commit -m test`)),
);
rmSync(externalRepo, { recursive: true, force: true });

// 5. Verification isolation and privilege checks
const verifyDestructive = await runVerify("kubectl delete pod foo", root);
check(
	"runVerify blocks destructive live commands in verify script",
	!verifyDestructive.passed &&
		verifyDestructive.output.includes("destructive command"),
);

const verifyTamper = await runVerify("echo {} > opencode.json", root);
check(
	"runVerify blocks settings tamper in verify script",
	!verifyTamper.passed &&
		verifyTamper.output.includes("settings tamper"),
);

const verifyTimeout = await runVerify("sleep 5", root, 100);
check(
	"runVerify terminates timed-out verification commands safely",
	!verifyTimeout.passed && verifyTimeout.output.includes("timed out"),
);

const cleanEnv = getCleanEnv();
check(
	"getCleanEnv strips sensitive keys",
	cleanEnv.AWS_SECRET === undefined &&
		cleanEnv.OPENAI_API_KEY === undefined &&
		cleanEnv.GITHUB_TOKEN === undefined,
);

// 6. Verification freshness & todowrite finalization
const verifyRepo = mkdtempSync(join(tmpdir(), "wg-verify-repo-"));
writeFileSync(
	join(verifyRepo, "package.json"),
	JSON.stringify({
		scripts: {
			test: "node -e 'process.exit(0)'",
		},
	}),
);
setWorkspaceRoot(verifyRepo);
resetVerifyState();
todo("s-verify-flow", item("work item", "in_progress"));

// Edit file -> records mutation
await call(
	"edit",
	{ filePath: join(verifyRepo, "code.ts"), content: "hello" },
	{ sessionID: "s-verify-flow" },
);
check(
	"mutation timestamp recorded after edit",
	typeof getLastMutationTimestamp() === "number" && getLastMutationTimestamp() > 0,
);

// Finalize todos -> triggers runVerify on package.json test script
const finalRes = await call(
	"todowrite",
	{ todos: [item("work item", "completed")] },
	{ sessionID: "s-verify-flow" },
);
check("todowrite finalization succeeds when test passes", !blocked(finalRes));

// Now change test to fail in package.json
writeFileSync(
	join(verifyRepo, "package.json"),
	JSON.stringify({
		scripts: {
			test: "node -e 'process.exit(1)'",
		},
	}),
);
resetVerifyState();
todo("s-verify-fail", item("failing work", "in_progress"));
await call(
	"edit",
	{ filePath: join(verifyRepo, "code.ts"), content: "new change" },
	{ sessionID: "s-verify-fail" },
);
const failFinalRes = await call(
	"todowrite",
	{ todos: [item("failing work", "completed")] },
	{ sessionID: "s-verify-fail" },
);
check(
	"todowrite finalization blocked when verification script fails",
	blocked(failFinalRes),
);

rmSync(verifyRepo, { recursive: true, force: true });
setWorkspaceRoot(root);

// 7. Audit log structure
const auditFile = getAuditFilePath();
check("audit file path is valid string", typeof auditFile === "string" && auditFile.length > 0);
if (existsSync(auditFile)) {
	try {
		const lines = readFileSync(auditFile, "utf8").trim().split("\n");
		const lastLine = lines[lines.length - 1];
		if (lastLine) {
			const parsed = JSON.parse(lastLine);
			check(
				"audit log entry parses as valid JSON with ts, tool, and decision",
				Boolean(parsed.ts && parsed.tool && parsed.decision),
			);
		}
	} catch (e) {
		check("audit log entry valid JSON", false);
	}
}

// 8. Secondary Review Spoke checks
console.log("- Secondary Review Spoke & Rubric -");
const sampleDiff = "diff --git a/src/index.ts b/src/index.ts\n+export function add(a: number, b: number) { return a + b; }";
const rubric = buildReviewRubric(sampleDiff, "Add math utilities");
check("buildReviewRubric includes Test Integrity axis", rubric.includes("Test Integrity"));
check("buildReviewRubric includes Task Completeness axis", rubric.includes("Task Completeness"));
check("buildReviewRubric includes Security & Safety axis", rubric.includes("Security & Safety"));
check("buildReviewRubric includes Azure DevOps & GitHub fit", rubric.includes("Azure DevOps"));
check("buildReviewRubric embeds diff", rubric.includes("export function add"));

resetReviewState();
check("getLastReviewResult initial state is undefined", getLastReviewResult() === undefined);
recordReviewResult("reviewer-subagent", "All checks passed. Real unit tests verified.", true);
const reviewRes = getLastReviewResult();
check("recordReviewResult records passed reviewer and summary", reviewRes?.passed === true && reviewRes?.reviewer === "reviewer-subagent");

// 9. Secret-File READ Blocks (Policy 17)
console.log("- Policy 17: Secret-File READ Blocks -");
check("isSecretPath detects .env", isSecretPath(".env"));
check("isSecretPath detects .env.production", isSecretPath(".env.production"));
check("isSecretPath detects id_rsa", isSecretPath("~/.ssh/id_rsa"));
check("isSecretPath detects id_ed25519", isSecretPath("~/.ssh/id_ed25519"));
check("isSecretPath detects server.key", isSecretPath("certs/server.key"));
check("isSecretPath detects server.pem", isSecretPath("certs/server.pem"));
check("isSecretPath detects kubeconfig", isSecretPath("~/.kube/config"));
check("isSecretPath detects credentials.json", isSecretPath("config/credentials.json"));
check("isSecretPath detects service-account.json", isSecretPath("service-account.json"));
check("isSecretPath permits .env.example (safe fixture)", !isSecretPath(".env.example"));
check("isSecretPath permits .env.template (safe fixture)", !isSecretPath(".env.template"));
check("isSecretPath permits .env.sample", !isSecretPath(".env.sample"));

check("read tool blocks .env", blocked(await call("read", { filePath: join(root, ".env") })));
check("read tool blocks id_rsa", blocked(await call("read", { filePath: join(root, "id_rsa") })));
check("read tool blocks credentials.json", blocked(await call("read", { filePath: join(root, "credentials.json") })));
check("read tool allows .env.example", !(await call("read", { filePath: join(root, ".env.example") })));

check("shell cat .env is blocked", blocked(await shell("cat .env")));
check("shell cat .env.local is blocked", blocked(await shell("cat .env.local")));
check("shell less id_rsa is blocked", blocked(await shell("less ~/.ssh/id_rsa")));
check("shell grep in credentials.json is blocked", blocked(await shell("grep -i password credentials.json")));
check("shell cat .env.example is allowed", !(await shell("cat .env.example")));

// 10. Interpreter Inline Evasion Scanner (Policy 18)
console.log("- Policy 18: Interpreter Inline Evasion Scanner -");
check("extractInterpreterPayload extracts python -c", extractInterpreterPayload('python3 -c "import os; os.system(\'ls\')"' ).length > 0);
check("extractInterpreterPayload extracts node -e", extractInterpreterPayload('node -e "console.log(1)"').length > 0);

check("python -c destructive command is blocked", blocked(await shell('python3 -c "import os; os.system(\'kubectl delete pod foo\')"' )));
check("python -c rm -rf / is blocked", blocked(await shell('python -c "import os; os.system(\'rm -rf /\')"' )));
check("node -e destructive command is blocked", blocked(await shell('node -e "require(\'child_process\').execSync(\'terraform destroy\')"' )));
check("python -c benign script is allowed", !(await shell('python3 -c "print(\'hello world\')"' )));

const b64Destructive = Buffer.from("kubectl delete pod foo").toString("base64");
check("base64 pipe destructive command is blocked", blocked(await shell(`echo "${b64Destructive}" | base64 -d | sh`)));
check("powershell -enc destructive command is blocked", blocked(await shell(`powershell -enc ${b64Destructive}`)));

// 11. Worktree & Project Config (.opencode/workflow-guard.json)
console.log("- Project Configuration & Custom Rules -");
const projectConfigDir = mkdtempSync(join(tmpdir(), "wg-cfg-repo-"));
mkdirSync(join(projectConfigDir, ".opencode"), { recursive: true });
writeFileSync(
	join(projectConfigDir, ".opencode", "workflow-guard.json"),
	JSON.stringify({
		protectedBranches: ["release/prod", "staging"],
		verifyCommand: "node -e 'process.exit(0)'",
		requireReview: true,
	}),
);
setWorkspaceRoot(projectConfigDir);
reloadProjectConfig(projectConfigDir);

const loadedCfg = loadProjectConfig(projectConfigDir);
check("project config loads protectedBranches", loadedCfg.protectedBranches?.includes("release/prod") ?? false);
check("project config loads verifyCommand", loadedCfg.verifyCommand === "node -e 'process.exit(0)'");
check("project config loads requireReview", loadedCfg.requireReview === true);

// Branch guard honors custom protected branches from config
spawnSync("git", ["init", "-b", "release/prod"], { cwd: projectConfigDir });
check(
	"custom protected branch release/prod blocks direct edits",
	blocked(await call("edit", { filePath: join(projectConfigDir, "a.ts"), content: "x" }, { sessionID: "s-active" })),
);

// Review Requirement gating on PR creation
resetReviewState();
check(
	"PR creation blocked when requireReview is true and no review recorded",
	blocked(await shell("gh pr create --title t --body 'Changelog: update'")),
);
recordReviewResult("reviewer-agent", "LGTM - 5 axes verified", true);
check(
	"PR creation allowed once approved review is recorded",
	!(await shell("gh pr create --title t --body 'Changelog: update'")),
);

rmSync(projectConfigDir, { recursive: true, force: true });
setWorkspaceRoot(root);
reloadProjectConfig(root);
resetReviewState();

// 12. Custom Plugin Tools & Event Auditing
console.log("- Custom Tools & Event Auditing -");
const customPlugin = await (defaultExport?.server ?? WorkflowGuard)({
	directory: root,
	worktree: root,
	client: fakeClient as any,
	project: {} as any,
	experimental_workspace: {} as any,
	serverUrl: new URL("http://localhost:4096"),
	$: undefined as any,
});

check("plugin registers guard_status tool", typeof customPlugin.tool?.guard_status?.execute === "function");
check("plugin registers guard_audit tool", typeof customPlugin.tool?.guard_audit?.execute === "function");
check("plugin registers guard_why tool", typeof customPlugin.tool?.guard_why?.execute === "function");
check("plugin registers record_review tool", typeof customPlugin.tool?.record_review?.execute === "function");

const statusResult = await customPlugin.tool?.guard_status?.execute({}, {} as any);
check("guard_status executes and returns JSON string", typeof statusResult === "string" && statusResult.includes("workspaceRoot"));

const whyResultBlocked = await customPlugin.tool?.guard_why?.execute({ tool: "bash", input: { command: "git push origin main" } }, {} as any);
check("guard_why explains blocked command", typeof whyResultBlocked === "string" && whyResultBlocked.startsWith("BLOCKED:"));

const whyResultAllowed = await customPlugin.tool?.guard_why?.execute({ tool: "bash", input: { command: "ls -la" } }, {} as any);
check("guard_why confirms allowed command", typeof whyResultAllowed === "string" && whyResultAllowed.startsWith("ALLOWED:"));

const reviewToolResult = await customPlugin.tool?.record_review?.execute(
	{ reviewer: "subagent-1", summary: "Real tests pass, zero stubs.", passed: true },
	{} as any,
);
check("record_review tool execution succeeds", typeof reviewToolResult === "string" && reviewToolResult.includes("APPROVED"));

// Event hook handles permission events
if (typeof customPlugin.event === "function") {
	await customPlugin.event({
		event: {
			type: "permission.asked",
			properties: { sessionID: "s-active", permission: "bash", pattern: "npm test" },
		},
	});
	await customPlugin.event({
		event: {
			type: "permission.replied",
			properties: { sessionID: "s-active", permission: "bash", decision: "allow" },
		},
	});
}
const recentAudits = getRecentAuditEntries(5);
check("getRecentAuditEntries returns array with permission events", Array.isArray(recentAudits) && recentAudits.some((e) => e.tool === "permission.asked"));

// 13. Merged Branch & Conflict Pre-Flight Guards (Policies 19 & 20)
console.log("- Policies 19 & 20: Merged Branch & Conflict Pre-Flight Guards -");
const conflictRepo = mkdtempSync(join(tmpdir(), "wg-conflict-repo-"));
spawnSync("git", ["init", "-b", "main"], { cwd: conflictRepo });
spawnSync("git", ["config", "user.email", "test@test.local"], { cwd: conflictRepo });
spawnSync("git", ["config", "user.name", "Test Runner"], { cwd: conflictRepo });
writeFileSync(join(conflictRepo, "file.txt"), "base content\n");
spawnSync("git", ["add", "file.txt"], { cwd: conflictRepo });
spawnSync("git", ["commit", "-m", "initial commit"], { cwd: conflictRepo });

// Create a branch already merged into main
spawnSync("git", ["switch", "-c", "feat/already-merged"], { cwd: conflictRepo });
setWorkspaceRoot(conflictRepo);

const mergedCheck = isBranchAlreadyMergedOrClosed(conflictRepo, "feat/already-merged");
check("isBranchAlreadyMergedOrClosed identifies branch with 0 diff from main", mergedCheck.merged);
check("git push on already merged branch is blocked", blocked(await shell("git push origin feat/already-merged")));

// Create a branch with a genuine merge conflict against main
spawnSync("git", ["switch", "main"], { cwd: conflictRepo });
spawnSync("git", ["switch", "-c", "feat/conflict-branch"], { cwd: conflictRepo });
writeFileSync(join(conflictRepo, "file.txt"), "conflict branch content\n");
spawnSync("git", ["commit", "-am", "branch edit"], { cwd: conflictRepo });

spawnSync("git", ["switch", "main"], { cwd: conflictRepo });
writeFileSync(join(conflictRepo, "file.txt"), "main different content\n");
spawnSync("git", ["commit", "-am", "main edit"], { cwd: conflictRepo });

spawnSync("git", ["switch", "feat/conflict-branch"], { cwd: conflictRepo });
const conflictResult = checkMergeConflicts(conflictRepo);
check("checkMergeConflicts detects merge conflict with main", conflictResult.hasConflicts);

// PR creation is blocked when merge conflict exists
check(
	"gh pr create blocked when branch has merge conflicts with base",
	blocked(await shell("gh pr create --title t --body 'Changelog: fix'")),
);
check(
	"az repos pr create blocked when branch has merge conflicts with base",
	blocked(await shell("az repos pr create --title t --description 'Changelog: fix'")),
);

// Base freshness pre-flight check (when local base is behind remote)
// Simulate remote origin/main ahead of local HEAD
spawnSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: conflictRepo });
const baseUpToDateCheck = checkBranchBaseIsUpToDate(conflictRepo);
check("checkBranchBaseIsUpToDate passes when equal to remote", !baseUpToDateCheck.isBehind);

// 14. Documentation Review & Synchronization Guard (Policy 21)
console.log("- Policy 21: Documentation Review & Synchronization Guard -");
const docRepo = mkdtempSync(join(tmpdir(), "wg-doc-repo-"));
spawnSync("git", ["init", "-b", "main"], { cwd: docRepo });
spawnSync("git", ["config", "user.email", "test@test.local"], { cwd: docRepo });
spawnSync("git", ["config", "user.name", "Test Runner"], { cwd: docRepo });
writeFileSync(join(docRepo, "README.md"), "# Initial Docs\n");
writeFileSync(join(docRepo, "code.ts"), "export const a = 1;\n");
spawnSync("git", ["add", "-A"], { cwd: docRepo });
spawnSync("git", ["commit", "-m", "init"], { cwd: docRepo });

spawnSync("git", ["switch", "-c", "feat/undocumented"], { cwd: docRepo });
writeFileSync(join(docRepo, "code.ts"), "export const a = 2;\n");
spawnSync("git", ["commit", "-am", "update code without docs"], { cwd: docRepo });
setWorkspaceRoot(docRepo);

check("branchHasDocumentationChange returns false when only code was modified", !branchHasDocumentationChange(docRepo));

// Enable requireDocumentation in env
process.env.WORKFLOW_GUARD_REQUIRE_DOCS = "1";
check(
	"gh pr create is blocked when documentation update is required and missing",
	blocked(await shell("gh pr create --title t --body 'Changelog: added feature'")),
);

// Now update README.md or docs
writeFileSync(join(docRepo, "README.md"), "# Updated Docs\n");
spawnSync("git", ["commit", "-am", "docs: update README"], { cwd: docRepo });
check("branchHasDocumentationChange returns true once docs are modified", branchHasDocumentationChange(docRepo));
check(
	"gh pr create passes once documentation update is present",
	!(await shell("gh pr create --title t --body 'Changelog: added feature'")),
);
delete process.env.WORKFLOW_GUARD_REQUIRE_DOCS;

rmSync(docRepo, { recursive: true, force: true });
setWorkspaceRoot(root);

rmSync(conflictRepo, { recursive: true, force: true });
setWorkspaceRoot(root);
rmSync(root, { recursive: true, force: true });
if (prevLive !== undefined) process.env.WORKFLOW_GUARD_ALLOW_LIVE = prevLive;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
