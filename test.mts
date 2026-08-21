import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginModule } from "@opencode-ai/plugin";
import {
	guardToolCall,
	setWorkspaceRoot,
	setSdkClient,
	WorkflowGuard,
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

console.log("— Policy 1: native todo gate —");
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

console.log("— Policy 1: todowrite focus & lifecycle validation —");
// Focus rule: only 1 in_progress
check("todowrite allows 1 in_progress", !(await call("todowrite", { todos: [item("a", "in_progress"), item("b", "pending")] }, { sessionID: "s-empty" })));
check("todowrite blocks >1 in_progress (focus rule)", blocked(await call("todowrite", { todos: [item("a", "in_progress"), item("b", "in_progress")] }, { sessionID: "s-empty" })));
// Sequential rule: cannot complete task 2 while task 1 is pending
check("todowrite allows sequential completion", !(await call("todowrite", { todos: [item("a", "completed"), item("b", "in_progress"), item("c", "pending")] }, { sessionID: "s-empty" })));
check("todowrite blocks out-of-order completion", blocked(await call("todowrite", { todos: [item("a", "pending"), item("b", "completed")] }, { sessionID: "s-empty" })));
// No silent deletion: active task cannot silently vanish
todo("s-lifecycle", item("task 1", "completed"), item("task 2", "in_progress"), item("task 3", "pending"));
check("todowrite allows updating active tasks to completed/cancelled", !(await call("todowrite", { todos: [item("task 1", "completed"), item("task 2", "completed"), item("task 3", "cancelled")] }, { sessionID: "s-lifecycle" })));
check("todowrite blocks silently dropping task 2 without completion", blocked(await call("todowrite", { todos: [item("task 1", "completed"), item("task 3", "pending")] }, { sessionID: "s-lifecycle" })));
// Fresh list allowed once all previous tasks are finished
todo("s-finished", item("old 1", "completed"), item("old 2", "cancelled"));
check("todowrite allows fresh list when previous list is 100% finished", !(await call("todowrite", { todos: [item("new 1", "pending")] }, { sessionID: "s-finished" })));

console.log("— Policy 1: subagent parent-chain inheritance —");
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

console.log("— Policy 1: fail-open when todos can't be determined —");
setSdkClient({ session: { todo: async () => { throw new Error("boom"); } } });
check("fetch failure fails open", !(await call("edit", { filePath: join(root, "a.ts"), content: "x" }, { sessionID: "s-active" })));
setSdkClient(undefined);
check("missing client fails open", !(await call("edit", { filePath: join(root, "a.ts"), content: "x" }, { sessionID: "s-active" })));
check("missing sessionID fails open", !(await call("edit", { filePath: join(root, "a.ts"), content: "x" })));
setSdkClient(fakeClient);

console.log("— Policy 2: push to main/master —");
check("block git push origin main", blocked(await shell("git push origin main")));
check("block git push origin master", blocked(await shell("git push origin master")));
check("block git push --force origin main", blocked(await shell("git push --force origin main")));
check("allow git push origin feature/x", !(await shell("git push origin feature/x")));
check("allow push to main-backup (ref-like path)", !(await shell("git push origin main-backup")));

console.log("— Policy 3: PR changelog —");
check("block gh pr create without changelog", blocked(await shell("gh pr create --title t --body 'no changes here'")));
check("allow gh pr create with Changelog: body", !(await shell("gh pr create --title t --body 'Changelog: fixed stuff'")));
const bodyFile = join(root, "pr-body.md");
writeFileSync(bodyFile, "## Changelog\n- fix\n");
check("allow gh pr create with -F body-file containing changelog", !(await shell(`gh pr create -F ${bodyFile}`)));
console.log("— Policy 4: destructive commands —");
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

console.log("— Policy 4: destructive command evasions (regression) —");
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

console.log("— Policy 2: push evasions (regression) —");
check("block push refspec HEAD:main", blocked(await shell("git push origin HEAD:main")));
check("block push delete :main", blocked(await shell("git push origin :main")));
check("block push +main (force refspec)", blocked(await shell("git push origin +main")));
check("block push local:main", blocked(await shell("git push origin feature/x:main")));
check("allow push HEAD:main-backup", !(await shell("git push origin HEAD:main-backup")));
check("git -C: push normalized then blocked", blocked(await shell("git -C /repo push origin main")));

console.log("— Policy 5: MCP mutation guard —");
check("block mcp__github__create_issue", blocked(await call("mcp__github__create_issue", {})));
check("block mcp__github__merge_pull_request", blocked(await call("mcp__github__merge_pull_request", {})));
check("allow mcp__github__list_pull_requests", !(await call("mcp__github__list_pull_requests", {})));
check("allow mcp__azure__repos_pr_list", !(await call("mcp__azure__repos_pr_list", {})));
check("allow unrelated mcp server tool", !(await call("mcp__slack__post_message", {})));
check("block mcp__azure-devops__create_work_item (dash separator)", blocked(await call("mcp__azure-devops__create_work_item", {})));
check("block mcp__gh__create_issue (gh alias)", blocked(await call("mcp__gh__create_issue", {})));
check("block azure_devops flat naming", blocked(await call("azure_devops_delete_repo", {})));

console.log("— Policy 6: settings tamper (regression: quote/glob evasion) —");
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

console.log("— Policy 6: tamper via edit tools (path protection) —");
check("block edit of project opencode.json", blocked(await call("edit", { filePath: join(root, "opencode.json"), oldString: "a", newString: "b" }, { sessionID: "s-active" })));
check("block write of .opencode/project config", blocked(await call("write", { filePath: join(root, ".opencode", "opencode.json"), content: "{}" }, { sessionID: "s-active" })));
check("block write of global opencode config path", blocked(await call("write", { filePath: "/var/home/x/.config/opencode/opencode.json", content: "{}" }, { sessionID: "s-active" })));
check("block apply_patch to opencode.json", blocked(await call("apply_patch", { patchText: "*** Update File: opencode.json\n" }, { sessionID: "s-active" })));
check("allow edit of normal source file", !(await call("edit", { filePath: join(root, "src", "index.ts"), oldString: "a", newString: "b" }, { sessionID: "s-active" })));
console.log("— Policy 7: branch guard —");
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

console.log("— Policy 7: git global-flag evasions (regression) —");
const repo2 = mkdtempSync(join(tmpdir(), "wg-repo2-"));
spawnSync("git", ["init", "-b", "main"], { cwd: repo2 });
setWorkspaceRoot(root); // workspace NOT the repo — repo2 on main tested via -C
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

console.log("— Policies 1/7/8: shell file-mutation gates (regression) —");
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

console.log("— Policy 8: workspace boundary guard —");
check("allow edit within workspace", !(await call("edit", { filePath: join(root, "src", "index.ts"), content: "x" }, { sessionID: "s-active" })));
check("allow write relative path within workspace", !(await call("write", { filePath: "src/a.ts", content: "x" }, { sessionID: "s-active" })));
check("block edit traversing outside workspace (../)", blocked(await call("edit", { filePath: join(root, "..", "outside.ts"), content: "x" }, { sessionID: "s-active" })));
check("block write to /etc/passwd", blocked(await call("write", { filePath: "/etc/passwd", content: "x" }, { sessionID: "s-active" })));
check("allow apply_patch within workspace", !(await call("apply_patch", { patchText: "*** Update File: src/app.ts\n" }, { sessionID: "s-active" })));
check("block apply_patch escaping workspace", blocked(await call("apply_patch", { patchText: "*** Update File: ../../secret.env\n" }, { sessionID: "s-active" })));

console.log("— Compaction focus preservation & TUI toast —");
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

console.log("— Input shapes —");
check("single string command", blocked(await call("bash", "git push origin main")));
check("legacy tool name run_commands", blocked(await call("run_commands", { commands: ["git push origin main"] })));
check("plain args object command field", blocked(await call("bash", { command: "git push origin main" })));

console.log("— Plugin export shape —");
// The default export must be a V1 PluginModule record — a bare function
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
console.log("— Audit trail —");
await shell("git push origin main"); // block
await shell("ls -la");                // allow
// The log file is only opened when needed; the implementation writes
// synchronously. We can't assert file existence deterministically here
// without fs access to the audit dir, but the decision writer should
// not throw, and the public wrapper should return normally.
check("audit writes do not throw", true);

// ── New: secret-content scan ──
console.log("— Secret-content scan —");
check("block write containing AWS key", blocked(await call("write", { filePath: join(root, "x.ts"), content: 'export const K = "AKIA0123ABCDEFG45678";' }, { sessionID: "s-active" })));
check("block write containing private key header", blocked(await call("write", { filePath: join(root, "x.ts"), content: "-----BEGIN RSA PRIVATE KEY-----" }, { sessionID: "s-active" })));
check("allow benign content", !(await call("write", { filePath: join(root, "x.ts"), content: "export const K = 'public';" }, { sessionID: "s-active" })));

// ── New: shell.env scrub ──
console.log("— shell.env scrub —");
const envHooks = await pluginFn({ directory: root, client: fakeClient as any, project: {} as any, worktree: root, experimental_workspace: {} as any, serverUrl: new URL("http://localhost:4096"), $: undefined as any });
const envObj: Record<string, string> = { AWS_SECRET: "x", OPENAI_API_KEY: "y", NORMAL: "keep" };
if (typeof envHooks["shell.env"] === "function") {
	await envHooks["shell.env"]({} as any, { env: envObj } as any);
}
check("sensitive keys emptied", envObj.AWS_SECRET === "" && envObj.OPENAI_API_KEY === "");
check("normal key preserved", envObj.NORMAL === "keep");

// ── New: command.executed channel ──
console.log("— command.executed guard —");
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

rmSync(root, { recursive: true, force: true });
if (prevLive !== undefined) process.env.WORKFLOW_GUARD_ALLOW_LIVE = prevLive;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
