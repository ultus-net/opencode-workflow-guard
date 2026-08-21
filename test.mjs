import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const mod = await import(pathToFileURL(join(import.meta.dirname, "workflow-guard.ts")).href);
const guard = mod.guardToolCall;
const setWorkspaceRoot = mod.setWorkspaceRoot;

let pass = 0, fail = 0;
const check = (name, cond) => { cond ? (pass++, console.log("  ok  " + name)) : (fail++, console.log("FAIL  " + name)); };

const root = mkdtempSync(join(tmpdir(), "wg-test-"));
const prevLive = process.env.WORKFLOW_GUARD_ALLOW_LIVE;
delete process.env.WORKFLOW_GUARD_ALLOW_LIVE;
setWorkspaceRoot(root);

const call = async (toolName, input) => guard(toolName, input);
const shell = (cmd) => call("bash", { command: cmd });
const blocked = (r) => typeof r === "string";

console.log("— Policy 1: task-list gate —");
writeFileSync(join(root, "TASKS.md"), "# Tasks\n- [ ] do thing\n- [x] done\n");
check("edit allowed with unchecked task", !(await call("edit", { filePath: join(root, "a.ts"), content: "x" })));
check("write allowed with unchecked task", !(await call("write", { filePath: join(root, "a.ts"), content: "x" })));
check("patch allowed with unchecked task", !(await call("patch", { content: "*** x" })));
writeFileSync(join(root, "TASKS.md"), "# Tasks\n- [x] all done\n");
check("edit blocked when all tasks checked", blocked(await call("edit", { filePath: join(root, "a.ts"), content: "x" })));
rmSync(join(root, "TASKS.md"));
check("edit blocked with no task list", blocked(await call("edit", { filePath: join(root, "a.ts"), content: "x" })));
writeFileSync(join(root, "TASKS.md"), "# Tasks\n- [ ] do thing\n");
check("task-list file itself exempt", !(await call("edit", { filePath: join(root, "TASKS.md"), content: "x" })));

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
check("allow destructive with # allow-live", !(await shell("kubectl delete pod foo # allow-live")));
process.env.WORKFLOW_GUARD_ALLOW_LIVE = "1";
check("allow destructive with env override", !(await shell("kubectl delete pod foo")));
delete process.env.WORKFLOW_GUARD_ALLOW_LIVE;

console.log("— Policy 5: MCP mutation guard —");
check("block mcp__github__create_issue", blocked(await call("mcp__github__create_issue", {})));
check("block mcp__github__merge_pull_request", blocked(await call("mcp__github__merge_pull_request", {})));
check("allow mcp__github__list_pull_requests", !(await call("mcp__github__list_pull_requests", {})));
check("allow mcp__azure__repos_pr_list", !(await call("mcp__azure__repos_pr_list", {})));
check("allow unrelated mcp server tool", !(await call("mcp__slack__post_message", {})));

console.log("— Policy 6: settings tamper —");
check("block opencode auth", blocked(await shell("opencode auth login")));
check("block opencode config edit", blocked(await shell(`echo '{}' > ${root}/opencode.json`)));
check("block writing ~/.config/opencode/opencode.json", blocked(await shell(`echo '{}' > /var/home/x/.config/opencode/opencode.json`)));
check("block opencode run --auto", blocked(await shell("opencode run --auto 'do stuff'")));
check("FIXED: prose mentioning opencode not a tamper", !(await shell("echo 'run opencode --help for details'")));
check("allow normal command", !(await shell("ls -la && git status")));
console.log("— Policy 7: branch guard —");
// Non-git workspace (current `root` is a plain temp dir): git writes allowed.
check("non-git workspace: git commit allowed", !(await shell("git commit -m test")));
check("non-git workspace: edit allowed", !(await call("edit", { filePath: join(root, "a.ts"), content: "x" })));
// Real git repo on main.
const repo = mkdtempSync(join(tmpdir(), "wg-repo-"));
spawnSync("git", ["init", "-b", "main"], { cwd: repo });
setWorkspaceRoot(repo); // point the guard at the repo
writeFileSync(join(repo, "TASKS.md"), "# Tasks\n- [ ] do thing\n");
check("on main: edit blocked", blocked(await call("edit", { filePath: join(repo, "a.ts"), content: "x" })));
check("on main: git commit blocked", blocked(await shell("git commit -m test")));
check("on main: git merge blocked", blocked(await shell("git merge feature/x")));
check("on main: git switch -c allowed (branch creation)", !(await shell("git switch -c feat/x")));
check("on main: git status allowed", !(await shell("git status")));
check("on main: task-list file edit still exempt", !(await call("edit", { filePath: join(repo, "TASKS.md"), content: "x" })));
spawnSync("git", ["switch", "-c", "feat/x"], { cwd: repo });
check("on feature branch: edit allowed", !(await call("edit", { filePath: join(repo, "a.ts"), content: "x" })));
check("on feature branch: git commit allowed", !(await shell("git commit -m test")));
rmSync(repo, { recursive: true, force: true });
setWorkspaceRoot(root); // restore

console.log("— Input shapes —");
check("single string command", blocked(await call("bash", "git push origin main")));
check("legacy tool name run_commands", blocked(await call("run_commands", { commands: ["git push origin main"] })));
check("plain args object command field", blocked(await call("bash", { command: "git push origin main" })));

console.log("— Plugin export shape —");
const pluginFn = mod.default ?? mod.WorkflowGuard;
const hooks = await pluginFn({ directory: root });
check("plugin returns tool.execute.before hook", typeof hooks["tool.execute.before"] === "function");
let threw = false;
try {
	await hooks["tool.execute.before"]({ tool: "bash", args: { command: "git push origin main" } });
} catch {
	threw = true;
}
check("hook throws to block disallowed call", threw);
let noThrow = true;
try {
	await hooks["tool.execute.before"]({ tool: "bash", args: { command: "ls -la" } });
} catch {
	noThrow = false;
}
check("hook passes allowed call through", noThrow);

rmSync(root, { recursive: true, force: true });
if (prevLive !== undefined) process.env.WORKFLOW_GUARD_ALLOW_LIVE = prevLive;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);


