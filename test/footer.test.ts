import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { FooterSnapshot } from "../src/footer.ts";

// Tests use the installed host, never a vendored width implementation or install.
const require = createRequire(process.env.PI_HOST_ROOT ? resolve(process.env.PI_HOST_ROOT, "package.json") : import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false, alias: { "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui") } });
const footer = await jiti.import(resolve("src/footer.ts"));
const { renderFooter, safeText, startMotion, observeContext, motionFrame, nextMotionDelay, SETTLED_FRAME, MOTION_TICK_MS } = footer;
const { visibleWidth, stripTerminalSequences, sliceByColumn, styleText } = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href);
// Same concrete-color conversion Pi's Theme.style uses; no semantic theme tokens are consulted.
const hostTheme = (mode = "truecolor") => ({ style: (text: string, options: object) => styleText(text, options, mode), getColorMode: () => mode });
const theme = hostTheme();
const plain = (lines: string[]) => lines.map((line) => stripTerminalSequences(line));
const rows = (f: FooterSnapshot, width = 100, frame?: unknown) => plain(renderFooter(f, width, theme, frame));
const fixture = (): FooterSnapshot => ({
	homePath: "/home/example",
	launchPath: "/launch unrelated",
	activePath: "/repo/worktree",
	workspace: {
		path: "/repo/worktree",
		git: { kind: "repository", active: { path: "/repo/worktree", branch: "feature/ui", revision: "abcdef", dirty: true }, main: { path: "/repo", branch: "release", revision: "123456", dirty: false }, isWorktree: true },
		github: { kind: "repository", name: "owner/repo", url: "https://github.com/owner/repo" },
	},
	pullRequest: { kind: "open", number: 42, url: "https://github.com/owner/repo/pull/42" },
	contextUsage: { tokens: 32_000, contextWindow: 128_000, percent: 25 },
	model: { provider: "provider", id: "model", contextWindow: 128_000 },
	thinking: "high",
	statuses: new Map([["ponytail", "Ponytail: ready"], ["another", "Other status"]]),
});
const repository = (f: FooterSnapshot) => {
	if (f.workspace?.git.kind !== "repository") throw new Error("fixture");
	return f.workspace.git;
};
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(";");
const bg = (hex: string) => `\x1b[48;2;${rgb(hex)}m`, fg = (hex: string) => `\x1b[38;2;${rgb(hex)}m`;
const metrics = (width: number) => width >= 60 ? { G: 2, P: 12 } : { G: 1, P: 8 };

test("wide Acid / Black snapshot: GitHub frame, numbered plates, gauge, numeral, model band and every status", () => {
	assert.deepEqual(rows(fixture()), [
		"┏━ GITHUB owner/repo · PR #42 https://github.com/owner/repo/pull/42 ────┬───────┬───────┬───────┬─━┓",
		"┃  01 LAUNCH   /launch unrelated                                                                   ┃",
		"   02 ACTIVE   /repo/worktree  feature/ui   modified                                                ",
		"   02.1 MAIN   /repo  release   clean                                     ▐ ▀▀█ █▀▀   █▀█ %         ",
		"   03 CTX USED ████████             ┃     ┃     25.0%/128k                ▐ █▀▀ ▀▀█   █ █ USED      ",
		"               0  ╵  ╵  ╵  ╵  50 ╵  70 ╵  90 100                          ▐ ▀▀▀ ▀▀▀ ▀ ▀▀▀ of 128k   ",
		"   04 MODEL    provider/model · thinking high                                                       ",
		"┃  05 EXT      Other status                                                                        ┃",
		"┗━             Ponytail: ready                                                                    ━┛",
	]);
	const ansi = renderFooter(fixture(), 100, theme);
	// Exact palette 01: field, primary, text, secondary, plates, surface/band/track, warning, high, graphic grey, zone tints.
	for (const line of ansi) assert.ok(line.includes(bg("#000000")), "every row sits on the black field");
	assert.ok(ansi[2].includes(`${fg("#000000")}${bg("#c0fe04")}\x1b[1m 02 ACTIVE  `));
	assert.ok(ansi[1].includes(`${fg("#ffffff")}${bg("#555555")}\x1b[1m 01 LAUNCH  `));
	assert.ok(ansi[1].includes(`${fg("#cfcfcf")}${bg("#000000")}/launch unrelated`));
	assert.ok(ansi[6].includes(`${fg("#000000")}${bg("#ffffff")}\x1b[1m 04 MODEL   `) && ansi[6].includes(bg("#1c1c1c")));
	assert.ok(ansi[4].includes(`${fg("#c0fe04")}${bg("#c0fe04")}████████`));
	assert.ok(ansi[4].includes(bg("#2b2010")) && ansi[4].includes(bg("#300e07")), "20% warning/high zone tints");
	assert.ok(ansi[4].includes(`${fg("#d79e52")}${bg("#2b2010")}\x1b[1m┃`) && ansi[4].includes(`${fg("#f24723")}${bg("#300e07")}\x1b[1m┃`));
	assert.ok(ansi[0].startsWith(`${fg("#717171")}${bg("#000000")}┏━`));
	assert.ok(ansi[2].includes(`${fg("#000000")}${bg("#d79e52")}\x1b[1m modified `));
	// Pi's public color conversion downsamples for 256-color terminals.
	const indexed = renderFooter(fixture(), 100, hostTheme("256color")).join("\n");
	assert.doesNotMatch(indexed, /\x1b\[(38|48);2;/); assert.match(indexed, /\x1b\[48;5;\d+m/);
});

test("responsive compact, narrow and minimal layouts keep every field", () => {
	const f = fixture();
	assert.deepEqual(rows(f, 72), [
		"┏━ GITHUB owner/repo · PR #42 https://github.com/owner/repo/pull/42 ──━┓",
		"┃  01 LAUNCH   /launch unrelated                                       ┃",
		"   02 ACTIVE   /repo/worktree  feature/ui   modified                    ",
		"   02.1 MAIN   /repo  release   clean                                   ",
		"   03 CTX USED 0▕██████          ┃   ┃  ▏100  25.0%/128k                ",
		"   04 MODEL    provider/model · thinking high                           ",
		"┃  05 EXT      Other status                                            ┃",
		"┗━             Ponytail: ready                                        ━┛",
	]);
	assert.deepEqual(rows(f, 48), [
		"┏ GITHUB owner/repo · PR #42 ───┬───────┬──────┓",
		"┃        https://github.com/owner/repo/pull/4  ┃",
		"         2                                      ",
		"  LAUNCH  /launch unrelated                     ",
		"  ACTIVE  /repo/worktree  feature/ui   modified ",
		"  MAIN    /repo  release   clean                ",
		"  CTX     0▕████████             ┃     ┃   ▏100 ",
		"           25.0%/128k                           ",
		"  MODEL   provider/model · thinking high        ",
		"┃ EXT     Other status                         ┃",
		"┗         Ponytail: ready                      ┛",
	]);
	// Below the framed minimum, plates become inline labels and values wrap beneath them.
	assert.deepEqual(rows(f, 30), [
		" GITHUB  owner/repo · PR #42  ",
		"https://github.com/owner/repo/",
		"pull/42                       ",
		" LAUNCH  /launch unrelated    ",
		" ACTIVE  /repo/worktree       ",
		"feature/ui   modified         ",
		" MAIN  /repo  release   clean ",
		" CTX   25.0%/128k             ",
		" MODEL  provider/model ·      ",
		"thinking high                 ",
		" EXT  Other status            ",
		"Ponytail: ready               ",
	]);
});

test("paths display immediate parent/current only; stored paths, home and edge cases stay truthful", () => {
	const f = fixture();
	f.launchPath = "/Users/example/Documents/Projects/pi-status-bar";
	f.activePath = `${f.homePath}/worktrees/feature`;
	f.workspace!.path = f.activePath;
	repository(f).active.path = f.activePath;
	repository(f).main!.path = `${f.homePath}/Projects/repo`;
	f.pullRequest = { kind: "none" };
	const before = structuredClone(f);
	const out = rows(f, 160);
	assert.match(out[1], /01 LAUNCH {3}Projects\/pi-status-bar {2}/);
	assert.match(out[2], /02 ACTIVE {3}worktrees\/feature {2}feature\/ui/);
	assert.match(out[3], /02\.1 MAIN {3}Projects\/repo {2}release/);
	assert.match(out[0], /GITHUB owner\/repo ─/);
	assert.deepEqual(f, before, "display shortening must not change stored paths or URLs");
	const launch = (path: string, home = f.homePath) => { f.launchPath = path; f.homePath = home; return rows(f, 160)[1].slice(15).trim().split(/ {2,}/)[0]; };
	assert.equal(launch(f.homePath), "~");
	assert.equal(launch(`${f.homePath}/project`), "~/project");
	assert.equal(launch("/home/example-other/repo"), "example-other/repo");
	assert.equal(launch("/home/example/..dots"), "~/..dots");
	assert.equal(launch("/"), "/");
	assert.equal(launch("/repo"), "/repo");
	assert.equal(launch("/repo/worktree"), "/repo/worktree", "nothing is elided from a two-component path");
	assert.equal(launch("/a/b/c/"), "b/c");
	assert.equal(launch("relative/dir/name"), "relative/dir/name");
	assert.equal(launch("/project", "/"), "~/project");
	assert.equal(launch("/x/y/z", ""), "y/z", "an empty home never abbreviates against cwd");
});

test("truthful none, pending, unknown, unborn/detached, missing main and PR states", () => {
	let f = fixture();
	f.workspace = { path: f.activePath, git: { kind: "none" }, github: { kind: "none", reason: "not a repository" } };
	let out = rows(f, 120);
	assert.match(out[0], /^┏━─/, "absent GitHub leaves an untitled frame, not a GitHub status");
	assert.match(out[2], /02 ACTIVE {3}\/repo\/worktree {20}/);
	assert.doesNotMatch(out.join("\n"), /GITHUB|Git |MAIN|PR #|clean|modified/);
	f = fixture();
	f.workspace!.github = { kind: "none", reason: "No GitHub remote" };
	out = rows(f, 120);
	assert.doesNotMatch(out.join("\n"), /GITHUB|PR/);
	assert.match(out.join("\n"), /\/repo {2}release {3}clean/);
	f.workspace = undefined;
	out = rows(f, 120);
	assert.match(out[0], /GITHUB pending/); assert.match(out[2], /\/repo\/worktree Git pending/);
	f.workspace = { path: f.activePath, git: { kind: "unknown", reason: "timeout" }, github: { kind: "unknown", reason: "ambiguous" } };
	out = rows(f, 120);
	assert.match(out.join("\n"), /Git unavailable \(timeout\)/); assert.match(out[0], /GITHUB unavailable \(ambiguous\)/); assert.doesNotMatch(out.join("\n"), /clean|No open PR/);
	f = fixture();
	repository(f).active = { path: f.activePath, branch: null, revision: null, dirty: null, error: "timeout" };
	repository(f).main = null; repository(f).mainUnavailableReason = "pruned";
	for (const [pr, expected] of [
		[{ kind: "none" }, "GITHUB owner/repo ─"], [{ kind: "unavailable", reason: "auth missing" }, "GITHUB owner/repo · PR unavailable (auth missing) ─"], [{ kind: "not-applicable" }, "GITHUB owner/repo ─"],
	] as const) {
		f.pullRequest = pr;
		out = rows(f, 120);
		assert.ok(out[0].includes(expected), out[0]); assert.doesNotMatch(out.join("\n"), /No open PR|PR not applicable|PR #/);
		assert.match(out.join("\n"), /detached {3}status unavailable  \(timeout\)/); assert.match(out.join("\n"), /02\.1 MAIN {3}unavailable \(pruned\)/);
	}
	repository(f).active.revision = "abc123";
	assert.match(rows(f, 120).join("\n"), /detached @abc123/);
	repository(f).active.branch = "main"; repository(f).active.revision = null;
	repository(f).main = repository(f).active; delete repository(f).mainUnavailableReason;
	assert.doesNotMatch(rows(f, 120).join("\n"), /MAIN/);
});

const gauge = (out: string[]) => { const row = out.find((line) => line.includes("CTX"))!; return row.slice(row.indexOf("▕") + 1, row.indexOf("▏")); };
test("context: true zero, real fill, >70 warning, >90 high, unknown, nonfinite, overflow and missing window", () => {
	const at = (percent: number | null, width = 72) => { const f = fixture(); f.contextUsage = { tokens: null, contextWindow: 128_000, percent }; return rows(f, width); };
	const cells = gauge(at(0)).length;
	assert.equal(gauge(at(0)).replace(/[^█]/g, "").length, 0, "true zero is an empty gauge");
	assert.match(at(0).join("\n"), / 0\.0%\/128k /); assert.doesNotMatch(at(0).join("\n"), /WARN|HIGH|UNKNOWN/);
	assert.equal(gauge(at(0.1)).replace(/[^█]/g, "").length, 1, "any usage lights a cell");
	assert.equal(gauge(at(100)).replace(/[^█]/g, "").length, cells);
	for (const percent of [25, 58, 93.3]) assert.equal(gauge(at(percent)).replace(/[^█]/g, "").length, Math.ceil((percent * cells) / 100));
	assert.doesNotMatch(at(70).join("\n"), /WARN/); assert.match(at(70.1).join("\n"), /70\.1%\/128k {3}▲ WARN/);
	assert.match(at(90).join("\n"), /▲ WARN/); assert.match(at(90.1).join("\n"), /90\.1%\/128k {3}▲ HIGH/);
	for (const percent of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
		const out = at(percent as number | null);
		assert.match(out.join("\n"), / \?\/128k {3}\? UNKNOWN/); assert.equal(gauge(out), "╱".repeat(cells), "unknown is hatched, never empty or zero");
		assert.doesNotMatch(out.join("\n"), /0\.0%/);
	}
	assert.match(at(null, 100).join("\n"), /▐ ▀▀█ +\n.*▐  ▀▀ +UNKNOWN/s);
	assert.match(at(150).join("\n"), /150\.0%\/128k {3}▲ HIGH/); assert.equal(gauge(at(150)), "█".repeat(cells), "graphical extent clamps; readout does not");
	assert.match(at(150, 100).join("\n"), /▐ ▄█  █▀▀ █▀█   █▀█ %/, "wide numeral shows the truthful value");
	const huge = at(1e21, 100).join("\n");
	assert.match(huge, /1e\+21%\/128k/); assert.doesNotMatch(huge, /▐/, "no misleading numeral for values without glyphs");
	assert.match(at(-1).join("\n"), /-1\.0%\/128k/); assert.equal(gauge(at(-1)).replace(/[^█]/g, ""), "");
	const f = fixture(); f.contextUsage = undefined; f.model = undefined;
	assert.match(rows(f, 72).join("\n"), / \? {3}\? UNKNOWN/); assert.match(rows(f, 72).join("\n"), /no-model · thinking high/);
	f.contextUsage = { tokens: 1, contextWindow: 0, percent: 1 }; f.model = { provider: "p", id: "m", contextWindow: Number.NaN };
	const noWindow = rows(f, 100).join("\n");
	assert.match(noWindow, / 1\.0% +▐/); assert.doesNotMatch(noWindow, /1\.0%\/|of /);
});

const hostile = () => {
	const f = fixture();
	f.activePath = "/项目/e\u0301/👩‍💻/" + "long".repeat(30);
	f.launchPath = "/très/長い/" + "path-segment-".repeat(12);
	repository(f).active.branch = "feature/" + "branch-name-".repeat(12) + "👩🏽‍🚀";
	f.pullRequest = { kind: "open", number: 123456, url: "https://github.com/owner/repo/pull/123456?" + "q=".repeat(30) };
	f.model = { provider: "provider-" + "x".repeat(40), id: "model-id-" + "y".repeat(50), contextWindow: 2_000_000 };
	f.statuses = new Map([["color", "\x1b[38;2;255;10;20m彩色 status " + "verylong".repeat(10) + "\x1b[0m tail"], ["emoji", "○ 🐴 ponytail: ⚡ FULL"]]);
	return f;
};
const content = (lines: string[]) => plain(lines).map((line) => line.split("▐")[0]).join("").replace(/[\s┃┗┛━┏┓─┬┼]/g, "");
test("every line fits widths 1..160 for each state and motion frame, and no field is dropped", () => {
	const frames = [SETTLED_FRAME, motionFrame(startMotion(0), 3 * MOTION_TICK_MS), { ...SETTLED_FRAME, wipe: { from: "ok", cells: 5 }, tagFlash: true, flash70: true, flash90: true, cal: -1, comb: 3 }];
	for (const percent of [0, 75, 95.5, null]) {
		const f = hostile(); f.contextUsage = { tokens: null, contextWindow: 2_000_000, percent };
		for (let width = 1; width <= 160; width++) {
			for (const frame of frames) {
				const lines = renderFooter(f, width, theme, frame);
				for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)}`);
				if (width >= 40) for (const line of lines) assert.equal(visibleWidth(line), width, "framed rows fill the field exactly");
			}
			if (width < 3) continue;
			const text = content(renderFooter(f, width, theme));
			for (const value of ["👩‍💻/" + "long".repeat(30), "長い/" + "path-segment-".repeat(12), "branch-name-".repeat(12) + "👩🏽‍🚀", "PR#123456", "q=".repeat(30), "y".repeat(50), "verylong".repeat(10) + "tail", "○🐴ponytail:⚡FULL"]) {
				assert.ok(text.includes(value.replace(/\s/g, "")), `width ${width} dropped ${value}`);
			}
		}
	}
	assert.deepEqual(renderFooter(fixture(), 0, theme), []); assert.deepEqual(renderFooter(fixture(), Number.NaN, theme), []);
});

test("continuation rows never carry colored tabs below label plates", () => {
	for (const percent of [0, 75, 95.5, null]) {
		const f = hostile(); f.contextUsage = { tokens: null, contextWindow: 2_000_000, percent };
		for (let width = 40; width <= 160; width++) {
			const { G, P } = metrics(width);
			const lines = renderFooter(f, width, theme);
			let continuations = 0;
			lines.forEach((line, i) => {
				const plate = sliceByColumn(line, G, P);
				if (i === 0 || stripTerminalSequences(plate).trim()) return;
				continuations++;
				const backgrounds = plate.match(/\x1b\[48;[0-9;]+m/g) ?? [];
				assert.ok(backgrounds.every((code) => code === bg("#000000")), `width ${width} row ${i}: ${JSON.stringify(plate)}`);
			});
			assert.ok(continuations > 0);
		}
	}
});

test("sanitizes terminal control payloads, preserving only statuses' SGR colors without bleed", () => {
	const hostileText = "before\x1b[2J\x1b]8;;https://evil\x07link\x1b]8;;\x1b\\\x1bPpayload\x1b\\\x9b2J\x00\n\r\t\u202eafter";
	assert.equal(safeText(hostileText), "beforelink    after");
	assert.equal(safeText("\x1b[31mred\x1b[0m"), "red");
	assert.equal(safeText("\x1b[31mred\x1b[0m", true), "\x1b[31mred\x1b[0m");
	assert.equal(safeText("safe\x1b]unfinished"), "safe");
	const f = fixture(); f.activePath = hostileText; repository(f).active.branch = hostileText; f.model!.id = hostileText;
	f.statuses = new Map([["a", "\x1b[31mred\x1b[0m\x1b[2J\nnext\x07"], ["b", "\x1b[38;2;1;2;3mUNCLOSED"], ["c", "plain after"]]);
	const lines = renderFooter(f, 200, theme);
	const white = fg("#ffffff"), black = bg("#000000");
	assert.ok(lines.some((line: string) => line.includes(`\x1b[31mred\x1b[0m${white}${black} next`)), "a status reset restores the footer field, not terminal default");
	assert.doesNotMatch(lines.join(""), /\x1b\[2J|\x1b\]|\x07|\x00|\u202e/);
	const unclosed = lines.findIndex((line: string) => line.includes("UNCLOSED"));
	assert.ok(lines[unclosed].indexOf("\x1b[0m", lines[unclosed].indexOf("UNCLOSED")) > 0, "status style is closed before footer padding and frame");
	assert.doesNotMatch(lines[unclosed + 1], /38;2;1;2;3/);
	assert.ok(stripTerminalSequences(lines[unclosed + 1]).includes("plain after"));
});

test("colon-form foreground/background colors survive every wrapped status line", () => {
	for (const [input, expected] of [
		["38:2::255:0:0", "38;2;255;0;0"],
		["38:2:0:255:0:0", "38;2;255;0;0"],
		["38:2:255:0:0", "38;2;255;0;0"],
		["48:2::0:0:255", "48;2;0;0;255"],
		["38:5:196", "38;5;196"],
		["48:5:21", "48;5;21"],
	]) {
		const f = fixture();
		f.statuses = new Map([["colored", `\x1b[${input}m${"ABCDEFGHIJ".repeat(10)}\x1b[0m`]]);
		const lines = renderFooter(f, 50, theme).filter((line: string) => /[A-J]{5}/.test(stripTerminalSequences(line)));
		assert.equal(lines.length, 3);
		for (const line of lines) assert.ok(line.includes(`\x1b[${expected}m`) || line.includes(`;${expected}m`) || line.includes(`\x1b[${expected};`), `${input}: ${JSON.stringify(line)}`);
		assert.equal(plain(lines).map((line) => line.slice(10).replace(/[\s┃┗┛]/g, "")).join(""), "ABCDEFGHIJ".repeat(10));
	}
	assert.equal(safeText("\x1b[1;38:2::255:0:0;48:5:21mred\x1b[0m", true), "\x1b[1;38;2;255;0;0;48;5;21mred\x1b[0m");
});

test("live values: context unknown after compaction, current model/thinking and statuses each render", () => {
	const f = fixture(); f.contextUsage = { tokens: null, percent: null, contextWindow: 128_000 };
	assert.match(rows(f, 80).join("\n"), / \?\/128k {3}\? UNKNOWN/);
	const statuses = new Map([["first", "first"]]); f.statuses = statuses;
	assert.match(rows(f, 80).join("\n"), /first/);
	statuses.set("later", "later"); f.thinking = "off"; f.model!.id = "new-model";
	const lines = rows(f, 80).join("\n");
	assert.match(lines, /later/); assert.match(lines, /new-model · thinking off/);
	assert.doesNotMatch(lines, /\$|cache|↑|↓/);
});

test("decoration motion is a pure function of time and never changes displayed data", () => {
	const f = fixture();
	const settled = rows(f, 100);
	const titleEnd = settled[0].indexOf("pull/42") + 7;
	let state = startMotion(1_000);
	for (let t = 0; t <= 200; t++) {
		const out = rows(f, 100, motionFrame(state, 1_000 + t * MOTION_TICK_MS));
		assert.deepEqual(out.slice(1), settled.slice(1), `tick ${t}`);
		assert.equal(out[0].slice(2, titleEnd), settled[0].slice(2, titleEnd), `tick ${t}`);
	}
	assert.deepEqual(motionFrame(state, 1_000 + 31 * MOTION_TICK_MS).boot, Infinity);
	const boot = renderFooter(f, 100, theme, motionFrame(state, 1_000));
	assert.ok(stripTerminalSequences(boot[0]).startsWith("   GITHUB owner/repo"), "boot draws the frame in while the title is present");
	assert.ok(!boot[2].includes(bg("#c0fe04") + "\x1b[1m 02"), "boot shows outlined plates");
	assert.ok(boot[2].includes(`${fg("#c0fe04")}${bg("#000000")}\x1b[1m 02 ACTIVE`));
	// Ambient comb and calibration only move the header.
	assert.notEqual(rows(f, 100, motionFrame(state, 1_000 + 40 * MOTION_TICK_MS))[0], rows(f, 100, motionFrame(state, 1_000 + 48 * MOTION_TICK_MS))[0]);
	assert.equal(motionFrame(state, 1_000 + 120 * MOTION_TICK_MS).cal, 1);
	assert.deepEqual(renderFooter(f, 100, theme), renderFooter(f, 100, theme, SETTLED_FRAME));

	state = observeContext(state, 60, 20_000);
	assert.equal(observeContext(state, 60, 20_001), state, "unchanged values keep the same state");
	state = observeContext(state, 75, 30_000);
	assert.equal(state.toneFrom, "ok"); assert.equal(state.toneAt, 30_000); assert.equal(state.crossedAt[70], 30_000);
	f.contextUsage = { tokens: null, contextWindow: 128_000, percent: 75 };
	const wiping = renderFooter(f, 100, theme, motionFrame(state, 30_000 + 5 * MOTION_TICK_MS));
	assert.ok(wiping[4].includes(`${fg("#000000")}${bg("#d79e52")}\x1b[1m 03 C`), "new tone wipes in");
	assert.ok(wiping[4].includes(`${fg("#000000")}${bg("#c0fe04")}\x1b[1mTX USED`), "previous tone remains behind the wipe");
	assert.match(plain(wiping)[4], /75\.0%\/128k {3}▲ WARN/, "values are current during the wipe");
	assert.equal(motionFrame(state, 30_000 + MOTION_TICK_MS).flash70, true);
	assert.equal(motionFrame(state, 30_000 + 15 * MOTION_TICK_MS).wipe, undefined);
	assert.ok(renderFooter(f, 100, theme, { ...SETTLED_FRAME, flash70: true })[4].includes(`${fg("#ffffff")}${bg("#ffffff")}`), "crossed boundary flashes");
	state = observeContext(state, null, 40_000);
	assert.equal(state.toneFrom, "warn"); assert.equal(state.crossedAt[70], 30_000, "unknown is not a crossing");
	state = observeContext(state, 95, 50_000);
	assert.equal(state.crossedAt[90], undefined, "no crossing is inferred through unknown");
});

test("motion schedule wakes only for the next visible decoration step", () => {
	const state = observeContext(observeContext(startMotion(0), 60, 0), 95, 7_003);
	for (let now = 0; now < 30_000; now += 37) {
		const delay = nextMotionDelay(state, now);
		assert.ok(delay >= 1 && delay <= 8 * MOTION_TICK_MS, `${now}: ${delay}`);
		const key = (time: number) => JSON.stringify(motionFrame(state, time));
		assert.notEqual(key(now + delay), key(now), `${now}: wakes for a change`);
		if (delay > 1) assert.equal(key(now + delay - 1), key(now), `${now}: no earlier change`);
	}
	assert.ok(nextMotionDelay(state, 10_000) >= 50, "settled ambient motion does not run at the transient tick rate");
});
