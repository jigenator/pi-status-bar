import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
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
const { stripTerminalSequences, styleText } = await import(pathToFileURL(hostRequire.resolve("@earendil-works/pi-tui")).href);
const git = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
const packageRoot = resolve(".");
const source = resolve("src/extension.ts");
// Footer colors are fixed concrete values; the host theme only converts them.
const theme = { style: (text: string, options: object) => styleText(text, options, "truecolor"), getColorMode: () => "truecolor" };
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

async function harness(f: any, manager: any, mode = "tui", extra: { before?: string[]; after?: string[]; emptyStatuses?: boolean } = {}) {
	// Real public bus, with transparent subscription accounting for disposal assertions.
	const nativeBus = host.createEventBus(), subscriptions = new Map<string, number>();
	const events = { emit: nativeBus.emit, on(channel: string, handler: (data: any) => void) {
		subscriptions.set(channel, (subscriptions.get(channel) ?? 0) + 1);
		const off = nativeBus.on(channel, handler); let live = true;
		return () => { if (live) { live = false; subscriptions.set(channel, subscriptions.get(channel)! - 1); off(); } };
	} };
	const requests: any[] = [];
	let rpc: ((request: any) => void | Promise<void>) | undefined;
	events.on("subagents:rpc:v1:request", (request) => { requests.push(request); return rpc?.(request); });
	const loader = new host.DefaultResourceLoader({ eventBus: events, cwd: f.launch, agentDir: join(f.root, "agent"), settingsManager: host.SettingsManager.inMemory(), additionalExtensionPaths: [...(extra.before ?? []), packageRoot, ...(extra.after ?? [])], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
	await loader.reload();
	const loaded = loader.getExtensions();
	assert.deepEqual(loaded.errors, [], "real Pi loader must resolve the package entry and integrated workspace import");
	assert.deepEqual(loaded.warnings, [], "package manifest must use host peers without loader warnings");
	assert.equal(loaded.extensions.length, 1 + (extra.before?.length ?? 0) + (extra.after?.length ?? 0));
	assert.equal(loaded.extensions[extra.before?.length ?? 0].path, source);
	const runner = new host.ExtensionRunner(loaded.extensions, loaded.runtime, f.launch, manager, undefined);
	const tool = runner.getToolDefinition("set_active_project"); assert.ok(tool);
	let component: any, footerFactory: any;
	let idle = true;
	let model = { id: "first-model", provider: "fixture", contextWindow: 128_000 };
	let thinking = "high";
	let usage: any = { tokens: 1000, contextWindow: 128_000, percent: 0.8 };
	const notices: [string, string][] = [];
	const statuses = new Map(extra.emptyStatuses ? [] : [["ponytail", "\x1b[32mPonytail ready\x1b[0m"]]);
	const statusCalls: any[] = [];
	let renders = 0;
	const errors: any[] = []; runner.onError((error: any) => errors.push(error));
	runner.bindCore({
		sendMessage() {}, sendUserMessage() {}, appendEntry: (type: string, data: any) => manager.appendCustomEntry(type, data), setSessionName() {}, getSessionName: () => undefined, setLabel() {},
		getActiveTools: () => [tool.name], getAllTools: () => [tool], getSettings: () => ({}), setActiveTools() {}, refreshTools() {}, getCommands: () => [], setModel: async () => true,
		getThinkingLevel: () => thinking, setThinkingLevel: (value: string) => { thinking = value; },
	}, { getModel: () => model, getScopedModels: () => [], isIdle: () => idle, isProjectTrusted: () => false, getSignal: () => undefined, abort() {}, hasPendingMessages: () => false, shutdown() {}, getContextUsage: () => usage, compact() {}, getSystemPrompt: () => "" });
	const makeUI = () => ({ theme: { ...theme, fg: (_color: string, text: string) => text },
		setStatus(key: string, text: string | undefined) {
			statusCalls.push({ key, text, receiver: this });
			if (key === "throw-fixture") throw new Error("status failure");
			if (text === undefined) statuses.delete(key); else statuses.set(key, text);
			return "forwarded";
		}, setFooter(factory: any) {
		component?.dispose(); component = undefined; footerFactory = factory;
		if (factory) component = factory({ requestRender: () => { renders++; } }, theme, { getExtensionStatuses: () => statuses });
	}, notify(message: string, level: string) { notices.push([level, message]); } });
	runner.setUIContext(makeUI(), mode);
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
	return { events, requests, subscriptions, statusCalls,
		get ui() { return runner.createContext().ui; },
		setStatus(key: string, text?: string) { return runner.createContext().ui.setStatus(key, text); },
		replaceUI() { runner.setUIContext(makeUI(), mode); },
		setRpc(handler?: (request: any) => void | Promise<void>) { rpc = handler; },
		setIdle(value: boolean) { idle = value; },
		reply(request: any, data: any, envelope = {}) { events.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, method: request.method, success: true, data, ...envelope }); },
		replaceFooter() { const previous = component; previous?.dispose(); component = footerFactory({ requestRender: () => { renders++; } }, theme, { getExtensionStatuses: () => statuses }); return previous; },
		runner, tool, emitStart, stop, text, select, statuses, errors, motion, notices, get component() { return component; }, get renders() { return renders; }, setUsage(value: any) { usage = value; }, changeModel() { model = { ...model, id: "second-model" }; thinking = "off"; usage = { tokens: null, percent: null, contextWindow: 128_000 }; } };
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
	assert.equal(h.requests.length, 0, "non-TUI modes do not collect display-only fleet data");
	assert.equal(h.subscriptions.get("subagents:rpc:v1:ready") ?? 0, 0);
	assert.deepEqual(h.errors, []);
});

test("real host supplies home for display without changing absolute selection details", async (t) => {
	const f = await fixtures(t);
	process.env.HOME = f.root;
	const manager = host.SessionManager.inMemory(f.launch);
	const h = await harness(f, manager); t.after(() => h.stop()); await h.emitStart();
	// Active starts at Launch, so Launch defers to the ACT path until a deliberate move.
	assert.match(h.text(), /01 LDR += ACT /); assert.match(h.text(), /02 ACT +~\/launch /);
	const result = await h.select(f.plain);
	assert.match(h.text(), /01 LDR +~\/launch /); assert.match(h.text(), /02 ACT +~\/plain ü /);
	assert.equal(result.details.path, f.plain);
	assert.equal(manager.getCwd(), f.launch);
});

test("tree restoration follows branch; reload/resume and fork restore; new session resets", async (t) => {
	const f = await fixtures(t);
	const manager = host.SessionManager.create(f.launch, join(f.root, "sessions"));
	const rootId = manager.appendMessage({ role: "assistant", content: [], api: "openai-completions", provider: "fixture", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
	const h = await harness(f, manager); t.after(() => h.stop()); await h.emitStart();
	await h.select(f.repo); const repoId = manager.getLeafId();
	await h.select(f.plain); assert.ok(row(h.text(), "02 ACT").includes(shown(f.plain)));
	manager.branch(repoId);
	await h.runner.emit({ type: "session_tree", newLeafId: repoId, oldLeafId: null });
	assert.ok(row(h.text(), "02 ACT").includes(shown(f.repo)));
	assert.ok(row(h.text(), "01 LDR").includes(shown(f.launch)));
	// Persist an entry on the selected branch: a leaf pointer alone is not a
	// durable session-file change when later reopened by SessionManager.open.
	manager.appendCustomEntry("fixture-selected-branch", {});
	await h.stop("reload"); h.runner.invalidate();
	const restored = await harness(f, manager); t.after(() => restored.stop()); await restored.emitStart("reload");
	assert.ok(row(restored.text(), "02 ACT").includes(shown(f.repo)));
	const resumed = await harness(f, host.SessionManager.open(manager.getSessionFile())); t.after(() => resumed.stop()); await resumed.emitStart("resume");
	assert.ok(row(resumed.text(), "02 ACT").includes(shown(f.repo)));
	const forkManager = host.SessionManager.forkFrom(manager.getSessionFile(), f.launch, join(f.root, "forks"));
	const forked = await harness(f, forkManager); t.after(() => forked.stop()); await forked.emitStart("fork");
	assert.ok(row(forked.text(), "02 ACT").includes(shown(f.repo)));
	manager.branch(rootId); await restored.runner.emit({ type: "session_tree", newLeafId: rootId, oldLeafId: repoId });
	assert.ok(row(restored.text(), "02 ACT").includes(shown(f.launch)));
	const fresh = await harness(f, host.SessionManager.inMemory(f.launch)); t.after(() => fresh.stop()); await fresh.emitStart("new");
	assert.ok(row(fresh.text(), "02 ACT").includes(shown(f.launch)));
});

// Event fixtures follow the installed host's order (agent-session.js): appendCompaction,
// then session_compact; failures append nothing; boundary drafts commit with no
// session_compact before turn_start/agent_end/agent_settled. They do not run the pipeline.
test("CMP counts persisted active-branch compactions; restores and recounts without per-render walks", async (t) => {
	const f = await fixtures(t);
	const manager = host.SessionManager.create(f.launch, join(f.root, "sessions"));
	manager.appendMessage({ role: "assistant", content: [], api: "openai-completions", provider: "fixture", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
	const compact = () => manager.getEntry(manager.appendCompaction("summary", manager.getLeafId(), 1000));
	const cmp = (h: any) => /CMP×(\S+)/.exec(h.text())?.[1];
	compact(); const base = manager.getLeafId(); // inherited by both branches below
	const h = await harness(f, manager); t.after(() => h.stop()); await h.emitStart();
	await until(() => !/Git pending/.test(h.text())); await sleep(300); await h.motion("off");
	assert.equal(cmp(h), "01", "startup restores from the branch");
	const entry = compact(); let renders = h.renders;
	const done = { type: "session_compact", compactionEntry: entry, fromExtension: false, reason: "manual", willRetry: false };
	await h.runner.emit(done);
	assert.equal(cmp(h), "02"); assert.ok(h.renders > renders, "motion off still repaints current data");
	renders = h.renders; await h.runner.emit(done); await h.runner.emit({ ...done, reason: "threshold" });
	assert.equal(cmp(h), "02", "duplicate events recount, never increment"); assert.equal(h.renders, renders);
	for (const aborted of [false, true]) await h.runner.emit({ type: "session_compact_failed", reason: "overflow", errorMessage: aborted ? undefined : "failed", aborted, willRetry: false, fromExtension: false });
	assert.equal(cmp(h), "02", "failed/cancelled attempts persist nothing");
	manager.branchWithSummary(base, "abandoned branch summary");
	await h.runner.emit({ type: "session_tree", newLeafId: manager.getLeafId(), oldLeafId: entry.id });
	assert.equal(cmp(h), "01", "abandoned sibling and branch_summary are excluded");
	compact(); await h.runner.emit({ type: "turn_start", turnIndex: 1, timestamp: Date.now() });
	assert.equal(cmp(h), "02", "turn_end draft is shown on the continuing turn");
	compact(); await h.runner.emit({ type: "agent_settled" });
	assert.equal(cmp(h), "03", "agent_before_settle draft is shown at settlement");
	const walks = t.mock.method(manager, "getBranch");
	for (let n = 0; n < 30; n++) h.text();
	assert.equal(walks.mock.callCount(), 0, "render reads the cached count"); walks.mock.restore();
	await h.stop("reload"); renders = h.renders;
	const late = compact(); await h.runner.emit({ ...done, compactionEntry: late }); await h.runner.emit({ type: "agent_settled" });
	assert.equal(h.renders, renders, "events after shutdown cannot update a disposed footer");
	h.runner.invalidate();
	const restored = await harness(f, manager); t.after(() => restored.stop()); await restored.emitStart("reload");
	assert.equal(cmp(restored), "04");
	const resumed = await harness(f, host.SessionManager.open(manager.getSessionFile())); t.after(() => resumed.stop()); await resumed.emitStart("resume");
	assert.equal(cmp(resumed), "04");
	const forked = await harness(f, host.SessionManager.forkFrom(manager.getSessionFile(), f.launch, join(f.root, "forks"))); t.after(() => forked.stop()); await forked.emitStart("fork");
	assert.equal(cmp(forked), "04");
	const fresh = await harness(f, host.SessionManager.inMemory(f.launch)); t.after(() => fresh.stop()); await fresh.emitStart("new");
	assert.equal(cmp(fresh), "00", "a new session starts at a known zero");
	assert.deepEqual([...h.errors, ...restored.errors, ...resumed.errors, ...forked.errors, ...fresh.errors], []);
});

test("live context/model/statuses; local tool refresh, stale completions and owner disposal", async (t) => {
	const f = await fixtures(t), manager = host.SessionManager.inMemory(f.launch);
	const h = await harness(f, manager); t.after(() => h.stop()); await h.emitStart();
	await h.select(f.repo); await until(() => /release {2}clean/.test(h.text()));
	await writeFile(join(f.repo, "untracked"), "changed");
	await h.runner.emit({ type: "tool_execution_end", toolCallId: "external-write", toolName: "write", result: { content: [], details: undefined }, isError: false });
	await until(() => /release {2}modified/.test(h.text()));
	h.statuses.set("second", "Second extension status"); h.changeModel();
	assert.match(h.text(), /Ponytail ready/); assert.match(h.text(), /Second extension status/);
	assert.match(h.text(), /second-model · thinking off/); assert.match(h.text(), /\?\/128k[^\n]*\? UNKNOWN/);
	await writeFile(join(f.second, ".slow-git"), "delay");
	await h.select(f.second); await sleep(30); await h.select(f.plain);
	const plainOnly = new RegExp(`02 ACT +${shown(f.plain).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} +▐`);
	await until(() => plainOnly.test(h.text())); await sleep(700);
	assert.match(h.text(), plainOnly); assert.doesNotMatch(h.text(), /2\.1 MN|release|GitHub|Not a Git repository|No GitHub remote/);
	assert.match(h.text(), / CMP×00 /, "CMP stays visible without repository data");
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
	await until(() => /release {2}clean/.test(h.text()) && /CMP×00  fixture /.test(h.text()) && !/PR unavailable/.test(h.text()));
	assert.doesNotMatch(h.text(), /fixture\/status-bar/, "header shows the owner, not the repository");
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
	await h.emitStart(); await until(() => /02 ACT +\S+\/launch +▐/.test(h.text())); await sleep(200);
	const local = await f.count(f.gitLog), remote = await f.count(f.ghLog);
	let renders = h.renders; await sleep(600);
	assert.ok(h.renders > renders, "decoration repaints itself while motion is on");
	assert.equal(refTimers(), baseline, "animation and refresh timers are unref'd");
	assert.equal(await f.count(f.gitLog), local, "animation never inspects Git");
	assert.equal(await f.count(f.ghLog), remote, "animation never queries GitHub");
	h.setUsage({ tokens: 120_000, contextWindow: 128_000, percent: 93.75 });
	assert.match(h.text(), /120k\/128k[^\n]*▲ HIGH/, "a tone change shows the current value immediately, mid-wipe");

	const cleared = t.mock.method(globalThis, "clearTimeout");
	await h.motion("off");
	assert.ok(cleared.mock.callCount() >= 1, "pausing clears the pending animation timeout"); cleared.mock.restore();
	assert.deepEqual(h.notices.at(-1), ["info", "Footer motion off for this session"]);
	const settled = h.text(); renders = h.renders;
	assert.match(settled.split("\n")[0], /┓$/, "settled frame is fully drawn");
	await sleep(600);
	assert.equal(h.renders, renders, "motion off leaves no repaint timer"); assert.equal(h.text(), settled);
	h.setUsage({ tokens: null, contextWindow: 128_000, percent: null });
	assert.match(h.text(), /\?\/128k[^\n]*\? UNKNOWN/, "live values still update with motion off");
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

const pingData = (manager: any) => ({ version: 1, session: { sessionId: manager.getSessionId() }, capabilities: { fleetStatus: { version: 1 } } });
const fleetData = (units: number) => ({ fleet: { version: 1, entries: [], totalActive: units, omitted: units } });
const replyListeners = (h: any) => [...h.subscriptions].filter(([name]: [string, number]) => name.startsWith("subagents:rpc:v1:reply:")).reduce((sum: number, [, n]: [string, number]) => sum + n, 0);
// Keep real subprocess fixtures outside the mock-clock phase. Only this adapter's
// activity/decoration timers are accelerated; the bus itself remains Pi's bus.
async function activityClock(t: any, h: any) {
	await until(() => !/Git pending/.test(h.text()));
	await sleep(300);
	await h.motion("off");
	let now = Math.ceil(performance.now());
	t.mock.method(performance, "now", () => now);
	t.mock.timers.enable({ apis: ["setTimeout"] });
	return async (ms: number) => { now += ms; t.mock.timers.tick(ms); for (let n = 0; n < 16; n++) await Promise.resolve(); };
}

test("public fleet RPC: async bus delivery, exact AU overflow, independent ROOT settlement, live motion-off and bounded coalescing", async (t) => {
	const f = await fixtures(t), manager = host.SessionManager.inMemory(f.launch), h = await harness(f, manager);
	t.after(() => h.stop());
	let units = 103;
	h.setRpc(async (request) => {
		await Promise.resolve(); // emit() must not be mistaken for an awaited reply
		h.reply(request, request.method === "ping" ? pingData(manager) : fleetData(units));
	});
	// Owner ready before footer session_start is permitted; initial ping must find it.
	h.events.emit("subagents:rpc:v1:ready", pingData(manager));
	await h.emitStart();
	const advance = await activityClock(t, h);
	assert.match(h.text(), /103 AU/);
	assert.equal(replyListeners(h), 0);
	assert.deepEqual(h.requests.map((r: any) => r.method), ["ping", "status"]);
	assert.ok(h.requests.every((r: any) => r.params === undefined), "only untargeted status; no executor-rich request");
	h.statuses.set("subagents", "native status preserved");
	const idle = h.component.render(300).join("\n");
	h.setIdle(false); let repaints = h.renders;
	await h.runner.emit({ type: "agent_start" });
	assert.ok(h.renders > repaints);
	const working = h.component.render(300).join("\n");
	assert.notEqual(working, idle, "ROOT lamp uses current isIdle even when decoration is off");
	await h.runner.emit({ type: "agent_end", messages: [] });
	assert.equal(h.component.render(300).join("\n"), working, "agent_end is not settlement: root can still retry/continue");
	h.setIdle(true); await h.runner.emit({ type: "agent_settled" });
	assert.equal(h.component.render(300).join("\n"), idle, "settlement repaints the idle root with the same 103 AU");
	assert.match(h.text(), /native status preserved/);
	units = 0;
	for (let n = 0; n < 30; n++) await h.runner.emit({ type: "agent_settled" });
	const before = h.requests.length;
	for (let n = 0; n < 30; n++) h.text();
	assert.equal(h.requests.length, before, "renders never query the bus");
	await advance(1_000);
	assert.equal(h.requests.length, before + 2, "burst coalesces to one ping/status cycle");
	assert.match(h.text(), / 00 AU /, "confirmed zero is not Unknown");
	units = Number.MAX_SAFE_INTEGER;
	await advance(5_000);
	assert.match(h.text(), /9007199254740991 AU/, "never use bounded entries.length or cap the exact total");
	const known = h.text();
	h.events.emit("subagents:rpc:v1:ready", { ...pingData(manager), session: { sessionId: "other" } });
	assert.equal(h.text(), known, "another session's ready event cannot invalidate this owner");
	await h.motion("on");
	const rpcCount = h.requests.length, renderCount = h.renders;
	for (let n = 0; n < 20; n++) { await advance(50); h.text(); }
	assert.ok(h.renders > renderCount && h.renders <= renderCount + 21, "one bounded decoration wake per 50ms quantum");
	assert.equal(h.requests.length, rpcCount, "animation frames do not perform activity collection");
	await h.motion("off");
	assert.equal(replyListeners(h), 0);
	assert.deepEqual(h.errors, []);
});

test("public fleet RPC rejects unsupported, malformed, wrong-session and error replies; timeout/no owner stays Unknown and recovers", async (t) => {
	const f = await fixtures(t), manager = host.SessionManager.inMemory(f.launch), h = await harness(f, manager);
	t.after(() => h.stop());
	h.setRpc((request) => h.reply(request, request.method === "ping" ? pingData(manager) : fleetData(3)));
	await h.emitStart(); const advance = await activityClock(t, h);
	assert.match(h.text(), / 03 AU /);
	const cases = [
		{ method: "ping", data: { ...pingData(manager), version: 2 } },
		{ method: "ping", data: { ...pingData(manager), capabilities: {} } },
		{ method: "ping", data: { ...pingData(manager), capabilities: { fleetStatus: { version: 2 } } } },
		{ method: "ping", data: { ...pingData(manager), session: {} } },
		{ method: "ping", data: { ...pingData(manager), session: { sessionId: "other" } } },
		{ method: "status", data: null },
		{ method: "status", data: { fleet: { ...fleetData(0).fleet, version: 2 } } },
		{ method: "status", data: { fleet: { ...fleetData(0).fleet, entries: "bad" } } },
		{ method: "status", data: { fleet: { ...fleetData(3).fleet, omitted: 0 } } },
		...[-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "3", null].map((value) => ({ method: "status", data: { fleet: { ...fleetData(0).fleet, totalActive: value } } })),
		{ method: "status", data: fleetData(0), envelope: { version: 2 } },
		{ method: "status", data: fleetData(0), envelope: { requestId: "wrong" } },
		{ method: "status", data: fleetData(0), envelope: { method: "cost" } },
		{ method: "status", data: fleetData(0), envelope: { success: "true" } },
		{ method: "status", data: { ...fleetData(0), isError: true } },
		{ method: "status", envelope: { success: false, error: { code: "execution_failed", message: "private error" } } },
	];
	for (const item of cases) {
		const before = h.requests.length;
		h.setRpc((request) => h.reply(request, request.method === item.method ? item.data : pingData(manager), request.method === item.method ? item.envelope : undefined));
		h.events.emit("subagents:rpc:v1:ready", pingData(manager));
		await advance(1_000);
		assert.match(h.text(), /\? AU/, JSON.stringify(item));
		assert.doesNotMatch(h.text(), /private error/);
		assert.equal(replyListeners(h), 0);
		assert.equal(h.requests.length - before, item.method === "ping" ? 1 : 2, JSON.stringify(item) + ": unsupported capability never calls status");
	}
	// Previously known values must also disappear when a status request times out.
	h.setRpc((request) => h.reply(request, request.method === "ping" ? pingData(manager) : fleetData(7)));
	h.events.emit("subagents:rpc:v1:ready", pingData(manager)); await advance(1_000);
	assert.match(h.text(), / 07 AU /);
	let delayed: any;
	h.setRpc((request) => { if (request.method === "ping") h.reply(request, pingData(manager)); else delayed = request; });
	await advance(5_000);
	assert.match(h.text(), / 07 AU /, "keep the last sample only while a bounded refresh is pending");
	assert.equal(replyListeners(h), 1);
	const beforeTimeout = h.requests.length;
	for (let n = 0; n < 10; n++) await h.runner.emit({ type: "agent_settled" });
	await advance(1_999);
	assert.equal(h.requests.length, beforeTimeout, "in-flight requests are not overlapped");
	await advance(1);
	assert.equal(replyListeners(h), 0); assert.match(h.text(), /\? AU/);
	h.reply(delayed, fleetData(88)); assert.match(h.text(), /\? AU/, "late timeout reply cannot revive data");
	h.setRpc(); await advance(1_000); // no owner: ping cannot be handled
	assert.equal(replyListeners(h), 1);
	await advance(2_000); assert.equal(replyListeners(h), 0); assert.match(h.text(), /\? AU/);
	h.setRpc((request) => h.reply(request, request.method === "ping" ? pingData(manager) : fleetData(0)));
	h.events.emit("subagents:rpc:v1:ready", pingData(manager)); await advance(1_000);
	assert.match(h.text(), / 00 AU /); assert.equal(replyListeners(h), 0);
	assert.deepEqual(h.errors, []);
});

test("fleet/decoration ownership: ready replacement, tree/new session, footer replacement/disposal and shutdown ignore stale replies", async (t) => {
	const f = await fixtures(t), manager = host.SessionManager.inMemory(f.launch), h = await harness(f, manager);
	t.after(() => h.stop());
	let delayed: any;
	h.setRpc((request) => { if (request.method === "ping") h.reply(request, pingData(manager)); else delayed = request; });
	await h.emitStart(); const advance = await activityClock(t, h);
	assert.equal(replyListeners(h), 1);
	const first = delayed;
	h.events.emit("subagents:rpc:v1:ready", pingData(manager));
	assert.equal(replyListeners(h), 0);
	h.reply(first, fleetData(91)); assert.match(h.text(), /\? AU/);
	await advance(1_000); assert.equal(replyListeners(h), 1);
	let old = delayed;
	await h.runner.emit({ type: "session_tree", newLeafId: null, oldLeafId: null });
	assert.equal(replyListeners(h), 0);
	h.reply(old, fleetData(92)); assert.match(h.text(), /\? AU/);
	await advance(250); old = delayed;
	manager.newSession(); await h.emitStart("new");
	assert.equal(replyListeners(h), 0); h.reply(old, fleetData(93)); assert.match(h.text(), /\? AU/);
	await h.motion("off"); await advance(250); old = delayed;
	const previous = h.replaceFooter();
	assert.equal(replyListeners(h), 0);
	previous.dispose(); // obsolete component must not dispose its replacement
	assert.equal(h.subscriptions.get("subagents:rpc:v1:ready"), 1);
	assert.deepEqual(previous.render(300), []);
	h.reply(old, fleetData(94)); assert.match(h.text(), /\? AU/);
	await advance(250); old = delayed;
	h.component.dispose();
	assert.equal(replyListeners(h), 0);
	assert.equal(h.subscriptions.get("subagents:rpc:v1:ready"), 0);
	const renders = h.renders, requests = h.requests.length;
	h.reply(old, fleetData(95)); h.events.emit("subagents:rpc:v1:ready", pingData(manager));
	await advance(10_000);
	assert.equal(h.renders, renders); assert.equal(h.requests.length, requests);
	assert.deepEqual(h.component.render(300), []);
	// Display disposal does not remove the agent's display-only selection capability.
	const selection = await h.select(f.plain); assert.equal(selection.details.path, f.plain);
	h.replaceFooter(); await advance(250);
	assert.equal(replyListeners(h), 1);
	old = delayed;
	await h.stop(); h.runner.invalidate();
	const stoppedRequests = h.requests.length;
	h.reply(old, fleetData(96)); await advance(10_000);
	assert.equal(replyListeners(h), 0); assert.equal(h.requests.length, stoppedRequests);
	assert.equal(h.subscriptions.get("subagents:rpc:v1:ready"), 0);
	assert.deepEqual(h.errors, []);
});

const ponytailCode = (h: any) => /PNYTL \/\/ (\w{3})/.exec(h.text())?.[1];
const ponytailText = (mode: string, working = false) => `${working ? "●" : "○"} 🐴 ponytail: ${{ lite: "🌿 LITE", full: "⚡ FULL", ultra: "🔥 ULTRA", review: " REVIEW" }[mode]}`;
// Synthetic portable producer: actual optional producer compatibility is checked
// separately against installed Ponytail, never silently required by npm test.
async function statusProducer(f: any, initial: string) {
	const path = join(f.root, `producer-${initial}.ts`);
	await writeFile(path, `export default function(pi) { const emit = (_e,ctx) => {${initial === "hidden" ? "" : `ctx.ui.setStatus('ponytail', ${initial === "off" ? "undefined" : JSON.stringify(ponytailText(initial))});`}}; pi.on('session_start',emit); pi.on('session_tree',emit); }`);
	return path;
}

test("PNYTL status startup: observer-first captures OFF; producer-first recovers labels but missing never guesses OFF", async (t) => {
	const f = await fixtures(t);
	for (const first of [true, false]) for (const mode of ["off", "lite", "full", "ultra", "review", "hidden"]) {
		const producer = await statusProducer(f, mode), manager = host.SessionManager.inMemory(f.launch);
		const h = await harness(f, manager, "tui", { [first ? "after" : "before"]: [producer], emptyStatuses: true });
		t.after(() => h.stop()); await h.emitStart();
		const expected = mode === "hidden" || (mode === "off" && !first) ? "UNK" : { off: "OFF", lite: "LTE", full: "FUL", ultra: "ULT", review: "REV" }[mode];
		if (expected === "UNK") { assert.equal(ponytailCode(h), "CHK"); await sleep(5); }
		assert.equal(ponytailCode(h), expected, `${first}/${mode}`);
		if (expected !== "UNK") {
			assert.doesNotMatch(h.text(), /🐴 ponytail:/, "recognized status is represented once");
			if (mode !== "off") assert.equal(h.statuses.get("ponytail"), ponytailText(mode), "host map is NOT suppressed");
		}
		h.setStatus("ponytail", undefined); assert.equal(ponytailCode(h), "OFF", "later explicit clear works in either order");
		await h.stop(); assert.deepEqual(h.errors, []);
	}
});

test("PNYTL parses only bounded exact styled format; preserves malformed/warning raw status and every other key", async (t) => {
	const f = await fixtures(t), h = await harness(f, host.SessionManager.inMemory(f.launch), "tui", { emptyStatuses: true });
	t.after(() => h.stop()); await h.emitStart(); await h.motion("off");
	const other = "\x1b[38;2;4;5;6mother FULL status\x1b[0m";
	h.setStatus("ponytail-warning", other); h.setStatus("other", "Other status");
	for (const [mode, code] of [["lite", "LTE"], ["full", "FUL"], ["ultra", "ULT"], ["review", "REV"]]) {
		h.setStatus("ponytail", `\x1b[38:2::1:2:3m${ponytailText(mode)}\x1b[0m`);
		assert.equal(ponytailCode(h), code); assert.doesNotMatch(h.text(), /🐴 ponytail:/);
		assert.match(h.text(), /other FULL status/); assert.match(h.text(), /Other status/);
		assert.equal(h.statuses.get("ponytail-warning"), other);
		assert.match(h.component.render(300).join(""), /\x1b\[38;2;4;5;6mother FULL status/);
	}
	for (const raw of ["FULL", "Warning FULL unavailable", "○ 🐴 ponytail: ⚡ FULL extra", "○ 🐴 ponytail: 🌿 FULL", "○ 🐴 ponytail: FULL", "○ 🐴 ponytail:  review", "○ 🐴 ponytail: ⚡ FULL\n", "\x1b[2J" + ponytailText("full"), ponytailText("full") + "\x1b]0;attack\x07", "\u202e" + ponytailText("full"), "x".repeat(600)]) {
		h.setStatus("ponytail", raw);
		assert.equal(ponytailCode(h), "UNK", JSON.stringify(raw));
		assert.equal(h.statuses.get("ponytail"), raw, "host data untouched");
		assert.match(h.text(), /05 EXT/);
		assert.doesNotMatch(h.component.render(300).join(""), /\x1b\[2J|\x1b\]|\u202e/);
	}
	h.setStatus("ponytail", "warning: FULL unavailable"); assert.match(h.text(), /warning: FULL unavailable/);
	h.setStatus("ponytail", ponytailText("lite")); h.statuses.delete("ponytail");
	assert.equal(ponytailCode(h), "UNK", "map absence without observed clear is not OFF");
	for (let n = 0; n < 30; n++) h.text();
	assert.deepEqual(h.errors, []);
});

test("PNYTL observer preserves original receiver/return/errors, does not stack and never overwrites later foreign wrappers", async (t) => {
	const f = await fixtures(t), h = await harness(f, host.SessionManager.inMemory(f.launch), "tui", { emptyStatuses: true });
	t.after(() => h.stop()); const original = h.ui.setStatus;
	await h.emitStart(); const wrapped = h.ui.setStatus;
	assert.notEqual(wrapped, original);
	assert.equal(h.setStatus("other", "data"), "forwarded"); assert.equal(h.statusCalls.at(-1).receiver, h.ui);
	assert.throws(() => h.setStatus("throw-fixture", "failure"), /status failure/);
	h.setStatus("ponytail", undefined); assert.equal(ponytailCode(h), "OFF");
	for (let n = 0; n < 10; n++) { const old = h.replaceFooter(); old.dispose(); assert.equal(h.ui.setStatus, wrapped); assert.equal(ponytailCode(h), "OFF"); }
	let calls = 0;
	const foreign = function (this: any, ...args: any[]) { calls++; return wrapped.apply(this, args); };
	h.ui.setStatus = foreign;
	for (let n = 0; n < 10; n++) h.replaceFooter();
	assert.equal(h.ui.setStatus, foreign); const before = h.statusCalls.length;
	h.setStatus("ponytail", ponytailText("ultra")); assert.equal(calls, 1); assert.equal(h.statusCalls.length, before + 1); assert.equal(ponytailCode(h), "ULT");
	h.component.dispose(); assert.equal(h.ui.setStatus, foreign);
	const renders = h.renders;
	h.setStatus("ponytail", undefined); assert.equal(h.renders, renders, "inert under foreign chain after disposal");
	assert.equal(h.statuses.has("ponytail"), false, "fallback footer still gets the original behavior");
	await h.stop(); assert.equal(h.ui.setStatus, foreign); assert.deepEqual(h.errors, []);
});

test("PNYTL lifecycle: no OFF evidence crosses session/UI; tree/new/reload/resume/fork rebind and shutdown/non-TUI detach", async (t) => {
	const f = await fixtures(t), manager = host.SessionManager.inMemory(f.launch), h = await harness(f, manager, "tui", { emptyStatuses: true });
	t.after(() => h.stop()); const original = h.ui.setStatus;
	await h.emitStart(); h.setStatus("ponytail", undefined); assert.equal(ponytailCode(h), "OFF");
	for (const reason of ["tree", "new", "reload", "resume", "fork"]) {
		const oldComponent = h.component;
		if (reason === "tree") await h.runner.emit({ type: "session_tree", newLeafId: null, oldLeafId: null });
		else { if (reason === "new" || reason === "fork") manager.newSession(); await h.emitStart(reason); }
		assert.deepEqual(oldComponent.render(120), []); oldComponent.dispose();
		assert.equal(ponytailCode(h), "CHK"); await sleep(5); assert.equal(ponytailCode(h), "UNK", reason);
		h.setStatus("ponytail", undefined); assert.equal(ponytailCode(h), "OFF");
	}
	const oldUI = h.ui; h.replaceUI(); assert.notEqual(h.ui, oldUI);
	await h.emitStart("reload"); assert.equal(oldUI.setStatus, original);
	oldUI.setStatus("ponytail", undefined); assert.equal(ponytailCode(h), "CHK", "old UI cannot create new OFF evidence");
	h.setStatus("ponytail", undefined); assert.equal(ponytailCode(h), "OFF");
	// A render can rebind a replaced UI even before its next lifecycle event.
	h.replaceUI(); h.text(); await sleep(5); assert.notEqual(ponytailCode(h), "OFF");
	h.setStatus("ponytail", ponytailText("review")); assert.equal(ponytailCode(h), "REV");
	const nextOriginal = h.ui.setStatus; await h.stop(); assert.notEqual(h.ui.setStatus, nextOriginal);
	const renders = h.renders; h.setStatus("ponytail", undefined); assert.equal(h.renders, renders);
	const nonTui = await harness(f, host.SessionManager.inMemory(f.launch), "print"); t.after(() => nonTui.stop());
	const untouched = nonTui.ui.setStatus; await nonTui.emitStart(); assert.equal(nonTui.ui.setStatus, untouched);
	assert.equal(nonTui.component, undefined); assert.deepEqual(h.errors, []);
});

test("PNYTL live status/motion: immediate idle changes, no activity-only flashes, off-time replay or extra bus I/O", async (t) => {
	const f = await fixtures(t), h = await harness(f, host.SessionManager.inMemory(f.launch), "tui", { emptyStatuses: true });
	t.after(() => h.stop()); await h.emitStart(); h.setStatus("ponytail", ponytailText("lite")); h.text();
	const advance = await activityClock(t, h);
	const modeInk = () => {
		const line = h.component.render(120).find((line: string) => stripTerminalSequences(line).includes("PNYTL"));
		const start = stripTerminalSequences(line).indexOf("PNYTL") + 9;
		let col = 0, fg = "", inks: string[] = [];
		for (const token of line.match(/\x1b\[[0-9;]*m|[^\x1b]/gu) ?? []) {
			if (token.startsWith("\x1b")) { const color = /^\x1b\[38;2;(\d+;\d+;\d+)m$/.exec(token); if (color) fg = color[1]; }
			else { if (col >= start && col < start + 3) inks.push(fg); col++; }
		}
		return inks.join("|");
	};
	const black = /(?:^|\|)0;0;0(?:\||$)/;
	h.setStatus("ponytail", ponytailText("full")); assert.equal(ponytailCode(h), "FUL"); assert.doesNotMatch(modeInk(), black);
	await h.motion("on"); await advance(100); assert.doesNotMatch(modeInk(), black);
	h.setStatus("ponytail", ponytailText("full", true)); await advance(100); assert.doesNotMatch(modeInk(), black, "activity glyph is not a mode change");
	h.setStatus("ponytail", ponytailText("ultra")); h.text(); await advance(100); assert.match(modeInk(), black);
	await h.motion("off"); assert.doesNotMatch(modeInk(), black);
	await h.motion("on"); h.setStatus("ponytail", ponytailText("review")); h.text(); await advance(100); assert.doesNotMatch(modeInk(), black);
	h.replaceFooter(); h.setStatus("ponytail", ponytailText("lite")); h.text(); await advance(100); assert.doesNotMatch(modeInk(), black);
	h.setStatus("ponytail", undefined); assert.equal(ponytailCode(h), "OFF"); assert.doesNotMatch(modeInk(), black);
	const count = h.requests.length; for (let n = 0; n < 30; n++) h.text(); assert.equal(h.requests.length, count);
	assert.deepEqual(h.errors, []);
});


test("PNYTL observer and directory-first linked-worktree selection preserve both footer features", async (t) => {
	const f = await fixtures(t), checkout = join(f.root, "linked-footer-worktree");
	f.runGit(f.repo, ["worktree", "add", "-b", "feat/footer-ponytail", checkout]);
	const manager = host.SessionManager.inMemory(f.launch), h = await harness(f, manager, "tui", { emptyStatuses: true });
	t.after(() => h.stop()); await h.emitStart(); await h.motion("off");
	await h.select(checkout); await until(() => /feat\/footer-ponytail {2}clean/.test(h.text()));
	h.setStatus("other", "Other extension retained");
	for (const [raw, expected] of [[ponytailText("full"), "FUL"], [undefined, "OFF"], ["warning: Ponytail unavailable", "UNK"]] as const) {
		h.setStatus("ponytail", raw);
		assert.equal(ponytailCode(h), expected);
		const lines = h.text().split("\n"), act = lines.findIndex((line) => line.includes("02 ACT"));
		assert.ok(lines[act].includes(shown(checkout)));
		assert.doesNotMatch(lines[act], /feat\/footer-ponytail|clean|⑂/);
		assert.match(lines[act + 1], /⑂ feat\/footer-ponytail {2}clean/);
		assert.doesNotMatch(lines[act + 1], /02 ACT/);
		assert.doesNotMatch(h.text(), /2\.1 MN|release|https:\/\/github\.com/);
		assert.match(h.text(), /Other extension retained/);
		if (expected === "UNK") assert.match(h.text(), /warning: Ponytail unavailable/);
		else assert.doesNotMatch(h.text(), /🐴 ponytail:/);
	}
	assert.equal(manager.getCwd(), f.launch, "selection remains display-only");
	assert.deepEqual(h.errors, []);
});
