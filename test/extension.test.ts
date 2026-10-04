import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import test from "node:test";

// This gate deliberately loads the ACTUAL workspace.ts. There is no skip or
// provider stub: run only after the two component patches are integrated.
// PI_HOST_ROOT supports a globally installed Pi without relying on CommonJS
// resolution for Pi's import-only package export.
const hostSpecifier = process.env.PI_HOST_ROOT
	? pathToFileURL(resolve(process.env.PI_HOST_ROOT, "dist/index.js")).href
	: "@earendil-works/pi-coding-agent";
const host = await import(hostSpecifier);
const git = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
const packageRoot = resolve(".");
const source = resolve("src/extension.ts");
const theme = { fg: (_color: string, text: string) => text };
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function until(check: () => boolean | Promise<boolean>) {
	for (let n = 0; n < 200; n++) { if (await check()) return; await sleep(20); }
	throw new Error("Timed out waiting for integrated extension");
}

async function fixtures(t: any) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-footer-integration-")));
	const bin = join(root, "bin"), launch = join(root, "launch"), plain = join(root, "plain ü"), repo = join(root, "repo"), second = join(root, "other repo");
	await Promise.all([bin, launch, plain, repo, second].map((path) => mkdir(path)));
	const saved = { ...process.env };
	Object.assign(process.env, { PATH: bin, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" });
	const gitLog = join(root, "git.log"), ghLog = join(root, "gh.log");
	const gitScript = `#!${process.execPath}\nconst fs=require('node:fs'); const cp=require('node:child_process'); fs.appendFileSync(${JSON.stringify(gitLog)}, process.cwd()+' '+JSON.stringify(process.argv.slice(2))+'\\n'); const run=()=>{ const r=cp.spawnSync(${JSON.stringify(git)},process.argv.slice(2),{env:process.env}); if(r.stdout)process.stdout.write(r.stdout); if(r.stderr)process.stderr.write(r.stderr); process.exit(r.status??1); }; if(process.argv[2]==='symbolic-ref' && fs.existsSync(require('node:path').join(process.cwd(),'.broken-head'))) { process.stderr.write('branch failure'); process.exit(128); } if(fs.existsSync(require('node:path').join(process.cwd(),'.slow-git'))) setTimeout(run,150); else run();\n`;
	await writeFile(join(bin, "git"), gitScript); await chmod(join(bin, "git"), 0o755);
	// Deterministic gh boundary, never a live account or network. [] either means
	// no PR or a truthful unavailable result if the domain rejects that protocol.
	await writeFile(join(bin, "gh"), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(ghLog)},JSON.stringify(process.argv.slice(2))+'\\n');setTimeout(()=>process.stdout.write('[]'),100);\n`);
	await chmod(join(bin, "gh"), 0o755);
	const runGit = (cwd: string, args: string[]) => execFileSync(git, ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd, env: process.env, encoding: "utf8" });
	for (const cwd of [repo, second]) {
		runGit(cwd, ["init", "-b", "release"]);
		runGit(cwd, ["commit", "--allow-empty", "-m", "fixture"]);
	}
	t.after(async () => {
		// Preserve Node's native environment object so os.homedir sees later HOME changes.
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
		await rm(root, { recursive: true, force: true });
	});
	const count = async (path: string) => { try { return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).length; } catch { return 0; } };
	return { root, launch, plain, repo, second, runGit, gitLog, ghLog, count };
}

async function harness(f: any, manager: any, mode = "tui") {
	const loader = new host.DefaultResourceLoader({ cwd: f.launch, agentDir: join(f.root, "agent"), settingsManager: host.SettingsManager.inMemory(), additionalExtensionPaths: [packageRoot], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
	await loader.reload();
	const loaded = loader.getExtensions();
	assert.deepEqual(loaded.errors, [], "real Pi loader must resolve the package entry and integrated workspace import");
	assert.deepEqual(loaded.warnings, [], "package manifest must use host peers without loader warnings");
	assert.equal(loaded.extensions.length, 1);
	assert.equal(loaded.extensions[0].path, source);
	const runner = new host.ExtensionRunner(loaded.extensions, loaded.runtime, f.launch, manager, undefined);
	const tool = runner.getToolDefinition("set_active_project"); assert.ok(tool);
	let component: any;
	let model = { id: "first-model", provider: "fixture", contextWindow: 128_000 };
	let thinking = "high";
	let usage: any = { tokens: 1000, contextWindow: 128_000, percent: 0.8 };
	const statuses = new Map([["ponytail", "\x1b[32mPonytail ready\x1b[0m"]]);
	let renders = 0;
	const errors: any[] = []; runner.onError((error: any) => errors.push(error));
	runner.bindCore({
		sendMessage() {}, sendUserMessage() {}, appendEntry: (type: string, data: any) => manager.appendCustomEntry(type, data), setSessionName() {}, getSessionName: () => undefined, setLabel() {},
		getActiveTools: () => [tool.name], getAllTools: () => [tool], getSettings: () => ({}), setActiveTools() {}, refreshTools() {}, getCommands: () => [], setModel: async () => true,
		getThinkingLevel: () => thinking, setThinkingLevel: (value: string) => { thinking = value; },
	}, { getModel: () => model, getScopedModels: () => [], isIdle: () => true, isProjectTrusted: () => false, getSignal: () => undefined, abort() {}, hasPendingMessages: () => false, shutdown() {}, getContextUsage: () => usage, compact() {}, getSystemPrompt: () => "" });
	runner.setUIContext({ setFooter(factory: any) {
		component?.dispose(); component = undefined;
		if (factory) component = factory({ requestRender: () => { renders++; } }, theme, { getExtensionStatuses: () => statuses });
	} }, mode);
	const emitStart = async (reason = "startup") => runner.emit({ type: "session_start", reason });
	const stop = async (reason = "quit") => runner.emit({ type: "session_shutdown", reason });
	const text = () => component?.render(300).join("\n") ?? "";
	const select = async (path: string, signal?: AbortSignal, persist = true) => {
		const id = `selection-${manager.getEntries().length}`;
		const result = await tool.execute(id, { path }, signal, undefined, runner.createToolContext(id, signal));
		if (persist) manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: tool.name, content: result.content, details: result.details, isError: false, timestamp: Date.now() });
		return result;
	};
	return { runner, tool, emitStart, stop, text, select, statuses, errors, get component() { return component; }, get renders() { return renders; }, changeModel() { model = { ...model, id: "second-model" }; thinking = "off"; usage = { tokens: null, percent: null, contextWindow: 128_000 }; } };
}

test("real loader registration; display-only signal, invalid paths, aborted calls and non-TUI", async (t) => {
	const f = await fixtures(t), cwd = process.cwd();
	const manager = host.SessionManager.inMemory(f.launch);
	const h = await harness(f, manager, "print"); t.after(() => h.stop());
	await h.emitStart();
	assert.equal(h.component, undefined);
	assert.equal(h.tool.executionMode, "sequential");
	assert.match(h.tool.promptGuidelines.join(" "), /Before deliberately starting work/);
	assert.match(h.tool.promptGuidelines.join(" "), /incidental reads/);
	const result = await h.select("../plain ü");
	assert.equal(result.details.path, f.plain);
	assert.equal(process.cwd(), cwd); assert.equal(manager.getCwd(), f.launch);
	const before = manager.getEntries().length;
	await assert.rejects(h.select(join(f.root, "missing")));
	const abort = new AbortController(); abort.abort();
	await assert.rejects(h.select(f.repo, abort.signal), /cancelled|session changed/);
	assert.equal(manager.getEntries().length, before);
	assert.deepEqual(h.errors, []);
});

test("real host supplies home for display without changing absolute selection details", async (t) => {
	const f = await fixtures(t);
	process.env.HOME = f.root;
	const manager = host.SessionManager.inMemory(f.launch);
	const h = await harness(f, manager); t.after(() => h.stop()); await h.emitStart();
	assert.match(h.text(), /Launch: ~\/launch/);
	const result = await h.select(f.plain);
	assert.match(h.text(), /Active: ~\/plain ü/);
	assert.equal(result.details.path, f.plain);
	assert.equal(manager.getCwd(), f.launch);
});

test("tree restoration follows branch; reload/resume and fork restore; new session resets", async (t) => {
	const f = await fixtures(t);
	const manager = host.SessionManager.create(f.launch, join(f.root, "sessions"));
	const rootId = manager.appendMessage({ role: "assistant", content: [], api: "openai-completions", provider: "fixture", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
	const h = await harness(f, manager); t.after(() => h.stop()); await h.emitStart();
	await h.select(f.repo); const repoId = manager.getLeafId();
	await h.select(f.plain); assert.ok(h.text().includes(`Active: ${f.plain}`));
	manager.branch(repoId);
	await h.runner.emit({ type: "session_tree", newLeafId: repoId, oldLeafId: null });
	assert.ok(h.text().includes(`Active: ${f.repo}`));
	assert.ok(h.text().includes(`Launch: ${f.launch}`));
	// Persist an entry on the selected branch: a leaf pointer alone is not a
	// durable session-file change when later reopened by SessionManager.open.
	manager.appendCustomEntry("fixture-selected-branch", {});
	await h.stop("reload"); h.runner.invalidate();
	const restored = await harness(f, manager); t.after(() => restored.stop()); await restored.emitStart("reload");
	assert.ok(restored.text().includes(`Active: ${f.repo}`));
	const resumed = await harness(f, host.SessionManager.open(manager.getSessionFile())); t.after(() => resumed.stop()); await resumed.emitStart("resume");
	assert.ok(resumed.text().includes(`Active: ${f.repo}`));
	const forkManager = host.SessionManager.forkFrom(manager.getSessionFile(), f.launch, join(f.root, "forks"));
	const forked = await harness(f, forkManager); t.after(() => forked.stop()); await forked.emitStart("fork");
	assert.ok(forked.text().includes(`Active: ${f.repo}`));
	manager.branch(rootId); await restored.runner.emit({ type: "session_tree", newLeafId: rootId, oldLeafId: repoId });
	assert.ok(restored.text().includes(`Active: ${f.launch}`));
	const fresh = await harness(f, host.SessionManager.inMemory(f.launch)); t.after(() => fresh.stop()); await fresh.emitStart("new");
	assert.ok(fresh.text().includes(`Active: ${f.launch}`));
});

test("live context/model/statuses; local tool refresh, stale completions and owner disposal", async (t) => {
	const f = await fixtures(t), manager = host.SessionManager.inMemory(f.launch);
	const h = await harness(f, manager); t.after(() => h.stop()); await h.emitStart();
	await h.select(f.repo); await until(() => /release · clean/.test(h.text()));
	await writeFile(join(f.repo, "untracked"), "changed");
	await h.runner.emit({ type: "tool_execution_end", toolCallId: "external-write", toolName: "write", result: { content: [], details: undefined }, isError: false });
	await until(() => /release · modified/.test(h.text()));
	h.statuses.set("second", "Second extension status"); h.changeModel();
	assert.match(h.text(), /Ponytail ready/); assert.match(h.text(), /Second extension status/);
	assert.match(h.text(), /second-model · thinking off/); assert.match(h.text(), /Context: \?\/128k/);
	await writeFile(join(f.second, ".slow-git"), "delay");
	await h.select(f.second); await sleep(30); await h.select(f.plain);
	await until(() => h.text().split("\n").includes(`Active: ${f.plain}`)); await sleep(700);
	assert.ok(h.text().includes(`Active: ${f.plain}`)); assert.doesNotMatch(h.text(), /Main:|release|Not a Git repository|No GitHub remote/);
	await h.select(f.second); await sleep(30); const priorRenders = h.renders;
	await h.stop(); h.runner.invalidate(); await sleep(700);
	assert.equal(h.renders, priorRenders); assert.equal(h.component, undefined); assert.deepEqual(h.errors, []);
});

test("failed branch discovery displays Git and PR unavailable, then recovers", async (t) => {
	const f = await fixtures(t);
	f.runGit(f.repo, ["remote", "add", "origin", "https://github.com/fixture/status-bar.git"]);
	await writeFile(join(f.repo, ".broken-head"), "fail branch inspection");
	const h = await harness(f, host.SessionManager.inMemory(f.launch)); t.after(() => h.stop()); await h.emitStart();
	await h.select(f.repo); await until(() => /Git unavailable/.test(h.text()));
	assert.match(h.text(), /PR unavailable/);
	assert.doesNotMatch(h.text(), /detached|No open PR|PR not applicable/);
	assert.equal(await f.count(f.ghLog), 0, "unknown branch must not start a PR lookup");
	await rm(join(f.repo, ".broken-head"));
	await h.runner.emit({ type: "tool_execution_end", toolCallId: "recovered", toolName: "bash", result: { content: [], details: undefined }, isError: false });
	await until(() => /release · clean/.test(h.text()) && /^GitHub: fixture\/status-bar$/m.test(h.text()));
	assert.equal(await f.count(f.ghLog), 1);
	assert.deepEqual(h.errors, []);
});

test("session-scoped 15s refresh and repo/branch PR TTL; tree keeps cache, switches invalidate", async (t) => {
	const f = await fixtures(t);
	f.runGit(f.repo, ["remote", "add", "origin", "https://github.com/fixture/status-bar.git"]);
	f.runGit(f.second, ["remote", "add", "origin", "https://github.com/fixture/second.git"]);
	t.mock.timers.enable({ apis: ["setInterval", "Date"] });
	const manager = host.SessionManager.inMemory(f.launch), h = await harness(f, manager); t.after(() => h.stop()); await h.emitStart();
	await h.select(f.repo); const selected = manager.getLeafId();
	await until(async () => await f.count(f.ghLog) >= 1); await sleep(300);
	const initial = await f.count(f.ghLog);
	for (let n = 0; n < 3; n++) {
		await h.runner.emit({ type: "tool_execution_end", toolCallId: `tool-${n}`, toolName: "read", result: { content: [], details: undefined }, isError: false }); await sleep(250);
	}
	assert.equal(await f.count(f.ghLog), initial, "tools must not hit network per refresh");
	await h.runner.emit({ type: "session_tree", newLeafId: selected, oldLeafId: selected }); await sleep(300);
	assert.equal(await f.count(f.ghLog), initial, "tree navigation retains the same-session PR TTL");
	await writeFile(join(f.repo, "external"), "external change");
	t.mock.timers.tick(15_000); await until(() => /modified/.test(h.text()));
	assert.equal(await f.count(f.ghLog), initial);
	t.mock.timers.tick(60_000); await until(async () => await f.count(f.ghLog) > initial); await sleep(300);
	let count = await f.count(f.ghLog);
	f.runGit(f.repo, ["checkout", "-b", "feature"]);
	t.mock.timers.tick(15_000); await until(async () => await f.count(f.ghLog) > count); await sleep(300);
	count = await f.count(f.ghLog); await h.select(f.second);
	await until(async () => await f.count(f.ghLog) > count); await sleep(300);
	await h.stop(); await sleep(300);
	const gitCount = await f.count(f.gitLog); t.mock.timers.tick(120_000); await sleep(300);
	assert.equal(await f.count(f.gitLog), gitCount, "shutdown clears polling and pending work");
	assert.deepEqual(h.errors, []);
});
