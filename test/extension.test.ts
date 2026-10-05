import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
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
const hostRequire = createRequire(process.env.PI_HOST_ROOT ? resolve(process.env.PI_HOST_ROOT, "package.json") : import.meta.url);
const { stripTerminalSequences } = await import(pathToFileURL(hostRequire.resolve("@earendil-works/pi-tui")).href);
const git = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
const packageRoot = resolve(".");
const source = resolve("src/extension.ts");
// Footer colors are fixed concrete values; the host theme only converts them.
const theme = { style: (text: string) => text, getColorMode: () => "truecolor" };
// Display shows the immediate parent/current directory; stored paths stay absolute.
const shown = (path: string) => `${basename(dirname(path))}/${basename(path)}`;
const row = (text: string, label: string) => text.split("\n").find((line) => line.includes(label)) ?? "";
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
	const notices: [string, string][] = [];
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
	}, notify(message: string, level: string) { notices.push([level, message]); } }, mode);
	const emitStart = async (reason = "startup") => runner.emit({ type: "session_start", reason });
	const stop = async (reason = "quit") => runner.emit({ type: "session_shutdown", reason });
	const text = () => component?.render(300).map((line: string) => stripTerminalSequences(line)).join("\n") ?? "";
	const motion = async (args: string) => runner.getCommand("footer-motion").handler(args, runner.createCommandContext());
	const select = async (path: string, signal?: AbortSignal, persist = true) => {
		const id = `selection-${manager.getEntries().length}`;
		const result = await tool.execute(id, { path }, signal, undefined, runner.createToolContext(id, signal));
		if (persist) manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: tool.name, content: result.content, details: result.details, isError: false, timestamp: Date.now() });
		return result;
	};
	return { runner, tool, emitStart, stop, text, select, statuses, errors, motion, notices, get component() { return component; }, get renders() { return renders; }, setUsage(value: any) { usage = value; }, changeModel() { model = { ...model, id: "second-model" }; thinking = "off"; usage = { tokens: null, percent: null, contextWindow: 128_000 }; } };
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
	await h.motion("off"); await h.motion("");
	assert.equal(h.component, undefined, "non-TUI motion control installs no footer or timer");
	assert.deepEqual(h.errors, []);
});

test("real host supplies home for display without changing absolute selection details", async (t) => {
	const f = await fixtures(t);
	process.env.HOME = f.root;
	const manager = host.SessionManager.inMemory(f.launch);
	const h = await harness(f, manager); t.after(() => h.stop()); await h.emitStart();
	assert.match(h.text(), /01 LAUNCH +~\/launch /);
	const result = await h.select(f.plain);
	assert.match(h.text(), /02 ACTIVE +~\/plain ü /);
	assert.equal(result.details.path, f.plain);
	assert.equal(manager.getCwd(), f.launch);
});

test("tree restoration follows branch; reload/resume and fork restore; new session resets", async (t) => {
	const f = await fixtures(t);
	const manager = host.SessionManager.create(f.launch, join(f.root, "sessions"));
	const rootId = manager.appendMessage({ role: "assistant", content: [], api: "openai-completions", provider: "fixture", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
	const h = await harness(f, manager); t.after(() => h.stop()); await h.emitStart();
	await h.select(f.repo); const repoId = manager.getLeafId();
	await h.select(f.plain); assert.ok(row(h.text(), "ACTIVE").includes(shown(f.plain)));
	manager.branch(repoId);
	await h.runner.emit({ type: "session_tree", newLeafId: repoId, oldLeafId: null });
	assert.ok(row(h.text(), "ACTIVE").includes(shown(f.repo)));
	assert.ok(row(h.text(), "LAUNCH").includes(shown(f.launch)));
	// Persist an entry on the selected branch: a leaf pointer alone is not a
	// durable session-file change when later reopened by SessionManager.open.
	manager.appendCustomEntry("fixture-selected-branch", {});
	await h.stop("reload"); h.runner.invalidate();
	const restored = await harness(f, manager); t.after(() => restored.stop()); await restored.emitStart("reload");
	assert.ok(row(restored.text(), "ACTIVE").includes(shown(f.repo)));
	const resumed = await harness(f, host.SessionManager.open(manager.getSessionFile())); t.after(() => resumed.stop()); await resumed.emitStart("resume");
	assert.ok(row(resumed.text(), "ACTIVE").includes(shown(f.repo)));
	const forkManager = host.SessionManager.forkFrom(manager.getSessionFile(), f.launch, join(f.root, "forks"));
	const forked = await harness(f, forkManager); t.after(() => forked.stop()); await forked.emitStart("fork");
	assert.ok(row(forked.text(), "ACTIVE").includes(shown(f.repo)));
	manager.branch(rootId); await restored.runner.emit({ type: "session_tree", newLeafId: rootId, oldLeafId: repoId });
	assert.ok(row(restored.text(), "ACTIVE").includes(shown(f.launch)));
	const fresh = await harness(f, host.SessionManager.inMemory(f.launch)); t.after(() => fresh.stop()); await fresh.emitStart("new");
	assert.ok(row(fresh.text(), "ACTIVE").includes(shown(f.launch)));
});

test("live context/model/statuses; local tool refresh, stale completions and owner disposal", async (t) => {
	const f = await fixtures(t), manager = host.SessionManager.inMemory(f.launch);
	const h = await harness(f, manager); t.after(() => h.stop()); await h.emitStart();
	await h.select(f.repo); await until(() => /release {3}clean/.test(h.text()));
	await writeFile(join(f.repo, "untracked"), "changed");
	await h.runner.emit({ type: "tool_execution_end", toolCallId: "external-write", toolName: "write", result: { content: [], details: undefined }, isError: false });
	await until(() => /release {3}modified/.test(h.text()));
	h.statuses.set("second", "Second extension status"); h.changeModel();
	assert.match(h.text(), /Ponytail ready/); assert.match(h.text(), /Second extension status/);
	assert.match(h.text(), /second-model · thinking off/); assert.match(h.text(), / \?\/128k {3}\? UNKNOWN/);
	await writeFile(join(f.second, ".slow-git"), "delay");
	await h.select(f.second); await sleep(30); await h.select(f.plain);
	const plainOnly = new RegExp(`02 ACTIVE +${shown(f.plain).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} +▐`);
	await until(() => plainOnly.test(h.text())); await sleep(700);
	assert.match(h.text(), plainOnly); assert.doesNotMatch(h.text(), /MAIN|release|GITHUB|Not a Git repository|No GitHub remote/);
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
	await until(() => /release {3}clean/.test(h.text()) && /^┏━ GITHUB fixture\/status-bar ─/m.test(h.text()));
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

test("decorative motion: footer-owned unref'd timer, session /footer-motion, live values and disposal without extra I/O", async (t) => {
	const f = await fixtures(t), manager = host.SessionManager.inMemory(f.launch);
	const refTimers = () => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
	const h = await harness(f, manager); t.after(() => h.stop());
	const baseline = refTimers();
	await h.emitStart(); await until(() => /02 ACTIVE +\S+\/launch +▐/.test(h.text())); await sleep(200);
	const local = await f.count(f.gitLog), remote = await f.count(f.ghLog);
	let renders = h.renders; await sleep(600);
	assert.ok(h.renders > renders, "decoration repaints itself while motion is on");
	assert.equal(refTimers(), baseline, "animation and refresh timers are unref'd");
	assert.equal(await f.count(f.gitLog), local, "animation never inspects Git");
	assert.equal(await f.count(f.ghLog), remote, "animation never queries GitHub");
	h.setUsage({ tokens: 120_000, contextWindow: 128_000, percent: 93.75 });
	assert.match(h.text(), / 93\.8%\/128k {3}▲ HIGH/, "a tone change shows the current value immediately, mid-wipe");

	const cleared = t.mock.method(globalThis, "clearTimeout");
	await h.motion("off");
	assert.ok(cleared.mock.callCount() >= 1, "pausing clears the pending animation timeout"); cleared.mock.restore();
	assert.deepEqual(h.notices.at(-1), ["info", "Footer motion off for this session"]);
	const settled = h.text(); renders = h.renders;
	assert.match(settled.split("\n")[0], /━┓$/, "settled frame is fully drawn");
	await sleep(600);
	assert.equal(h.renders, renders, "motion off leaves no repaint timer"); assert.equal(h.text(), settled);
	h.setUsage({ tokens: null, contextWindow: 128_000, percent: null });
	assert.match(h.text(), / \?\/128k {3}\? UNKNOWN/, "live values still update with motion off");
	await h.motion("sideways");
	assert.deepEqual(h.notices.at(-1), ["warning", "Usage: /footer-motion [on|off]"]);
	await sleep(300); assert.equal(h.renders, renders, "invalid arguments leave motion unchanged");
	await h.runner.emit({ type: "session_tree", newLeafId: null, oldLeafId: null });
	await sleep(300); renders = h.renders; // the restore's own local refresh may repaint once
	await sleep(600); assert.equal(h.renders, renders, "same-session tree restore keeps the motion choice");

	await h.motion(""); renders = h.renders; await sleep(600);
	assert.ok(h.renders > renders, "empty argument toggles motion back on");
	assert.equal(h.runner.getCommand("footer-motion").getArgumentCompletions("o").map((item: any) => item.value).join(), "on,off");
	await h.stop(); h.runner.invalidate(); renders = h.renders; await sleep(600);
	assert.equal(h.renders, renders, "shutdown disposes the animation timer");
	const fresh = await harness(f, host.SessionManager.inMemory(f.launch)); t.after(() => fresh.stop());
	await fresh.emitStart(); renders = fresh.renders; await sleep(600);
	assert.ok(fresh.renders > renders, "a new session starts with motion on");
	assert.deepEqual([...h.errors, ...fresh.errors], []);
});
