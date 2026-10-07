import assert from "node:assert/strict";
import { ChildProcess, execFileSync } from "node:child_process";
import { chmod, cp, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import test, { after } from "node:test";

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
// Lit and lost USG squares are both `■` and differ only by style. Text shows a ghost-grey `■` (#333333) as `□` so the lit
// count stays readable; motion checks that only compare glyphs use the raw characters.
const GHOST_INK = "\x1b[38;2;51;51;51m\x1b[48;2;0;0;0m";
const shownText = (line: string) => stripTerminalSequences(line.replaceAll(`${GHOST_INK}■`, `${GHOST_INK}□`));
// Display shows the immediate parent/current directory; stored paths stay absolute.
const shown = (path: string) => `${basename(dirname(path))}/${basename(path)}`;
const row = (text: string, label: string) => text.split("\n").find((line) => line.includes(label)) ?? "";
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const lines = async (path: string) => { try { return (await readFile(path, "utf8")).split("\n").filter(Boolean); } catch { return []; } };
// Signal 0 only probes: a reaped child is gone, and the extension has seen its exit.
const running = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error: any) { return error.code !== "ESRCH"; } };
// Captured before any test mocks timers: waits on real subprocesses while adapter timers are mocked.
const nativeSetTimeout = setTimeout;
const realSleep = (ms: number) => new Promise((done) => nativeSetTimeout(done, ms));
async function untilReal(check: () => boolean | Promise<boolean>) {
	for (let n = 0; n < 400; n++) { if (await check()) return; await realSleep(20); }
	throw new Error("Timed out waiting for integrated extension");
}
async function until(check: () => boolean | Promise<boolean>) {
	for (let n = 0; n < 200; n++) { if (await check()) return; await sleep(20); }
	throw new Error("Timed out waiting for integrated extension");
}

// Fakes on PATH (POSIX sh: far faster to start than Node wrappers). PATH is only the fixture's `bin`, so utilities
// are absolute; fixture paths come from PI_FOOTER_FIXTURE. Contents never vary because the OS checks a new
// executable's content on its first run (~0.25 s on macOS); each fixture links these once-per-run files.
// Every call logs its pid first. A `.hold-git` file in the cwd parks every Git call except
// `rev-parse --show-toplevel` (selection and the first inspection step) until the file is removed.
const fakeGit = `#!/bin/sh
printf '%s %s %s\\n' "$$" "$PWD" "$*" >> "$PI_FOOTER_FIXTURE/git.log"
if [ "$1" = symbolic-ref ] && [ -e .broken-head ]; then printf 'branch failure' >&2; exit 128; fi
if [ "$1 $2" != "rev-parse --show-toplevel" ]; then while [ -e .hold-git ]; do /bin/sleep 0.02 </dev/null >/dev/null 2>&1; done; fi
exec ${quote(git)} "$@"
`;
// Deterministic gh boundary, never a live account or network. [] either means
// no PR or a truthful unavailable result if the domain rejects that protocol.
const fakeGh = `#!/bin/sh
printf '%s %s\\n' "$$" "$*" >> "$PI_FOOTER_FIXTURE/gh.log"
printf '[]'
`;
// Deterministic `codexbar`: the n-th call for a provider prints `<provider>.<n>.json` (else `<provider>.json`) from
// the fixture's `codexbar` directory, exits 1 for an error payload, and records SIGTERM. A `hold-<provider>.<n>` file
// keeps that call pending until the test releases it, independent of real-time scheduling. The trap is armed
// before the call is logged, so a logged call always records its SIGTERM.
const fakeCodexbarScript = `#!/bin/sh
p=$3 dir="$PI_FOOTER_FIXTURE/codexbar" log="$PI_FOOTER_FIXTURE/codexbar.log"
trap 'printf "%s\\n" "$p" >> "$PI_FOOTER_FIXTURE/codexbar.kills"; exit 143' TERM
prior=0; [ -e "$log" ] && prior=$(/usr/bin/grep -c -e " --provider $p " "$log")
printf '%s %s\\n' "$$" "$*" >> "$log"
while [ -e "$dir/hold-$p.$prior" ]; do /bin/sleep 0.02 </dev/null >/dev/null 2>&1; done
if [ -e "$dir/$p.$prior.json" ]; then out=$(/bin/cat "$dir/$p.$prior.json"); else out=$(/bin/cat "$dir/$p.json" 2>/dev/null); fi
printf '%s' "$out"
case $out in *'"error"'*) exit 1 ;; esac
`;
const gitIsolation = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
const runGit = (cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) => execFileSync(git, ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd, env, encoding: "utf8" });
const shared = await realpath(await mkdtemp(join(tmpdir(), "pi-footer-shared-")));
after(() => rm(shared, { recursive: true, force: true }));
const fakes = join(shared, "fakes"), seed = join(shared, "seed");
await Promise.all([fakes, seed].map((path) => mkdir(path)));
for (const [name, script] of [["git", fakeGit], ["gh", fakeGh], ["codexbar", fakeCodexbarScript]]) {
	await writeFile(join(fakes, name), script); await chmod(join(fakes, name), 0o755);
}
// One isolated seed repository (branch `release`, one empty commit); each fixture copies it.
runGit(seed, ["init", "-b", "release"], { ...process.env, ...gitIsolation });
runGit(seed, ["commit", "--allow-empty", "-m", "fixture"], { ...process.env, ...gitIsolation });

async function fixtures(t: any) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-footer-integration-")));
	const bin = join(root, "bin"), launch = join(root, "launch"), plain = join(root, "plain ü"), repo = join(root, "repo"), second = join(root, "other repo");
	await Promise.all([bin, launch, plain].map((path) => mkdir(path)));
	await Promise.all([repo, second].map((path) => cp(seed, path, { recursive: true })));
	await Promise.all(["git", "gh"].map((name) => symlink(join(fakes, name), join(bin, name))));
	const saved = { ...process.env };
	Object.assign(process.env, { PATH: bin, PI_FOOTER_FIXTURE: root, ...gitIsolation });
	const gitLog = join(root, "git.log"), ghLog = join(root, "gh.log");
	t.after(async () => {
		// Preserve Node's native environment object so os.homedir sees later HOME changes.
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
		await rm(root, { recursive: true, force: true });
	});
	const count = async (path: string) => (await lines(path)).length;
	// Every Git and gh process has ended, so its result has reached the extension.
	const idle = async () => [...await lines(gitLog), ...await lines(ghLog)].every((line) => !running(Number.parseInt(line)));
	// Pids of `.hold-git` calls made in `cwd`.
	const parked = async (cwd: string) => (await lines(gitLog)).filter((line) => line.includes(` ${cwd} `) && !line.endsWith(" rev-parse --show-toplevel")).map((line) => Number.parseInt(line));
	return { root, launch, plain, repo, second, runGit, gitLog, ghLog, count, idle, parked };
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
	let settings: any = {};
	const notices: [string, string][] = [];
	const statuses = new Map(extra.emptyStatuses ? [] : [["ponytail", "\x1b[32mPonytail ready\x1b[0m"]]);
	const statusCalls: any[] = [];
	let renders = 0;
	const errors: any[] = []; runner.onError((error: any) => errors.push(error));
	runner.bindCore({
		sendMessage() {}, sendUserMessage() {}, appendEntry: (type: string, data: any) => manager.appendCustomEntry(type, data), setSessionName() {}, getSessionName: () => undefined, setLabel() {},
		getActiveTools: () => [tool.name], getAllTools: () => [tool], getSettings: () => structuredClone(settings), setActiveTools() {}, refreshTools() {}, getCommands: () => [], setModel: async () => true,
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
	const text = () => component?.render(300).map(shownText).join("\n") ?? "";
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
		runner, tool, emitStart, stop, text, select, statuses, errors, motion, notices, get component() { return component; }, get renders() { return renders; }, setUsage(value: any) { usage = value; }, setSettings(value: any) { settings = value; }, changeModel() { model = { ...model, id: "second-model" }; thinking = "off"; usage = { tokens: null, percent: null, contextWindow: 128_000 }; } };
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
	// Active starts at Launch (Pi's cwd), so no cwd line appears until a deliberate move.
	assert.match(h.text(), /01 ACT +~\/launch /); assert.doesNotMatch(h.text(), /cwd|LDR/);
	const result = await h.select(f.plain);
	// Pi's cwd takes the spacer row directly above ACT.
	assert.match(h.text(), /\n[┃ ] +cwd ~\/launch [ ┃]*\n +01 ACT +~\/plain ü /);
	assert.equal(result.details.path, f.plain);
	assert.equal(manager.getCwd(), f.launch);
});

test("tree restoration follows branch; reload/resume and fork restore; new session resets", async (t) => {
	const f = await fixtures(t);
	const manager = host.SessionManager.create(f.launch, join(f.root, "sessions"));
	const rootId = manager.appendMessage({ role: "assistant", content: [], api: "openai-completions", provider: "fixture", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
	const h = await harness(f, manager); t.after(() => h.stop()); await h.emitStart();
	await h.select(f.repo); const repoId = manager.getLeafId();
	await h.select(f.plain); assert.ok(row(h.text(), "01 ACT").includes(shown(f.plain)));
	manager.branch(repoId);
	await h.runner.emit({ type: "session_tree", newLeafId: repoId, oldLeafId: null });
	assert.ok(row(h.text(), "01 ACT").includes(shown(f.repo)));
	assert.ok(row(h.text(), "cwd ").includes(shown(f.launch)));
	// Persist an entry on the selected branch: a leaf pointer alone is not a
	// durable session-file change when later reopened by SessionManager.open.
	manager.appendCustomEntry("fixture-selected-branch", {});
	await h.stop("reload"); h.runner.invalidate();
	const restored = await harness(f, manager); t.after(() => restored.stop()); await restored.emitStart("reload");
	assert.ok(row(restored.text(), "01 ACT").includes(shown(f.repo)));
	const resumed = await harness(f, host.SessionManager.open(manager.getSessionFile())); t.after(() => resumed.stop()); await resumed.emitStart("resume");
	assert.ok(row(resumed.text(), "01 ACT").includes(shown(f.repo)));
	const forkManager = host.SessionManager.forkFrom(manager.getSessionFile(), f.launch, join(f.root, "forks"));
	const forked = await harness(f, forkManager); t.after(() => forked.stop()); await forked.emitStart("fork");
	assert.ok(row(forked.text(), "01 ACT").includes(shown(f.repo)));
	manager.branch(rootId); await restored.runner.emit({ type: "session_tree", newLeafId: rootId, oldLeafId: repoId });
	assert.ok(row(restored.text(), "01 ACT").includes(shown(f.launch))); assert.doesNotMatch(restored.text(), /cwd /);
	const fresh = await harness(f, host.SessionManager.inMemory(f.launch)); t.after(() => fresh.stop()); await fresh.emitStart("new");
	assert.ok(row(fresh.text(), "01 ACT").includes(shown(f.launch))); assert.doesNotMatch(fresh.text(), /cwd /);
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
	// Render counts below are compared across event emits only, which settle in microtasks: no timer or subprocess
	// result can interleave, so no settling time is needed after startup.
	await until(() => !/Git pending/.test(h.text())); await h.motion("off");
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
	await h.select(f.repo); await until(() => /release clean/.test(h.text()));
	await writeFile(join(f.repo, "untracked"), "changed");
	await h.runner.emit({ type: "tool_execution_end", toolCallId: "external-write", toolName: "write", result: { content: [], details: undefined }, isError: false });
	await until(() => /release modified/.test(h.text()));
	h.statuses.set("second", "Second extension status"); h.changeModel();
	assert.match(h.text(), /Ponytail ready/); assert.match(h.text(), /Second extension status/);
	assert.match(h.text(), /second-model · thinking off/); assert.match(h.text(), /\?\/112k[^\n]*\? UNKNOWN/, "Pi\'s default 16384 reserve sets the budget");
	// Live settings: a model override beats compaction.reserveTokens; disabled or rejected settings keep the full window.
	h.setUsage({ tokens: 48_000, contextWindow: 128_000, percent: 37.5 });
	h.setSettings({ compaction: { reserveTokens: 8_000, modelOverrides: { "fixture/second-model": { reserveTokens: 64_000 }, "fixture/first-model": { reserveTokens: 1 } } } });
	assert.match(h.text(), /48k\/64k[^\n]*▲ WARN/, "per-model override sets the budget");
	h.setSettings({ compaction: { reserveTokens: 8_000 } }); assert.match(h.text(), /48k\/120k/, "ordinary reserve applies without an override");
	for (const compaction of [{ enabled: false, reserveTokens: 64_000 }, { reserveTokens: -1, modelOverrides: { "fixture/second-model": { reserveTokens: 64_000 } } }, { modelOverrides: { "fixture/second-model": { reserveTokens: "64k" } } }, { modelOverrides: { "fixture/second-model": 64_000 } }]) {
		h.setSettings({ compaction }); assert.match(h.text(), /48k\/128k/, JSON.stringify(compaction));
	}
	h.setSettings({});
	// Inspections of `second` park in Git, so they are in flight when the next selection or shutdown arrives.
	await writeFile(join(f.second, ".hold-git"), "hold");
	const parkedEnded = async () => (await f.parked(f.second)).every((pid: number) => !running(pid));
	await h.select(f.second); await until(async () => (await f.parked(f.second)).length > 0); await h.select(f.plain);
	// The plain path is followed directly by CTX: no stale Git details in between.
	const plainOnly = new RegExp(`01 ACT +${shown(f.plain).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} [^\\n⑂]*\\n +02 CTX `);
	// Parked calls never finish on their own: once every one has been killed, the stale inspection has settled.
	await until(() => plainOnly.test(h.text())); await until(parkedEnded);
	assert.match(h.text(), plainOnly); assert.doesNotMatch(h.text(), /2\.1 MN|release|GitHub|Not a Git repository|No GitHub remote/);
	assert.match(h.text(), / CMP×00 /, "CMP stays visible without repository data");
	const parkedBefore = (await f.parked(f.second)).length;
	await h.select(f.second); await until(async () => (await f.parked(f.second)).length > parkedBefore); const priorRenders = h.renders;
	// Shutdown aborts the parked inspection; two motion ticks follow, which would show a surviving decoration timer.
	await h.stop(); h.runner.invalidate(); await until(parkedEnded); await sleep(100);
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
	await until(() => /release clean/.test(h.text()) && /CMP×00  ■ fixture\/status-bar/.test(h.text()) && !/PR unavailable/.test(h.text()));
	// Named repository and known branch: the branch replaces the path on the ACT row.
	assert.match(row(h.text(), "01 ACT"), /01 ACT {2}⑂ release clean/); assert.doesNotMatch(h.text(), new RegExp(shown(f.repo)));
	assert.ok(row(h.text(), "cwd ").includes(shown(f.launch)));
	assert.equal(await f.count(f.ghLog), 1);
	assert.deepEqual(h.errors, []);
});

test("session-scoped 15s refresh and repo/branch PR TTL; tree keeps cache, switches invalidate", async (t) => {
	const f = await fixtures(t);
	f.runGit(f.repo, ["remote", "add", "origin", "https://github.com/fixture/status-bar.git"]);
	f.runGit(f.second, ["remote", "add", "origin", "https://github.com/fixture/second.git"]);
	t.mock.timers.enable({ apis: ["setInterval", "Date"] });
	const manager = host.SessionManager.inMemory(f.launch), h = await harness(f, manager); t.after(() => h.stop()); await h.emitStart();
	// Without decoration, a render here marks a finished local refresh, whose PR step has consulted the cache.
	await h.motion("off");
	// Git and the PR are both shown: a cached PR fills in with Git, a lookup leaves `lookup pending` until gh answers.
	const settled = () => !/Git pending|GitHub pending|lookup pending/.test(h.text());
	await h.select(f.repo); const selected = manager.getLeafId();
	await until(async () => await f.count(f.ghLog) >= 1 && settled());
	const initial = await f.count(f.ghLog);
	for (let n = 0; n < 3; n++) {
		const renders = h.renders;
		await h.runner.emit({ type: "tool_execution_end", toolCallId: `tool-${n}`, toolName: "read", result: { content: [], details: undefined }, isError: false });
		await until(() => h.renders > renders);
	}
	assert.equal(await f.count(f.ghLog), initial, "tools must not hit network per refresh");
	await h.runner.emit({ type: "session_tree", newLeafId: selected, oldLeafId: selected }); await until(settled);
	assert.equal(await f.count(f.ghLog), initial, "tree navigation retains the same-session PR TTL");
	await writeFile(join(f.repo, "external"), "external change");
	t.mock.timers.tick(15_000); await until(() => /modified/.test(h.text()));
	assert.equal(await f.count(f.ghLog), initial);
	t.mock.timers.tick(60_000); await until(async () => await f.count(f.ghLog) > initial); await until(f.idle);
	let count = await f.count(f.ghLog);
	f.runGit(f.repo, ["checkout", "-b", "feature"]);
	t.mock.timers.tick(15_000); await until(async () => await f.count(f.ghLog) > count); await until(f.idle);
	count = await f.count(f.ghLog); await h.select(f.second);
	await until(async () => await f.count(f.ghLog) > count); await until(f.idle);
	await h.stop(); await until(f.idle);
	// A surviving interval would start Git within this window (an fs check, then a spawn).
	const gitCount = await f.count(f.gitLog); t.mock.timers.tick(120_000); await sleep(100);
	assert.equal(await f.count(f.gitLog), gitCount, "shutdown clears polling and pending work");
	assert.deepEqual(h.errors, []);
});

test("decorative motion: footer-owned unref'd timer, session /footer-motion, live values and disposal without extra I/O", async (t) => {
	const f = await fixtures(t), manager = host.SessionManager.inMemory(f.launch);
	const refTimers = () => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
	const h = await harness(f, manager); t.after(() => h.stop());
	const baseline = refTimers();
	await h.emitStart(); await until(() => /01 ACT +\S+\/launch +▐/.test(h.text()) && !/Git pending/.test(h.text())); await until(f.idle);
	const local = await f.count(f.gitLog), remote = await f.count(f.ghLog);
	// Real time first: wait for the next decoration wake (a boot tick, or an ambient event at most ~4.2 s after the
	// last); Git or gh started by a wake would be logged meanwhile.
	let renders = h.renders; await untilReal(() => h.renders > renders);
	assert.ok(h.renders > renders, "decoration repaints itself while motion is on");
	assert.equal(refTimers(), baseline, "animation and refresh timers are unref'd");
	assert.equal(await f.count(f.gitLog), local, "animation never inspects Git");
	assert.equal(await f.count(f.ghLog), remote, "animation never queries GitHub");
	h.setUsage({ tokens: 120_000, contextWindow: 128_000, percent: 93.75 });
	assert.match(h.text(), /120k\/112k[^\n]*▲ HIGH/, "a tone change shows the current value immediately, mid-wipe");

	const cleared = t.mock.method(globalThis, "clearTimeout");
	await h.motion("off");
	assert.ok(cleared.mock.callCount() >= 1, "pausing clears the pending animation timeout"); cleared.mock.restore();
	// The real animation timeout is cleared; every later decoration wake is on the mocked clock and runs only when
	// advanced, so each 600 ms window below is exact. Subprocess waits stay on real time.
	const advance = mockClock(t);
	assert.deepEqual(h.notices.at(-1), ["info", "Footer motion off for this session"]);
	const settled = h.text(); renders = h.renders;
	assert.match(settled.split("\n")[0], /┓$/, "settled frame is fully drawn");
	await advance(600);
	assert.equal(h.renders, renders, "motion off leaves no repaint timer"); assert.equal(h.text(), settled);
	h.setUsage({ tokens: null, contextWindow: 128_000, percent: null });
	assert.match(h.text(), /\?\/112k[^\n]*\? UNKNOWN/, "live values still update with motion off");
	await h.motion("sideways");
	assert.deepEqual(h.notices.at(-1), ["warning", "Usage: /footer-motion [on|off]"]);
	await advance(300); assert.equal(h.renders, renders, "invalid arguments leave motion unchanged");
	await h.runner.emit({ type: "session_tree", newLeafId: null, oldLeafId: null });
	// The restore's own local refresh and status check may repaint once.
	await untilReal(() => !/Git pending/.test(h.text())); await untilReal(f.idle); await advance(300); renders = h.renders;
	await advance(600); assert.equal(h.renders, renders, "same-session tree restore keeps the motion choice");

	await h.motion(""); renders = h.renders; await advance(600);
	assert.ok(h.renders > renders, "empty argument toggles motion back on");
	assert.equal(h.runner.getCommand("footer-motion").getArgumentCompletions("o").map((item: any) => item.value).join(), "on,off");
	await h.stop(); h.runner.invalidate(); renders = h.renders; await advance(600);
	assert.equal(h.renders, renders, "shutdown disposes the animation timer");
	const fresh = await harness(f, host.SessionManager.inMemory(f.launch)); t.after(() => fresh.stop());
	await fresh.emitStart(); renders = fresh.renders; await advance(600);
	assert.ok(fresh.renders > renders, "a new session starts with motion on");
	assert.deepEqual([...h.errors, ...fresh.errors], []);
});

const pingData = (manager: any) => ({ version: 1, session: { sessionId: manager.getSessionId() }, capabilities: { fleetStatus: { version: 1 } } });
const fleetData = (units: number) => ({ fleet: { version: 1, entries: [], totalActive: units, omitted: units } });
const replyListeners = (h: any) => [...h.subscriptions].filter(([name]: [string, number]) => name.startsWith("subagents:rpc:v1:reply:")).reduce((sum: number, [, n]: [string, number]) => sum + n, 0);
// Mocks setTimeout and the decoration clock from now on; timers armed earlier stay real.
function mockClock(t: any) {
	let now = Math.ceil(performance.now());
	t.mock.method(performance, "now", () => now);
	t.mock.timers.enable({ apis: ["setTimeout"] });
	return async (ms: number) => { now += ms; t.mock.timers.tick(ms); for (let n = 0; n < 16; n++) await Promise.resolve(); };
}
// Only this adapter's activity/decoration timers are accelerated, from before `start` installs the footer, so the
// first fleet poll (250 ms after installation) runs when advanced; the bus itself remains Pi's bus. Subprocesses,
// including execFile's own timeouts, stay on real time.
async function activityClock(t: any, h: any, start: () => Promise<unknown>) {
	const advance = mockClock(t);
	await start();
	await untilReal(() => !/Git pending/.test(h.text()));
	await advance(250);
	await h.motion("off");
	return advance;
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
	const advance = await activityClock(t, h, () => h.emitStart());
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
	const advance = await activityClock(t, h, () => h.emitStart());
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
	const advance = await activityClock(t, h, () => h.emitStart());
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
	// Ponytail's ● activity dot lights the plate (held lit with motion off); ○ restores the icon.
	h.setStatus("ponytail", ponytailText("full", true)); assert.match(h.text(), /• PNYTL \/\/ FUL/); assert.doesNotMatch(h.text(), /⌑/);
	h.setStatus("ponytail", ponytailText("full", false)); assert.match(h.text(), /⌑ PNYTL \/\/ FUL/); assert.doesNotMatch(h.text(), /•/);
	h.setStatus("ponytail", ponytailText("full", true)); h.setStatus("ponytail", undefined);
	assert.equal(ponytailCode(h), "OFF"); assert.match(h.text(), /⌑ PNYTL \/\/ OFF/, "a clear never leaves the light on");
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
	t.after(() => h.stop());
	const advance = await activityClock(t, h, async () => { await h.emitStart(); h.setStatus("ponytail", ponytailText("lite")); h.text(); });
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
	await h.select(checkout); await until(() => /feat\/footer-ponytail clean/.test(h.text()));
	h.setStatus("other", "Other extension retained");
	for (const [raw, expected] of [[ponytailText("full"), "FUL"], [undefined, "OFF"], ["warning: Ponytail unavailable", "UNK"]] as const) {
		h.setStatus("ponytail", raw);
		assert.equal(ponytailCode(h), expected);
		const lines = h.text().split("\n"), act = lines.findIndex((line) => line.includes("01 ACT"));
		assert.ok(lines[act].includes(shown(checkout)));
		assert.doesNotMatch(lines[act], /feat\/footer-ponytail|clean|⑂/);
		assert.match(lines[act + 1], /⑂ feat\/footer-ponytail clean/);
		assert.doesNotMatch(lines[act + 1], /01 ACT/); assert.ok(lines[act - 1].includes(`cwd ${shown(f.launch)}`));
		assert.doesNotMatch(h.text(), /2\.1 MN|release|https:\/\/github\.com/);
		assert.match(h.text(), /Other extension retained/);
		if (expected === "UNK") assert.match(h.text(), /warning: Ponytail unavailable/);
		else assert.doesNotMatch(h.text(), /🐴 ponytail:/);
	}
	assert.equal(manager.getCwd(), f.launch, "selection remains display-only");
	assert.deepEqual(h.errors, []);
});

/* ---------- USG: CodexBar usage through a fake `codexbar` on PATH ---------- */

// Real CodexBar 0.60.3 shapes (identity removed) at a fixed wall clock; the adapter clock is mocked to USG_NOW.
const USG_NOW = Date.parse("2026-10-07T03:05:00Z");
const usageSamples: Record<string, unknown> = {
	codex: [{ provider: "codex", source: "oauth", usage: { primary: null, secondary: { usedPercent: 25, resetsAt: "2026-10-13T05:20:02Z", windowMinutes: 10080 }, tertiary: null, updatedAt: "2026-10-07T03:01:50Z", identity: { providerID: "codex" } } }],
	claude: [{ provider: "claude", source: "claude", usage: { primary: { usedPercent: 19, resetsAt: "2026-10-07T04:20:00Z", windowMinutes: 300 }, secondary: { usedPercent: 6, resetsAt: "2026-10-12T19:00:00Z", windowMinutes: 10080 }, tertiary: null, updatedAt: "2026-10-07T03:02:07Z", extraRateWindows: [] } }],
	kimi: [{ provider: "kimi", source: "Kimi Code API key", usage: { secondary: { usedPercent: 0, resetsAt: "2026-10-07T06:13:06Z", windowMinutes: 300 }, primary: { usedPercent: 7.000000000000001, resetsAt: "2026-10-13T15:13:06Z", windowMinutes: 10080 }, tertiary: null, updatedAt: "2026-10-07T03:03:20Z" } }],
};
const usageError = (provider: string) => [{ error: { message: "Not logged in. Secret account person@example.invalid", kind: "provider", code: 1 }, provider, source: "auto" }];
// Installs the shared fake `codexbar` with these answers (see `fakeCodexbarScript`).
async function fakeCodexbar(f: any, files: Record<string, unknown> = usageSamples) {
	const dir = join(f.root, "codexbar"), log = join(f.root, "codexbar.log"), kills = join(f.root, "codexbar.kills");
	await mkdir(dir, { recursive: true });
	const set = (name: string, value: unknown) => writeFile(join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
	for (const [provider, value] of Object.entries(files)) await set(`${provider}.json`, value);
	await symlink(join(fakes, "codexbar"), join(f.root, "bin", "codexbar"));
	return { set, release: (name: string) => rm(join(dir, name), { force: true }), calls: async () => (await lines(log)).map((line) => line.split(" ").slice(1)), kills: () => lines(kills),
		// Every call has ended, so the extension has its result (or abandoned it).
		idle: async () => (await lines(log)).every((line) => !running(Number.parseInt(line))) };
}
// Mock only the adapter's timeouts and wall clock; real subprocesses keep running on real time.
function usageClock(t: any) {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: USG_NOW });
	return async (ms: number) => { t.mock.timers.tick(ms); for (let n = 0; n < 16; n++) await Promise.resolve(); };
}
const usgRows = (h: any) => { const lines = h.text().split("\n"), i = lines.findIndex((line: string) => line.includes("04 USG")); return i < 0 ? [] : [lines[i], lines[i + 1]]; };

test("USG: missing codexbar (ENOENT) hides the row until a later poll finds it; non-TUI installs no poller", async (t) => {
	const f = await fixtures(t), advance = usageClock(t);
	const h = await harness(f, host.SessionManager.inMemory(f.launch)); t.after(() => h.stop());
	await h.emitStart(); await h.motion("off");
	// The spawns fail at once and report ENOENT on the next tick, before any Git result: once the local inspection
	// has finished, every provider has reported "not installed".
	await untilReal(() => !/Git pending/.test(h.text()));
	assert.doesNotMatch(h.text(), /USG|GPT|CLD|KMI/, "not installed: no row, not a failure state");
	assert.match(h.text(), /05 EXT/);
	const codexbar = await fakeCodexbar(f);
	await advance(5 * 60_000);
	await untilReal(() => /KMI ■/.test(h.text()) && /CLD ■/.test(h.text()) && /GPT ■/.test(h.text()));
	// The mocked wall clock moved five minutes: 04:20 is now 1h10m away.
	const [squares, countdowns] = usgRows(h);
	assert.match(squares, /^ {3}04 USG {2}GPT ■■■■■■□□ {3}CLD ■■■■■■■□ ■■■■■■■■ {3}KMI ■■■■■■■■ ■■■■■■■■ +$/);
	const raw = h.component.render(300).find((line: string) => line.includes("GPT"));
	assert.equal(raw.slice(raw.indexOf("GPT"), raw.indexOf("CLD")).split(`${GHOST_INK}■`).length - 1, 2, "GPT's two lost squares are ghost-grey ■");
	assert.match(countdowns, /^\S? +6d2h +1h10m +5d15h +3h04m +6d12h +\S?$/);
	const lines = h.text().split("\n");
	assert.ok(lines.findIndex((line: string) => line.includes("03 MDL")) < lines.indexOf(squares) && lines.indexOf(squares) < lines.findIndex((line: string) => line.includes("05 EXT")));
	assert.deepEqual((await codexbar.calls()).sort(), ["claude", "codex", "kimi"].map((p) => ["usage", "--provider", p, "--format", "json", "--json-only"]));
	assert.doesNotMatch(h.text(), /person@|identity|oauth/);

	await h.stop();
	const print = await harness(f, host.SessionManager.inMemory(f.launch), "print"); t.after(() => print.stop());
	// A poller would spawn synchronously, at start or in a timer callback; the spy sees it before any log line.
	const spawns = t.mock.method(ChildProcess.prototype, "spawn");
	await print.emitStart(); await advance(10 * 60_000); await untilReal(f.idle);
	assert.deepEqual(spawns.mock.calls.map((call: any) => call.arguments[0].file).filter((file: string) => file !== "git"), [], "non-TUI modes never spawn codexbar");
	assert.equal((await codexbar.calls()).length, 3, "non-TUI modes never run codexbar");
	assert.deepEqual([...h.errors, ...print.errors], []);
});

test("USG: concurrent first round with pending providers, single-flight 5-minute polls, stale failures and minute repaints with motion off", async (t) => {
	// Without updatedAt, freshness is measured from receipt, so only a failure can make a provider stale here.
	const fresh = Object.fromEntries(Object.entries(usageSamples).map(([provider, [item]]: [string, any]) => [provider, [{ ...item, usage: { ...item.usage, updatedAt: undefined } }]]));
	const f = await fixtures(t), codexbar = await fakeCodexbar(f, fresh), advance = usageClock(t);
	await codexbar.set("hold-claude.0", "");
	const h = await harness(f, host.SessionManager.inMemory(f.launch)); t.after(() => h.stop());
	await h.emitStart(); await h.motion("off");
	// Kimi and Codex answer first; Claude is still pending, never shown as a failure or zero.
	await untilReal(() => /KMI ■/.test(h.text()) && /GPT ■/.test(h.text()));
	let [squares, countdowns] = usgRows(h);
	assert.match(squares, /CLD ········ ········/); assert.match(countdowns, /^\S? +6d2h +pending +3h09m +6d12h/);
	await codexbar.release("hold-claude.0");
	await untilReal(() => /CLD ■/.test(h.text()));
	assert.equal((await codexbar.calls()).length, 3, "one concurrent call per provider");

	// Countdowns are live: with motion off, a repaint arrives when a displayed minute changes.
	[, countdowns] = usgRows(h);
	assert.match(countdowns, / 1h15m /);
	let renders = h.renders;
	await advance(60_000);
	assert.ok(h.renders > renders, "minute repaint runs with motion off");
	assert.match(usgRows(h)[1], / 1h14m /);
	renders = h.renders; await advance(1_000); assert.equal(h.renders, renders, "no repaint until the next change");

	// The next round starts 5 minutes after the last completed; a held call blocks a second round (single flight).
	await codexbar.set("hold-claude.1", "");
	await advance(4 * 60_000);
	await untilReal(async () => (await codexbar.calls()).length === 6);
	// Stay under the 60 s deadline (it runs on the mocked clock); past it the call would time out. A round would
	// spawn synchronously in the timer callback, so the spy sees it before any log line.
	const spawns = t.mock.method(ChildProcess.prototype, "spawn");
	await advance(50_000);
	assert.equal(spawns.mock.callCount(), 0, "no new round while a call is in flight"); spawns.mock.restore();
	assert.equal((await codexbar.calls()).length, 6, "no new round while a call is in flight");
	// Releasing Claude completes the round, which arms the next one.
	await codexbar.release("hold-claude.1"); await untilReal(codexbar.idle);
	// Claude's next call fails: the last good windows stay, dimmed with their age, never the raw error.
	await codexbar.set("claude.2.json", usageError("claude"));
	await advance(5 * 60_000);
	await untilReal(async () => (await codexbar.calls()).length === 9 && await codexbar.idle());
	[squares, countdowns] = usgRows(h);
	assert.match(squares, /CLD ■■■■■■■□ ■■■■■■■■/);
	const under = (tag: string) => countdowns[squares.indexOf(tag)];
	assert.match(under("CLD"), /\d/, "the failed provider shows its age under its tag");
	assert.deepEqual([under("GPT"), under("KMI")], [" ", " "], "fresh providers are not marked stale");
	assert.doesNotMatch(h.text(), /Not logged in|person@|Secret|unavailable/);
	assert.deepEqual(await codexbar.kills(), []);
	assert.deepEqual(h.errors, []);
});

test("USG: a row that appears after startup draws in over the next decoration wakes, and a slow provider fills in without moving its column", async (t) => {
	const f = await fixtures(t), codexbar = await fakeCodexbar(f), advance = usageClock(t);
	// Decoration time is mocked too, so each render is an exact frame; subprocesses still run on real time.
	let mono = Math.ceil(performance.now());
	t.mock.method(performance, "now", () => mono);
	// Codex answers first and shows the row. Kimi is released during the boot and Claude after it, so neither
	// depends on real-time ordering.
	await codexbar.set("hold-kimi.0", "");
	await codexbar.set("hold-claude.0", "");
	const h = await harness(f, host.SessionManager.inMemory(f.launch)); t.after(() => h.stop());
	await h.emitStart();
	assert.doesNotMatch(h.text(), /USG/, "not yet detected: no row");
	mono += 2_000; h.text(); // the footer's own boot is over before the row exists
	// The USG squares and text rows sit right after the model row (found by its text: plate lettering can be
	// re-struck); before the row exists that is EXT.
	const usg = (width = 300) => {
		const lines: string[] = h.component.render(width), shown = lines.map((line) => stripTerminalSequences(line));
		const i = shown.findIndex((line, j) => j > shown.findIndex((row) => row.includes(" · thinking ")) && !line.includes("PNYTL"));
		return [lines[i], lines[i + 1]];
	};
	// The edge pulse's small square is the one size-only glyph change; it is still a lit square. Frame glyphs are
	// ambient ghost targets, not USG content. `plain` compares raw glyphs across frames; `shown` reads lost squares as `□`.
	const plain = (rows: string[]) => rows.map((line) => stripTerminalSequences(line).replaceAll("▪", "■").replace(/[┃┏┓┗┛━]/g, " "));
	const shown = (rows: string[]) => rows.map((line) => shownText(line).replaceAll("▪", "■").replace(/[┃┏┓┗┛━]/g, " "));
	const LOCKED = "\x1b[38;2;0;0;0m\x1b[48;2;192;254;4m\x1b[1m", GREY = "\x1b[38;2;113;113;113m\x1b[48;2;0;0;0m■";
	await untilReal(() => usg()[0].includes(`${LOCKED} 04`));
	// The first render with the row is tick 0 of its boot: only the plate's first three cells, latched.
	const first = usg();
	assert.deepEqual(plain(first).map((line) => line.trimEnd()), ["   04", ""], "the plate's first cells latch first");
	// The single decoration timeout carries the boot: a wake per 50 ms tick until it ends at tick 27.
	const frames = [first];
	for (let k = 1; k <= 27; k++) {
		const renders = h.renders;
		mono += 50; await advance(50);
		assert.ok(h.renders > renders, `tick ${k}: decoration wake`);
		frames.push(usg());
		if (k === 3) {
			// Kimi answers while the front is still far from its column (x 48 from the plate). Below 40 columns its
			// line starts at x = 0, so its squares are already drawn there.
			await codexbar.release("hold-kimi.0");
			await untilReal(() => /KMI ■/.test(stripTerminalSequences(h.component.render(30).join("\n"))));
		}
	}
	const settled = frames[27], [squares, below] = plain(settled);
	assert.match(shown(settled)[0], /^ {3}04 USG {2}GPT ■■■■■■□□ {3}CLD ········ ········ {3}KMI ■■■■■■■■ ■■■■■■■■ +$/);
	assert.match(squares, /^ {3}04 USG {2}GPT ■{8} {3}CLD ········ ········ {3}KMI ■{8} ■{8} +$/);
	assert.match(below, /^ +6d2h +pending +3h09m +6d12h +$/);
	assert.ok(!settled.join("").includes(LOCKED), "settled when the boot ends");
	// Each frame draws the settled characters up to its front and nothing past it; the text row trails one tick.
	frames.slice(0, 27).forEach((frame, k) => {
		const [top, bottom] = plain(frame), front = (k + 1) * 3;
		assert.equal(top, squares.slice(0, 2 + front).padEnd(squares.length), `tick ${k}: squares row`);
		assert.equal(bottom, below.slice(0, 2 + k * 3).padEnd(below.length), `tick ${k}: text row`);
		if (front <= 69) assert.ok(frame[0].includes(LOCKED + squares.slice(2 + front - 3, 2 + front)), `tick ${k}: the front latches`);
		if (k >= 4 && k * 3 <= 66) assert.ok(frame[1].includes(LOCKED + below.slice(2 + k * 3 - 3, 2 + k * 3)), `tick ${k}: the text front latches`);
	});
	// Kimi arrived during the boot: drawn current when the front reached it, with no fill-in afterwards.
	for (let k = 1; k <= 4; k++) { mono += 50; await advance(50); }
	mono += 30;
	assert.ok(!usg()[0].includes(GREY), "no fill-in queued for data that arrived during the boot");
	assert.deepEqual(plain(usg()), plain(settled));
	// Claude answers after the boot: its data fills in cell by cell, in place of the pending cells.
	const pendingAt = squares.indexOf("CLD"), slotAt = squares.indexOf("·", pendingAt);
	await codexbar.release("hold-claude.0");
	await untilReal(() => /CLD ■/.test(h.text()));
	const arrival = usg(), fills = [arrival];
	for (let k = 1; k <= 8; k++) {
		const renders = h.renders;
		mono += 50; await advance(50);
		assert.ok(h.renders > renders, `fill tick ${k}: decoration wake`);
		fills.push(usg());
	}
	const row = plain(arrival)[0];
	// Only Claude's settled inks: GPT's edge may be mid-pulse, and its dim tint is the ghost grey.
	assert.match(shown(fills.at(-1)!)[0], /CLD ■■■■■■■□ ■■■■■■■■ {3}KMI/);
	assert.match(row, /GPT ■{8} {3}CLD ■{8} ■{8} {3}KMI ■{8} ■{8}/);
	assert.deepEqual([row.indexOf("CLD"), row.indexOf("■", row.indexOf("CLD"))], [pendingAt, slotAt], "the column and its first square stay put");
	assert.match(plain(arrival)[1], /1h15m {4}5d15h/);
	// GPT's lit squares are white too, so these look only at Claude's column.
	const claude = (line: string) => line.slice(line.indexOf("CLD"), line.indexOf("KMI"));
	assert.equal(claude(arrival[0]).split("\x1b[38;2;255;255;255m\x1b[48;2;0;0;0m■").length - 1, 2, "the first square of each window is white on its tick");
	assert.ok(claude(arrival[0]).includes(GREY), "later squares wait in grey");
	for (const frame of fills) assert.deepEqual(plain(frame), plain(arrival), "values are current from the first fill frame");
	assert.notDeepEqual(fills[0], fills.at(-1), "the fill-in restyles");
	assert.ok(!claude(fills.at(-1)![0]).includes(GREY), "settled after 400 ms");
	assert.deepEqual(h.errors, []);
});

test("USG: shutdown and footer/tree replacement abort in-flight calls, clear timers and never accept stale results", async (t) => {
	const f = await fixtures(t), codexbar = await fakeCodexbar(f), advance = usageClock(t);
	// First-round calls are held and report nearly exhausted windows; later calls are the real samples.
	for (const provider of ["codex", "claude", "kimi"]) await codexbar.set(`hold-${provider}.0`, "");
	await codexbar.set("claude.0.json", [{ provider: "claude", usage: { primary: { usedPercent: 99, resetsAt: "2026-10-07T04:20:00Z", windowMinutes: 300 } } }]);
	const manager = host.SessionManager.inMemory(f.launch), h = await harness(f, manager); t.after(() => h.stop());
	await h.emitStart(); await h.motion("off");
	// A logged call has its SIGTERM trap armed.
	await untilReal(async () => (await codexbar.calls()).length === 3);
	// Same-session tree restore replaces the footer: the old round is aborted and its results are discarded.
	await h.runner.emit({ type: "session_tree", newLeafId: null, oldLeafId: null });
	await untilReal(async () => (await codexbar.kills()).length === 3);
	await untilReal(() => /CLD ■■■■■■■□ ■■■■■■■■/.test(h.text()));
	// Held calls answer only once released; each was killed first, so no first-round output exists to arrive later.
	assert.doesNotMatch(h.text(), /CLD ■□□□□□□□/, "aborted first-round data never renders");
	assert.equal((await codexbar.calls()).length, 6);
	// Footer replacement keeps the session's cached data and starts a fresh round.
	h.replaceFooter();
	assert.match(h.text(), /CLD ■■■■■■■□ ■■■■■■■■/);
	// The fresh round completes, which arms the next poll.
	await untilReal(async () => (await codexbar.calls()).length === 9 && await codexbar.idle());
	// Shutdown aborts in-flight (held) work and clears the poll and minute timers.
	for (const provider of ["codex", "claude", "kimi"]) await codexbar.set(`hold-${provider}.3`, "");
	await advance(5 * 60_000);
	await untilReal(async () => (await codexbar.calls()).length === 12);
	const renders = h.renders;
	await h.stop();
	await untilReal(async () => (await codexbar.kills()).length === 6);
	// A poll would spawn synchronously in its timer callback, so the spy sees it before any log line.
	const spawns = t.mock.method(ChildProcess.prototype, "spawn");
	await advance(30 * 60_000);
	assert.equal(spawns.mock.callCount(), 0, "no poll after shutdown");
	assert.equal((await codexbar.calls()).length, 12, "no poll after shutdown");
	assert.equal(h.renders, renders, "no repaint after shutdown");
	assert.deepEqual(h.errors, []);
});

// Tiny fake of the documented Tatsu public event API: no live CLI/config/formatter.
async function tatsuProducer(f: any) {
	const path = join(f.root, "tatsu-producer.ts");
	await writeFile(path, `export default function(pi) {
		let snapshot = { version: 1, phase: "inactive", components: ["tatsu-cli", "agent-workspace"].map(component => ({ component, state: "inactive" })) }, ctx, requests = 0;
		let live = true;
		const api = { version: 1, getSnapshot() { return live ? snapshot : { ...snapshot, phase: "inactive" }; }, registerFormatter() { throw new Error("consumer must not register a formatter"); } };
		pi.events.on("tatsu-status:request", r => { requests++; if (live && r.version === 1) r.reply(api); });
		pi.events.on("test:tatsu", r => {
			if (r.kind === "count") { r.reply(requests); return; }
			if (r.kind === "restart") { live = true; pi.events.emit("tatsu-status:ready", api); return; }
			if (r.kind === "stop") { live = false; return; }
			if (r.kind === "ready") { pi.events.emit("tatsu-status:ready", api); return; }
			snapshot = r.snapshot;
			ctx?.ui.setStatus("tatsu-status", r.text);
			pi.events.emit("tatsu-status:changed", snapshot);
		});
		pi.events.emit("tatsu-status:ready", api);
		pi.on("session_start", (_, next) => {
			ctx = next;
			snapshot = { version: 1, phase: "completed", components: ["tatsu-cli", "agent-workspace"].map(component => ({ component, state: "current", text: "private prose", detail: "private detail", reason: "private reason", installedSha: "private sha" })) };
			ctx.ui.setStatus("tatsu-status", "tatsu-cli: current | agent-workspace: current");
			pi.events.emit("tatsu-status:changed", snapshot);
		});
	}`);
	return path;
}
const tatsuDTO = (state = "current", options = {}, phase = "completed") => ({ version: 1, phase, components: ["tatsu-cli", "agent-workspace"].map((component) => ({ component, state, ...options })) });
function pushTatsu(h: any, snapshot: any, ...text: [string | undefined] | []) { h.events.emit("test:tatsu", { snapshot, text: text.length ? text[0] : "raw Tatsu fallback" }); }
const tatsuRequests = (h: any) => { let n = -1; h.events.emit("test:tatsu", { kind: "count", reply: (value: number) => { n = value; } }); return n; };

test("Tatsu public events: real loader in both orders, replacement/fallback, hidden text, repaint and restart discovery", async (t) => {
	const f = await fixtures(t), path = await tatsuProducer(f);
	for (const order of ["before", "after"] as const) {
		const h = await harness(f, host.SessionManager.inMemory(f.launch), "tui", { [order]: [path], emptyStatuses: true });
		t.after(() => h.stop()); await h.emitStart(); await h.motion("off");
		assert.equal(h.subscriptions.get("tatsu-status:changed"), 1); assert.equal(h.subscriptions.get("tatsu-status:ready"), 1);
		assert.match(h.text(), /05 EXT\s+TCLI  • OK    AWKS  • OK /);
		h.setStatus("a-status", "first"); h.setStatus("z-status", "last");
		assert.match(h.text(), /05 EXT\s+first[\s\S]*TCLI  • OK    AWKS  • OK [\s\S]*last/, "sorted among other statuses");
		h.setStatus("a-status", undefined); h.setStatus("z-status", undefined);
		assert.doesNotMatch(h.text(), /tatsu-cli:|private prose|private detail|private reason|private sha/);
		assert.ok(h.statuses.has("tatsu-status"), "host raw status map is untouched");
		const renders = h.renders;
		pushTatsu(h, tatsuDTO("behind", { commitsBehind: 1, localChanges: true }));
		assert.ok(h.renders > renders); assert.match(h.text(), /TCLI  ▲ UP×1 ◆ EDIT /); assert.doesNotMatch(h.text(), /raw Tatsu fallback/);
		pushTatsu(h, tatsuDTO("checking", {}, "checking"), undefined);
		assert.match(h.text(), /TCLI  ▲ UP×1 ◆ EDIT /, "a refresh keeps the last completed result"); assert.doesNotMatch(h.text(), /· CHK/);
		assert.equal(h.statuses.has("tatsu-status"), false, "hidden default text still has structured display");
		pushTatsu(h, tatsuDTO("current"), undefined); assert.match(h.text(), /TCLI  • OK    AWKS  • OK /, "only a changed result changes the text");
		pushTatsu(h, tatsuDTO("inactive", {}, "inactive")); assert.match(h.text(), /raw Tatsu fallback/); assert.doesNotMatch(h.text(), /TCLI/);
		pushTatsu(h, tatsuDTO("inactive", {}, "inactive"), undefined); assert.doesNotMatch(h.text(), /05 EXT|TCLI/);
		pushTatsu(h, tatsuDTO("checking", {}, "checking"), undefined);
		assert.match(h.text(), /TCLI  · CHK    AWKS  · CHK /, "checking shows only when no completed result is held");
		pushTatsu(h, tatsuDTO("repair", { localChanges: true }));
		const requests = tatsuRequests(h); h.events.emit("test:tatsu", { kind: "restart" }); assert.equal(tatsuRequests(h), requests + 1);
		assert.match(h.text(), /TCLI  ▲ FIX ◆ EDIT /);
		h.events.emit("test:tatsu", { kind: "stop" }); h.events.emit("test:tatsu", { kind: "ready" });
		assert.match(h.text(), /raw Tatsu fallback/); assert.doesNotMatch(h.text(), /TCLI/);
		await h.stop(); assert.deepEqual(h.errors, []);
	}
});

test("Tatsu public events: strict snapshot whitelist, unknown/invalid fallback, optional field dropping and absent provider", async (t) => {
	const f = await fixtures(t), path = await tatsuProducer(f), h = await harness(f, host.SessionManager.inMemory(f.launch), "tui", { before: [path], emptyStatuses: true });
	t.after(() => h.stop()); await h.emitStart(); await h.motion("off");
	const good = tatsuDTO();
	for (const invalid of [undefined, null, [], {}, { ...good, version: 2 }, { ...good, phase: "future" }, { ...good, components: [] },
		{ ...good, components: [...good.components, good.components[0]] }, { ...good, components: [good.components[0], good.components[0]] },
		tatsuDTO("future-state"), { ...good, components: [good.components[0], { component: "future-component", state: "current" }] },
		{ ...good, components: [good.components[0], null] }]) {
		pushTatsu(h, invalid); assert.match(h.text(), /raw Tatsu fallback/); assert.doesNotMatch(h.text(), /TCLI/);
	}
	for (const commitsBehind of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
		pushTatsu(h, tatsuDTO("behind", { commitsBehind, localChanges: "true", text: "private prose", detail: "secret" }));
		assert.match(h.text(), /TCLI  ▲ UP    AWKS  ▲ UP /); assert.doesNotMatch(h.text(), /UP×|EDIT|private prose|secret|raw Tatsu fallback/);
	}
	pushTatsu(h, tatsuDTO("behind", { commitsBehind: 0, localChanges: false })); assert.match(h.text(), /UP×0 /);
	pushTatsu(h, { ...good, components: [...good.components].reverse() }); assert.match(h.text(), /TCLI  • OK    AWKS  • OK /, "known components normalized into contract order");
	await h.stop(); assert.equal(h.subscriptions.get("tatsu-status:changed"), 0); assert.equal(h.subscriptions.get("tatsu-status:ready"), 0);
	const absent = await harness(f, host.SessionManager.inMemory(f.launch), "tui", { emptyStatuses: true }); t.after(() => absent.stop());
	await absent.emitStart(); await absent.motion("off"); absent.setStatus("tatsu-status", "unrecognized producer status");
	assert.match(absent.text(), /unrecognized producer status/); assert.doesNotMatch(absent.text(), /TCLI/);
	assert.deepEqual(h.errors, []); assert.deepEqual(absent.errors, []);
});

test("Tatsu public events: late provider, synchronous-only replies, UI/session/component ownership, disposal and non-TUI", async (t) => {
	const f = await fixtures(t), manager = host.SessionManager.inMemory(f.launch), h = await harness(f, manager, "tui", { emptyStatuses: true });
	t.after(() => h.stop()); await h.emitStart(); await h.motion("off"); h.setStatus("tatsu-status", "late raw fallback");
	let pendingReply: any, requests = 0;
	const api = { version: 1, getSnapshot: () => tatsuDTO("behind", { commitsBehind: 1 }) };
	const off = h.events.on("tatsu-status:request", (r: any) => { requests++; pendingReply = r.reply; });
	h.events.emit("tatsu-status:ready", api); pendingReply(api);
	assert.match(h.text(), /late raw fallback/); assert.doesNotMatch(h.text(), /TCLI/, "delayed discovery reply is inert");
	off(); const answer = h.events.on("tatsu-status:request", (r: any) => { requests++; r.reply(api); }); t.after(answer);
	h.events.emit("tatsu-status:ready", api); assert.match(h.text(), /TCLI  ▲ UP×1 /);
	const previous = h.replaceFooter(); previous.dispose();
	assert.equal(h.subscriptions.get("tatsu-status:changed"), 1); assert.deepEqual(previous.render(100), []);
	const beforeUI = h.renders; h.replaceUI(); h.events.emit("tatsu-status:changed", tatsuDTO()); h.events.emit("tatsu-status:ready", api);
	assert.equal(h.renders, beforeUI, "old UI events cannot publish"); assert.match(h.text(), /late raw fallback/);
	h.replaceFooter(); await h.motion("off"); assert.match(h.text(), /TCLI  ▲ UP×1 /);
	manager.newSession(); const beforeSession = h.renders, priorRequests = requests;
	h.events.emit("tatsu-status:changed", tatsuDTO()); h.events.emit("tatsu-status:ready", api);
	assert.equal(h.renders, beforeSession); assert.equal(requests, priorRequests); assert.match(h.text(), /late raw fallback/);
	await h.emitStart("new"); await h.motion("off"); assert.match(h.text(), /TCLI  ▲ UP×1 /);
	h.component.dispose(); const disposedRenders = h.renders, disposedRequests = requests;
	assert.equal(h.subscriptions.get("tatsu-status:changed"), 0); assert.equal(h.subscriptions.get("tatsu-status:ready"), 0);
	h.events.emit("tatsu-status:changed", tatsuDTO()); h.events.emit("tatsu-status:ready", api);
	assert.equal(h.renders, disposedRenders); assert.equal(requests, disposedRequests);
	await h.stop(); assert.deepEqual(h.errors, []);
	const print = await harness(f, host.SessionManager.inMemory(f.launch), "print"); t.after(() => print.stop());
	let queried = 0; const unlisten = print.events.on("tatsu-status:request", () => { queried++; }); t.after(unlisten);
	await print.emitStart(); print.events.emit("tatsu-status:ready", api); print.events.emit("tatsu-status:changed", tatsuDTO());
	assert.equal(queried, 0); assert.equal(print.subscriptions.get("tatsu-status:changed") ?? 0, 0); assert.equal(print.subscriptions.get("tatsu-status:ready") ?? 0, 0);
	assert.equal(print.component, undefined);
});
