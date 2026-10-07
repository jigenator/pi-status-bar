import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { FooterFrame, FooterSnapshot, MotionState } from "../src/footer.ts";

// Tests use the installed host, never a vendored width implementation or install.
const require = createRequire(process.env.PI_HOST_ROOT ? resolve(process.env.PI_HOST_ROOT, "package.json") : import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false, alias: { "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui") } });
const footer = await jiti.import(resolve("src/footer.ts"));
const { renderFooter, safeText, startMotion, advanceMotion, motionFrame, nextMotionDelay, SETTLED_FRAME, MOTION_TICK_MS } = footer;
const { visibleWidth, stripTerminalSequences, sliceByColumn, styleText } = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href);
// Same concrete-color conversion Pi's Theme.style uses; no semantic theme tokens are consulted.
const hostTheme = (mode = "truecolor") => ({ style: (text: string, options: object) => styleText(text, options, mode), getColorMode: () => mode });
const theme = hostTheme();
const plain = (lines: string[]) => lines.map((line) => stripTerminalSequences(line));
const rows = (f: FooterSnapshot, width = 100, frame?: FooterFrame) => plain(renderFooter(f, width, theme, frame));
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
	activity: { working: true, units: 3 },
	compactions: 12,
});
// The mockup's non-worktree session: room for the title, the centre ┼ and the aligned Thread Rail on row 0.
const session = (percent: number | null = 41.8, activity: FooterSnapshot["activity"] = { working: true, units: 3 }): FooterSnapshot => ({
	homePath: "/Users/example",
	launchPath: "/Users/example/Projects/pi-status-bar",
	activePath: "/Users/example/Projects/pi-status-bar",
	workspace: {
		path: "/Users/example/Projects/pi-status-bar",
		git: { kind: "repository", active: { path: "/Users/example/Projects/pi-status-bar", branch: "main", revision: "abc", dirty: true }, isWorktree: false },
		github: { kind: "repository", name: "jigenator/pi-status-bar", url: "https://github.com/jigenator/pi-status-bar" },
	},
	pullRequest: { kind: "none" },
	// Pi reports tokens and percent together; both are null when usage is unknown.
	contextUsage: { tokens: percent === null ? null : Math.round(percent * 2_720), contextWindow: 272_000, percent },
	model: { provider: "openai-codex", id: "gpt-6-astra", contextWindow: 272_000 },
	thinking: "xhigh",
	statuses: new Map([["tatsu", "tatsu-cli: current | agent-workspace: update available (3)"]]),
	activity,
	compactions: 4,
});
// The session's inline readout: tokens in the window's whole-k unit.
const sessionReadout = (percent: number | null) => percent === null ? "?/272k" : `${(Math.round(percent * 2_720) / 1_000).toFixed(0)}k/272k`;
const repository = (f: FooterSnapshot) => {
	if (f.workspace?.git.kind !== "repository") throw new Error("fixture");
	return f.workspace.git;
};
const PALETTE: Record<string, string> = {
	"#000000": "field", "#c0fe04": "primary", "#ffffff": "text", "#cfcfcf": "secondary", "#555555": "plate", "#1c1c1c": "surface",
	"#d79e52": "warn", "#f24723": "high", "#717171": "graphic", "#2b2010": "wz", "#300e07": "hz", "#5200ff": "violet", "#ff15bd": "pink",
};
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(";");
const bg = (hex: string) => `\x1b[48;2;${rgb(hex)}m`, fg = (hex: string) => `\x1b[38;2;${rgb(hex)}m`;
type TestCell = { ch: string; fg: string; bg: string; bold: boolean; underline: boolean };
// Per-column cells of a renderer row (single-width text only); colors are palette names.
function cellsOf(line: string): TestCell[] {
	const out: TestCell[] = [];
	let f = "default", b = "default", bold = false, underline = false;
	const name = (r: string, g: string, bl: string) => PALETTE[`#${[r, g, bl].map((v) => Number(v).toString(16).padStart(2, "0")).join("")}`] ?? `rgb(${r},${g},${bl})`;
	for (const token of line.match(/\x1b\[[0-9;]*m|[^\x1b]/gu) ?? []) {
		if (!token.startsWith("\x1b")) { out.push({ ch: token, fg: f, bg: b, bold, underline }); continue; }
		const p = token.slice(2, -1).split(";");
		for (let i = 0; i < p.length; i++) {
			const code = Number(p[i] || 0);
			if (code === 0) { f = b = "default"; bold = underline = false; }
			else if (code === 1) bold = true; else if (code === 22) bold = false; else if (code === 4) underline = true; else if (code === 24) underline = false;
			else if (code === 39) f = "default"; else if (code === 49) b = "default";
			else if ((code === 38 || code === 48) && p[i + 1] === "2") { const v = name(p[i + 2], p[i + 3], p[i + 4]); if (code === 38) f = v; else b = v; i += 4; }
		}
	}
	return out;
}
const grid = (lines: string[]) => lines.map(cellsOf);
const text = (cells: TestCell[]) => cells.map((c) => c.ch).join("");
const HEX: Record<string, [number, number, number]> = Object.fromEntries(Object.entries(PALETTE).map(([hex, n]) => [n, [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]]));
const luminance = ([r, g, b]: number[]) => { const v = [r, g, b].map((x) => x / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
const contrast = (a: string, b: string) => { const [x, y] = [luminance(HEX[a]), luminance(HEX[b])].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const metrics = (width: number) => (width >= 60 ? { G: 2, P: 8 } : { G: 1, P: 8 });
// Thread Rail anchors on the header row: ROOT plate span and badge span, by background.
function rail(cells: TestCell[]) {
	// Characters are exact even mid-strike; padding may carry texture, so anchor on the lettering.
	const s = text(cells), rootAt = s.indexOf("ROOT") - 1, au = s.lastIndexOf("AU");
	let digits = au - 1;
	while (digits > 0 && /[0-9?]/.test(s[digits - 1])) digits--;
	const width = Math.max(7, au + 2 - digits + 2), badgeAt = au + 3 - width;
	return { lamp: cells[rootAt - 2], root: cells.slice(rootAt, rootAt + 6), rootAt, badge: cells.slice(badgeAt, badgeAt + width), badgeAt, marks: s.slice(rootAt + 7, rootAt + 19) };
}
// Steps the pure motion API with exact timer wakes, like the adapter will.
function simulate(f: FooterSnapshot, seed: number, until: number, visit?: (state: MotionState, now: number) => void, boot = true) {
	let state = startMotion(f, 0, seed, boot), now = 0;
	while (now <= until) {
		state = advanceMotion(state, f, now);
		visit?.(state, now);
		now += nextMotionDelay(state, now);
	}
	return state;
}
const strikeAt = (f: FooterSnapshot, seed: number) => {
	const state = startMotion(f, 0, seed, false);
	return advanceMotion(state, f, state.strikeAt);
};

test("wide v9 snapshot: numbered 8-cell plates, inline readout, scale, numeral and aligned Thread Rail", () => {
	const lines = renderFooter(session(), 120, theme);
	assert.deepEqual(plain(lines), [
		"┏━ CMP×04  ■ jigenator/pi-status-bar                        ┼                             ROOT  █·█·█·······   03 AU  ━┓",
		"┃                                                                                                                      ┃",
		"   01 ACT  ⑂ main modified                                                                    ▐ █ █ ▄█    █▀█ %         ",
		"   02 CTX   114k/272k ███████████████                ┃           ┃                            ▐ ▀▀█  █    █▀█ USED      ",
		"           0     10    20    30    40    50    60    70    80    90   100                     ▐   ▀ ▀▀▀ ▀ ▀▀▀ of 272k   ",
		"┃  03 MDL  openai-codex/gpt-6-astra · thinking xhigh                                                                   ┃",
		"┗━ 04 EXT  tatsu-cli: current | agent-workspace: update available (3)                                                 ━┛",
	]);
	const g = grid(lines);
	for (const line of lines) assert.ok(line.includes(bg("#000000")), "every row sits on the black field");
	// One blank framed row separates the header from the numbered rows.
	assert.ok(g[1].slice(2, 118).every((c) => c.ch === " " && c.bg === "field"), "blank spacer row");
	assert.equal(text(g[2].slice(2, 10)), " 01 ACT ");
	// CMP plate leads the header; the repository starts on the content column of the rows below.
	assert.equal(text(g[0].slice(2, 10)), " CMP×04 ");
	assert.ok(g[0].slice(2, 10).every((c) => c.fg === "field" && c.bg === "pink" && c.bold));
	assert.equal(text(g[0]).indexOf("■"), 11); assert.equal(text(g[0]).indexOf("jigenator"), 13); assert.equal(text(g[2]).indexOf("⑂"), 11);
	assert.deepEqual([g[0][11].fg, g[0][11].bg, g[0][12].ch, g[0][12].bg], ["primary", "field", " ", "field"], "acid square, then one field cell, before the repository");
	assert.ok(g[2].slice(2, 10).every((c) => c.fg === "field" && c.bg === "primary"), "01 ACT acid plate");
	assert.ok(g[5].slice(2, 10).every((c) => c.fg === "field" && c.bg === "text") && g[5][11].bg === "surface", "03 MDL plate on the model band");
	// Active == cwd and a known branch in a named repository: the branch and state replace the path; no cwd line.
	assert.doesNotMatch(plain(lines).join("\n"), /Projects|cwd|LDR/);
	assert.equal(text(g[2].slice(11, 17)), "⑂ main");
	assert.ok(g[2].slice(11, 17).every((c) => (c.ch === " " || c.fg === "secondary") && c.bg === "field" && !c.bold), "fork and branch are plain scale-grey text");
	assert.deepEqual([g[2][17].ch, g[2][17].bg, g[2][18].ch], [" ", "field", "m"], "exactly one field cell before the status");
	assert.ok(g[2].slice(18, 26).every((c) => c.fg === "warn" && c.bg === "field" && c.bold), "status is bold colored text, not a plate");
	assert.equal(g[2][26].bg, "field", "no status plate padding");
	// Readout inline over the gauge: one real blank cell either side, on the fill or track itself.
	const gauge = g[3].slice(11, 71);
	assert.equal(text(gauge.slice(0, 11)), " 114k/272k ", "tokens in the window's unit, not a second percentage");
	assert.ok(gauge.slice(0, 11).every((c) => c.bg === "primary" && c.fg === "field"), "readout over lit cells");
	assert.ok(gauge.slice(11, 26).every((c) => c.ch === "█" && c.fg === "primary" && c.bg === "primary"), "contiguous full cells, not browser hairlines");
	assert.ok(gauge.slice(26).every((c) => c.ch === " " || c.ch === "┃"));
	assert.equal(gauge.filter((c) => c.bg === "primary").length, Math.ceil(41.8 * 60 / 100));
	assert.ok(gauge.some((c) => c.bg === "wz") && gauge.some((c) => c.bg === "hz"), "20% warning/high zone tints");
	assert.deepEqual([g[3][11 + 42], g[3][11 + 54]].map((c) => [c.ch, c.fg]), [["┃", "warn"], ["┃", "high"]]);
	// Scale has numbers only: no decorative tick glyphs.
	assert.doesNotMatch(plain(lines).join("\n"), /[╵┬─]/);
	// Thread Rail: lamp, blank, bright ROOT, unit marks and the exact AU badge.
	const r = rail(g[0]);
	assert.equal(r.lamp.bg, "primary");
	assert.ok(r.root.every((c) => c.bg === "primary" && c.fg === "field"));
	assert.equal(text(r.badge), " 03 AU ");
	assert.ok(r.badge.every((c) => c.bg === "text" && c.fg === "field"));
	assert.equal(r.marks, "█·█·█·······");
	// ROOT's right edge meets the divider; the badge's left background edge meets the captions.
	assert.equal(r.rootAt + 5, plain(lines)[2].indexOf("▐"));
	assert.equal(r.badgeAt, plain(lines)[3].indexOf("USED"));
	assert.equal(g[0][60].ch, "┼", "standalone centre cross");
	// Pi's public color conversion downsamples for 256-color terminals.
	const indexed = renderFooter(session(), 120, hostTheme("256color")).join("\n");
	assert.doesNotMatch(indexed, /\x1b\[(38|48);2;/); assert.match(indexed, /\x1b\[48;5;\d+m/);
	assert.deepEqual(plain(renderFooter(session(), 120, hostTheme("256color"))), plain(lines));
});

test("Thread Rail stays aligned and truthful across context, numeral width, counts and Working/Idle", () => {
	const badges: Record<string, string> = { 0: " 00 AU ", 1: " 01 AU ", 3: " 03 AU ", 8: " 08 AU ", 9: " 09 AU ", 10: " 10 AU ", 12: " 12 AU ", 99: " 99 AU ", null: "  ? AU " };
	for (const percent of [0, 41.8, 93.3, 100, null]) {
		for (const units of [0, 1, 3, 8, 9, 10, 12, 99, null]) {
			for (const working of [true, false]) {
				const lines = renderFooter(session(percent, { working, units }), 120, theme), g = grid(lines), r = rail(g[0]);
				const label = `${percent}/${units}/${working}`;
				assert.equal(r.rootAt + 5, plain(lines)[2].indexOf("▐"), label);
				assert.equal(r.badgeAt, Math.max(plain(lines)[3].lastIndexOf("USED"), plain(lines)[3].lastIndexOf("UNKNOWN")), label);
				assert.equal(text(r.badge), badges[String(units)], label);
				assert.ok(r.root.every((c) => c.bg === "primary"), `${label}: ROOT stays bright`);
				assert.equal(r.lamp.bg, working ? "primary" : "surface", label);
				const shown = Math.min(6, units ?? 0);
				assert.equal(r.marks, "█·".repeat(shown) + "··".repeat(6 - shown), `${label}: six visible marks max, never invented`);
				assert.deepEqual(r.badge.map((c) => c.bg), Array(7).fill(units === null ? "plate" : units === 0 ? "surface" : "text"), `${label}: zero and unknown are styled apart`);
			}
		}
	}
	// Larger counts stay exact: the badge widens, never caps or shows +N.
	for (const [units, expected] of [[100, " 100 AU "], [123456, " 123456 AU "], [Number.MAX_SAFE_INTEGER, " 9007199254740991 AU "]] as const) {
		const lines = renderFooter(session(41.8, { working: true, units }), 120, theme), r = rail(cellsOf(lines[0]));
		assert.equal(text(r.badge), expected); assert.doesNotMatch(plain(lines)[0], /\+/);
		assert.ok(lines.every((line) => visibleWidth(line) === 120));
	}
	// Invalid counts and absent activity are unknown, never zero; absent activity shows the hatched unknown lamp.
	for (const units of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) assert.match(rows(session(41.8, { working: true, units }), 120)[0], / {2}\? AU /);
	const unreported = session(41.8);
	delete unreported.activity;
	const absent = grid(renderFooter(unreported, 120, theme))[0], r = rail(absent);
	assert.deepEqual([r.lamp.ch, r.lamp.fg, r.lamp.bg], ["╱", "graphic", "surface"]);
	assert.equal(text(r.badge), "  ? AU "); assert.equal(r.marks, "············");
	assert.ok(r.root.every((c) => c.bg === "primary"));
});

test("CMP plate: fixed eight cells, approved colour pairs, 99+ and Unknown, always visible and aligned", () => {
	const cases: [unknown, string, string, string][] = [
		[0, " CMP×00 ", "text", "plate"], [1, " CMP×01 ", "text", "violet"], [2, " CMP×02 ", "text", "violet"], [3, " CMP×03 ", "field", "pink"],
		[4, " CMP×04 ", "field", "pink"], [5, " CMP×05 ", "field", "high"], [99, " CMP×99 ", "field", "high"], [100, " CMP×99+", "field", "high"],
		[Number.MAX_SAFE_INTEGER, " CMP×99+", "field", "high"], [null, " CMP×?? ", "text", "plate"], [undefined, " CMP×?? ", "text", "plate"],
		[-1, " CMP×?? ", "text", "plate"], [1.5, " CMP×?? ", "text", "plate"], [Number.NaN, " CMP×?? ", "text", "plate"], [Number.POSITIVE_INFINITY, " CMP×?? ", "text", "plate"], ["3", " CMP×?? ", "text", "plate"],
	];
	for (const [compactions, plate, fgName, bgName] of cases) {
		const f = { ...session(), compactions } as FooterSnapshot, label = String(compactions);
		for (const width of [40, 59, 60, 72, 120, 160]) {
			const lines = renderFooter(f, width, theme), cells = grid(lines)[0].slice(metrics(width).G, metrics(width).G + 8);
			assert.equal(text(cells), plate, `${label}@${width}`);
			assert.ok(cells.every((c) => c.fg === fgName && c.bg === bgName && c.bold), `${label}@${width}: ${JSON.stringify(cells[1])}`);
		}
		// Minimal fallback keeps the same plate and pair on its first line.
		const minimal = grid(renderFooter(f, 30, theme))[0];
		assert.equal(text(minimal.slice(0, 8)), plate); assert.ok(minimal.slice(0, 8).every((c) => c.fg === fgName && c.bg === bgName));
		// Same text through Pi's 256-color conversion; no claim about real terminal fidelity.
		const indexed = renderFooter(f, 120, hostTheme("256color"));
		assert.doesNotMatch(indexed[0], /\x1b\[(38|48);2;/); assert.equal(stripTerminalSequences(indexed[0]), plain(renderFooter(f, 120, theme))[0]);
	}
	// Approved truecolor pairs and their contrast.
	const line = (compactions: number | null) => renderFooter({ ...session(), compactions }, 120, theme)[0];
	for (const [compactions, pair, ratio] of [[0, `${fg("#ffffff")}${bg("#555555")}`, 7.46], [2, `${fg("#ffffff")}${bg("#5200ff")}`, 7.49], [4, `${fg("#000000")}${bg("#ff15bd")}`, 6.09], [5, `${fg("#000000")}${bg("#f24723")}`, 5.70], [null, `${fg("#ffffff")}${bg("#555555")}`, 7.46]] as const) {
		assert.ok(line(compactions).includes(pair), `${compactions}`);
		const c = cellsOf(line(compactions))[2];
		assert.ok(Math.abs(contrast(c.fg, c.bg) - ratio) < 0.01, `${compactions}: ${contrast(c.fg, c.bg)}`);
	}
	// Boot swaps the approved pair for exactly two ticks, keeping its contrast and the current count.
	for (const [compactions, plate, fgName, bgName] of cases.slice(0, 10)) {
		const f = { ...session(), compactions } as FooterSnapshot, state = startMotion(f, 0, 3, true);
		for (let tick = 0; tick <= 2; tick++) {
			const cells = grid(renderFooter(f, 120, theme, motionFrame(advanceMotion(state, f, tick * MOTION_TICK_MS), tick * MOTION_TICK_MS)))[0].slice(2, 10);
			assert.equal(text(cells), plate, `${compactions} tick ${tick}`);
			const [fgNow, bgNow] = tick < 2 ? [bgName, fgName] : [fgName, bgName];
			assert.ok(cells.every((c) => c.fg === fgNow && c.bg === bgNow && c.bold), `${compactions} tick ${tick}`);
			assert.ok(contrast(fgNow, bgNow) >= 4.5);
		}
	}
	// CMP is never a re-strike or ghost target: every motion frame keeps the plate exact.
	for (let seed = 1; seed <= 40; seed++) {
		const f = session(), s = strikeAt(f, seed), settled = grid(renderFooter(f, 120, theme))[0].slice(0, 11);
		for (const event of [s.strike!, s.ghost].filter(Boolean)) for (let k = 0; k < event!.dur; k++) {
			assert.deepEqual(grid(renderFooter(f, 120, theme, motionFrame(s, event!.at + k * MOTION_TICK_MS)))[0].slice(0, 11).slice(2), settled.slice(2), `seed ${seed} k ${k}`);
		}
	}
	// Always visible: plain directory, repository without GitHub, pending and unavailable lookups.
	const states: [FooterSnapshot["workspace"], RegExp][] = [
		[{ path: "/x", git: { kind: "none" }, github: { kind: "none", reason: "not a repository" } }, /^ CMP×04 *$/],
		[{ path: "/x", git: { kind: "repository", active: { path: "/x", branch: "main", revision: "a", dirty: false }, isWorktree: false }, github: { kind: "none", reason: "No GitHub remote" } }, /^ CMP×04 *$/],
		[undefined, /^ CMP×04 {2}■ GitHub pending *$/],
		[{ path: "/x", git: { kind: "unknown", reason: "t" }, github: { kind: "unknown", reason: "ambiguous" } }, /^ CMP×04 {2}■ GitHub unavailable \(ambiguous\) *$/],
	];
	for (const [workspace, header] of states) {
		for (let width = 8; width <= 160; width++) {
			const out = rows({ ...session(), workspace }, width), G = width >= 40 ? metrics(width).G : 0;
			assert.equal(out[0].slice(G, G + 8), " CMP×04 ", `${width}: plate`);
			if (width >= 72) assert.match(out[0].slice(G).split(/ {3,}[┼R]/)[0].replace(/ *━┓$/, ""), header, `${width}: ${out[0]}`);
		}
	}
	// Repository/PR text and its wrapped continuations start on the rows' content column (G + P + 1).
	const long = { ...session(), pullRequest: { kind: "open", number: 123456, url: "https://github.com/owner/repo/pull/123456?" + "q=".repeat(30) } } as FooterSnapshot;
	long.workspace!.github = { kind: "repository", name: "owner/" + "repository-name-".repeat(10), url: "https://github.com/owner/r" };
	for (let width = 40; width <= 160; width++) {
		const out = rows(long, width), { G, P } = metrics(width), column = G + P + 1, act = out.findIndex((row) => row.includes("01 ACT"));
		assert.equal(out[act][column - 1], " "); assert.notEqual(out[act][column], " ", `${width}: rows' content column`);
		assert.equal(out[0].slice(G + P, column), " "); assert.equal(out[0].slice(column, column + 2), "■ ", `${width}: square on the title column`);
		assert.equal(out[act - 1].replace(/┃/g, "").trim(), "", `${width}: blank spacer above ACT`);
		const continuations = out.slice(1, act - 1).filter((row) => !row.includes("ROOT"));
		assert.ok(continuations.length > 0, `${width}: wraps`);
		// Pi's word wrap may keep the leading space of " · ", so a row may start one cell further in, never earlier.
		const starts = continuations.map((row) => row.replace(/┃/, " ").search(/\S/));
		assert.ok(starts.every((x) => x >= column), `${width}: ${starts}`);
		assert.equal(out.slice(0, act).join("").replace(/[\s┃┏┓━┼]/g, "").includes("PR#123456"), true, `${width}: nothing dropped`);
	}
});

test("responsive compact, narrow and minimal layouts keep every field and the activity count", () => {
	const f = fixture();
	assert.deepEqual(rows(f, 100), [
		"┏━ CMP×12  ■ owner/repo · PR #42                  ┼                   ROOT  █·█·█·······   03 AU  ━┓",
		"┃          cwd /launch unrelated                                                                   ┃",
		"   01 ACT  ⑂ feature/ui modified                                          ▐ ▀▀█ █▀▀   █▀█ %         ",
		"   02 CTX   32k/128k ███                     ┃         ┃                  ▐ █▀▀ ▀▀█   █ █ USED      ",
		"           0                       50        70        90  100            ▐ ▀▀▀ ▀▀▀ ▀ ▀▀▀ of 128k   ",
		"   03 MDL  provider/model · thinking high                                                           ",
		"┃  04 EXT  Other status                                                                            ┃",
		"┗━         Ponytail: ready                                                                        ━┛",
	]);
	f.pullRequest = { kind: "none" };
	assert.deepEqual(rows(f, 72), [
		"┏━ CMP×12  ■ owner/repo             ┼      ROOT  █·█·█·······  03 AU  ━┓",
		"┃          cwd /launch unrelated                                       ┃",
		"   01 ACT  ⑂ feature/ui modified                                        ",
		"   02 CTX   32k/128k ██                    ┃         ┃                  ",
		"           0                      50       70        90  100            ",
		"   03 MDL  provider/model · thinking high                               ",
		"┃  04 EXT  Other status                                                ┃",
		"┗━         Ponytail: ready                                            ━┛",
	]);
	f.pullRequest = { kind: "open", number: 42, url: "https://github.com/owner/repo/pull/42" };
	assert.deepEqual(rows(f, 48), [
		"┏ CMP×12  ■ owner/repo · PR #42                ┓",
		"┃                   ROOT  █·█·█·······  03 AU  ┃",
		"          cwd /launch unrelated                 ",
		"  01 ACT  ⑂ feature/ui modified                 ",
		"  02 CTX   32k/128k        ┃    ┃               ",
		"          0           50   70     100           ",
		"  03 MDL  provider/model · thinking high        ",
		"┃ 04 EXT  Other status                         ┃",
		"┗         Ponytail: ready                      ┛",
	]);
	// Below the framed minimum, plates become inline labels and values wrap beneath them.
	assert.deepEqual(rows(f, 30), [
		" CMP×12  ■ owner/repo · PR #42",
		"█  ROOT   03 AU               ",
		"cwd /launch unrelated         ",
		" 01 ACT  ⑂ feature/ui modified",
		" 02 CTX   32k/128k            ",
		" 03 MDL  provider/model ·     ",
		"thinking high                 ",
		" 04 EXT  Other status         ",
		"Ponytail: ready               ",
	]);
	// Tight space drops the unit marks first; the exact count always survives.
	f.pullRequest = { kind: "none" }; f.workspace!.github = { kind: "repository", name: "owner/" + "r".repeat(26), url: "https://github.com/owner/r" };
	const tight = rows(f, 72)[0];
	assert.match(tight, /^┏━ CMP×12  ■ owner\/r{26} +ROOT {3}03 AU  ━┓$/); assert.doesNotMatch(tight, /·/);
	for (let width = 1; width <= 160; width++) {
		const out = rows(session(41.8, { working: true, units: 12 }), width).join("");
		if (width >= 7) assert.match(out.replace(/\s/g, ""), /12AU/, `width ${width}`);
	}
});

test("branch replaces the Active path; cwd shows only when it differs; paths keep parent/current and stay truthful", () => {
	const f = fixture();
	f.launchPath = "/Users/example/Documents/Projects/pi-status-bar";
	f.activePath = `${f.homePath}/worktrees/feature`;
	f.workspace!.path = f.activePath;
	repository(f).active.path = f.activePath;
	repository(f).main!.path = `${f.homePath}/Projects/repo`;
	f.pullRequest = { kind: "none" };
	const before = structuredClone(f);
	let out = rows(f, 160);
	// A named repository on a branch: branch and state replace the path; the title names the repository.
	assert.match(out[0], /CMP×12  ■ owner\/repo /);
	// Pi's cwd takes the spacer row above ACT, so the numbered plates stay together.
	assert.match(out[1], /^┃ {10}cwd Projects\/pi-status-bar {2}/);
	assert.match(out[2], /01 ACT {2}⑂ feature\/ui modified {2}/);
	assert.match(out[3], /02 CTX/);
	assert.doesNotMatch(out.join("\n"), /worktrees\/feature|LDR|MN|Projects\/repo|release/);
	// Without a repository name the path stays, followed by its Git details; cwd stays above.
	f.workspace!.github = { kind: "none", reason: "No GitHub remote" };
	out = rows(f, 160);
	assert.match(out[2], /01 ACT {2}worktrees\/feature {2}/); assert.doesNotMatch(out[2], /feature\/ui/);
	assert.match(out[3], /^ {11}⑂ feature\/ui modified/);
	assert.match(out[1], /^┃ {10}cwd Projects\/pi-status-bar/); assert.match(out[4], /02 CTX/);
	f.workspace!.github = before.workspace!.github;
	assert.deepEqual(f, before, "display shortening must not change stored paths or URLs");
	// cwd uses the same parent/current display and edge cases as Active.
	const cwd = (path: string, home = f.homePath) => {
		f.launchPath = path; f.homePath = home;
		return rows(f, 160).find((row) => /^[┃ ] {10}cwd /.test(row))?.slice(15).split(/ {2,}/)[0];
	};
	assert.equal(cwd(f.homePath), "~");
	assert.equal(cwd(`${f.homePath}/project`), "~/project");
	assert.equal(cwd("/home/example-other/repo"), "example-other/repo");
	assert.equal(cwd("/home/example/..dots"), "~/..dots");
	assert.equal(cwd("/"), "/");
	assert.equal(cwd("/repo"), "/repo");
	assert.equal(cwd("/repo/worktree"), "/repo/worktree", "nothing is elided from a two-component path");
	assert.equal(cwd("/a/b/c/"), "b/c");
	assert.equal(cwd("relative/dir/name"), "relative/dir/name");
	assert.equal(cwd("/project", "/"), "~/project");
	assert.equal(cwd("/x/y/z", ""), "y/z", "an empty home never abbreviates against cwd");
	// Only the exact stored path hides cwd; a shared parent/current display is not enough.
	f.homePath = "/home/example";
	assert.equal(cwd(f.activePath), undefined);
	assert.equal(cwd("/elsewhere/worktrees/feature"), "worktrees/feature", "distinct paths with the same display stay visible");
	assert.equal(cwd(`${f.activePath}/`), "worktrees/feature", "inexact spellings show cwd rather than claim equality");
	assert.ok(rows(f, 30).includes("cwd worktrees/feature         "), "minimal fallback names a differing cwd");
	f.launchPath = f.activePath;
	assert.doesNotMatch(rows(f, 30).join("\n"), /cwd/); assert.doesNotMatch(rows(f, 120).join("\n"), /cwd/);
	assert.equal(rows(f, 120)[1].replace(/┃/g, "").trim(), "", "equal paths leave the spacer row blank");
	assert.deepEqual(f, { ...before, launchPath: f.activePath }, "only the stored launch path changed");
});

test("truthful none, pending, unknown, unborn/detached, missing main and PR states", () => {
	let f = fixture();
	f.workspace = { path: f.activePath, git: { kind: "none" }, github: { kind: "none", reason: "not a repository" } };
	let out = rows(f, 120);
	assert.match(out[0], /^┏━ CMP×12 {20,}┼/, "absent GitHub keeps CMP, with no GitHub status");
	assert.match(out[2], /01 ACT {2}\/repo\/worktree {20}/);
	assert.doesNotMatch(out.join("\n"), /GitHub|Git |MN|PR #|clean|modified/);
	f = fixture();
	f.workspace!.github = { kind: "none", reason: "No GitHub remote" };
	out = rows(f, 120);
	assert.doesNotMatch(out.join("\n"), /GitHub|PR/); assert.match(out[0], /^┏━ CMP×12 {20,}┼/);
	assert.match(out[2], /01 ACT {2}\/repo\/worktree {2}/, "no repository name: the path stays");
	assert.match(out[3], /⑂ feature\/ui modified/);
	f.workspace = undefined;
	out = rows(f, 120);
	assert.match(out[0], /CMP×12  ■ GitHub pending /); assert.match(out[2], /01 ACT {2}\/repo\/worktree {2}/); assert.match(out[3], /Git pending/);
	f.workspace = { path: f.activePath, git: { kind: "unknown", reason: "timeout" }, github: { kind: "unknown", reason: "ambiguous" } };
	out = rows(f, 120);
	assert.match(out.join("\n"), /Git unavailable \(timeout\)/); assert.match(out[0], /CMP×12  ■ GitHub unavailable \(ambiguous\)/); assert.doesNotMatch(out.join("\n"), /clean|No open PR/);
	// The square takes acid only for a known repository; otherwise it shares the title's state color.
	const square = (snapshot: FooterSnapshot) => { const row = grid(renderFooter(snapshot, 120, theme))[0], i = text(row).indexOf("■"); return [row[i].fg, row[i + 1].ch, row[i + 1].bg]; };
	assert.deepEqual(square(f), ["warn", " ", "field"], "unavailable");
	assert.deepEqual(square({ ...f, workspace: undefined }), ["secondary", " ", "field"], "pending");
	assert.deepEqual(square(fixture()), ["primary", " ", "field"], "repository");
	f = fixture();
	repository(f).active = { path: f.activePath, branch: null, revision: null, dirty: null, error: "timeout" };
	repository(f).main = null; repository(f).mainUnavailableReason = "pruned";
	for (const [pr, expected] of [
		[{ kind: "none" }, "CMP×12  ■ owner/repo "], [{ kind: "unavailable", reason: "auth missing" }, "CMP×12  ■ owner/repo · PR unavailable (auth missing) "], [{ kind: "not-applicable" }, "CMP×12  ■ owner/repo "],
	] as const) {
		f.pullRequest = pr;
		out = rows(f, 120);
		assert.ok(out[0].includes(expected), out[0]); assert.doesNotMatch(out.join("\n"), /No open PR|PR not applicable|PR #/);
		// Detached: no branch identifies the checkout, so the path stays above the details.
		assert.match(out[2], /01 ACT {2}\/repo\/worktree {2}/);
		assert.match(out[3], /⑂ detached status unavailable \(timeout\)/); assert.doesNotMatch(out.join("\n"), /MN|pruned/);
	}
	repository(f).active.revision = "abc123";
	assert.match(rows(f, 120).join("\n"), /detached @abc123/);
	// Unborn: the branch is known without a revision, so it still replaces the path.
	repository(f).active.branch = "main"; repository(f).active.revision = null;
	repository(f).main = repository(f).active; delete repository(f).mainUnavailableReason;
	out = rows(f, 120);
	assert.match(out[2], /01 ACT {2}⑂ main status unavailable \(timeout\)/); assert.doesNotMatch(out.join("\n"), /2\.1 MN|\/repo\/worktree/);
});

test("directory-first Git details follow every path wrap; a branch-only ACT wraps alone; continuations stay unnumbered", () => {
	const f = fixture();
	f.activePath = "/Users/example/" + "parent-directory-".repeat(8) + "/" + "current-directory-".repeat(8);
	repository(f).active.branch = "feat/" + "long/slash-branch/".repeat(8);
	const path = "parent-directory-".repeat(8) + "/" + "current-directory-".repeat(8), branch = "feat/" + "long/slash-branch/".repeat(8);
	for (const named of [false, true]) {
		f.workspace!.github = named ? { kind: "repository", name: "owner/repo", url: "https://github.com/owner/repo" } : { kind: "none", reason: "No GitHub remote" };
		for (const width of [12, 30, 40, 48, 72, 100, 120, 160]) {
			const lines = renderFooter(f, width, theme), out = plain(lines), label = `${named}@${width}`;
			const fork = out.findIndex((row) => row.includes("⑂")), cwd = out.findIndex((row) => row.includes("cwd /launch"));
			if (named) {
				// The branch replaces the path on the ACT row.
				assert.ok(out[fork].includes("01 ACT") || width < 40 && out[fork - 1].includes("01 ACT"), `${label}: branch on the ACT row`);
				assert.doesNotMatch(content(lines), /parent-directory|current-directory/, `${label}: no path`);
			} else {
				const before = content(lines.slice(0, fork));
				assert.ok(before.includes(path), `${label}: complete path precedes fork`);
				assert.doesNotMatch(before, /feat|long\/slash-branch|modified/);
				assert.ok(!out[fork - 1].includes("⑂"));
			}
			const act = out.findIndex((row) => row.includes("01 ACT")), ctx = out.findIndex((row) => row.includes("02 CTX"));
			const details = content(lines.slice(fork, ctx));
			assert.ok(details.includes(branch), `${label}: branch retained`);
			assert.ok(details.includes("modified"));
			assert.ok(cwd >= 0 && cwd < act, `${label}: cwd precedes ACT`);
			if (width >= 40) {
				const { G, P } = metrics(width);
				for (const row of grid(lines).slice(act + 1, ctx)) assert.ok(row.slice(G, G + P).every((c) => c.ch === " " && c.bg === "field"), `${label}: unnumbered plain continuation`);
			}
		}
	}
});

test("unplated grey fork and branch, then truthful colored status text, survive layout separation", () => {
	for (const dirty of [false, true, null]) for (const width of [30, 40, 72, 120]) {
		const f = fixture(); repository(f).active.dirty = dirty;
		const rendered = grid(renderFooter(f, width, theme));
		const forkRow = rendered.findIndex((row) => text(row).includes("⑂")), line = rendered[forkRow];
		const at = text(line).indexOf("⑂");
		// Same grey as the context scale numbers, on the field: no fork or branch plate.
		assert.deepEqual([line[at - 1]?.bg ?? "field", line[at].fg, line[at].bg, line[at].bold, line[at + 1].bg], ["field", "secondary", "field", false, "field"], `${dirty}@${width}: fork`);
		const ctxRow = rendered.findIndex((row) => text(row).includes("02 CTX"));
		// Content columns only: the wide numeral and its captions share these rows beyond the ▐ divider.
		const all = rendered.slice(forkRow, ctxRow).flatMap((row) => { const d = text(row).indexOf("▐"); return d < 0 ? row : row.slice(0, d); });
		const branch = text(all).indexOf("feature/ui");
		assert.ok(branch >= 0);
		assert.ok(all.slice(branch, branch + "feature/ui".length).every((c) => c.fg === "secondary" && c.bg === "field" && !c.bold), `${dirty}@${width}: plain grey branch`);
		assert.equal(all[branch + "feature/ui".length].bg, "field", `${dirty}@${width}: no branch plate padding`);
		const label = dirty === null ? "status unavailable" : dirty ? "modified" : "clean";
		// Bold colored text on the field, collected across wraps: no plate can merge with the gauge fill below.
		const after = all.slice(branch + "feature/ui".length), ink = dirty === null ? "text" : dirty ? "warn" : "primary";
		assert.ok(after.every((c) => c.bg === "field"), `${dirty}@${width}: no status plate`);
		const status = after.filter((c) => c.ch !== " " && c.fg === ink);
		assert.equal(text(status), label.replace(/\s/g, ""));
		assert.ok(status.every((c) => c.bold), `${dirty}@${width}: bold status`);
	}
});

test("primary-checkout metadata and PR URL are display-only omissions at every width and motion frame", () => {
	const f = fixture(), hidden = structuredClone(f), git = repository(hidden);
	git.main = { path: "/secret-parent/hidden-primary", branch: "hidden-primary-branch", revision: "hidden-revision", dirty: null, error: "hidden-primary-error" };
	git.mainUnavailableReason = "hidden-primary-unavailable";
	const absent = structuredClone(hidden); repository(absent).main = null;
	const before = structuredClone(hidden), frames = eventFrames(f);
	for (let width = 1; width <= 160; width++) for (const frame of frames) {
		const expected = renderFooter(f, width, theme, frame);
		assert.deepEqual(renderFooter(hidden, width, theme, frame), expected, `${width}: no primary data rendered`);
		assert.deepEqual(renderFooter(absent, width, theme, frame), expected, `${width}: no primary unavailable row`);
		const out = content(expected);
		assert.doesNotMatch(out, /MN|release|https:|github\.com|hidden-primary/);
		if (width >= 3) assert.ok(out.includes("PR#42"), `${width}: keep PR number`);
	}
	assert.deepEqual(hidden, before, "render does not mutate tool/domain data");
});

test("plain, pending, unavailable, detached and unborn Git states stay identifiable, ordered and width safe", () => {
	const none = fixture(); none.workspace!.git = { kind: "none" };
	const pending = fixture(); pending.workspace = undefined;
	const unknown = fixture(); unknown.workspace!.git = { kind: "unknown", reason: "timeout" };
	const dirtyUnknown = fixture(); repository(dirtyUnknown).active.dirty = null; repository(dirtyUnknown).active.error = "status timeout";
	const detached = fixture(); repository(detached).active.branch = null;
	const unborn = fixture(); repository(unborn).active.branch = "new-branch"; repository(unborn).active.revision = null;
	for (const [f, message, branchOnly] of [[none, "", false], [pending, "Gitpending", false], [unknown, "Gitunavailable(timeout)", false], [dirtyUnknown, "statusunavailable", true], [detached, "detached@abcdef", false], [unborn, "new-branch", true]] as const) {
		f.launchPath = f.activePath; // cwd rows are covered separately
		const frames = eventFrames(f);
		for (let width = 1; width <= 160; width++) for (const frame of frames) {
			const lines = renderFooter(f, width, theme, frame), out = content(lines);
			assert.ok(lines.every((line) => visibleWidth(line) <= width), `${message}@${width}`);
			if (width < 3) continue;
			assert.ok(out.includes(message), `${message}@${width}: identifiable`);
			// A known branch in a named repository replaces the path; every other state keeps the path first.
			if (branchOnly) assert.ok(!out.includes("/repo/worktree"), `${message}@${width}: branch replaces path`);
			else if (message) assert.ok(out.indexOf("/repo/worktree") < out.indexOf(message), `${message}@${width}: path first`);
			else assert.doesNotMatch(out, /⑂|Gitpending|clean|modified|feature/);
			if (f === dirtyUnknown || f === unknown) assert.doesNotMatch(out, /clean|modified/);
		}
		const out = rows(f, 72), act = out.findIndex((line) => line.includes("01 ACT")), ctx = out.findIndex((line) => line.includes("02 CTX"));
		assert.equal(ctx - act, message && !branchOnly ? 2 : 1, `${message}: no invented empty Git line`);
	}
});

// Gauge cells by background: a contiguous run of track/fill cells starting after the CTX plate and gap.
const gaugeOf = (lines: string[], width: number) => {
	const g = grid(lines), row = g.find((cells) => text(cells).includes("02 CTX"))!, start = metrics(width).G + 9;
	let end = start;
	while (end < row.length && row[end].bg !== "field") end++;
	return row.slice(start, end);
};
test("context: true zero, real fill, >70 warning, >90 high, unknown, nonfinite, overflow and missing window", () => {
	// Pi derives percent from tokens; both are null when usage is unknown.
	const at = (percent: number | null, width = 72) => {
		const f = fixture(); f.contextUsage = { tokens: percent !== null && Number.isFinite(percent) ? percent * 1_280 : null, contextWindow: 128_000, percent };
		return renderFooter(f, width, theme);
	};
	const lit = (lines: string[], width = 72) => gaugeOf(lines, width).filter((c) => ["primary", "warn", "high"].includes(c.bg)).length;
	const cells = gaugeOf(at(0), 72).length;
	assert.equal(cells, 47);
	assert.equal(lit(at(0)), 0, "true zero is an empty gauge");
	assert.equal(text(gaugeOf(at(0), 72).slice(0, 9)), " 0k/128k ", "zero readout is padded on the track");
	assert.doesNotMatch(plain(at(0)).join("\n"), /WARN|HIGH|UNKNOWN/);
	assert.equal(lit(at(0.1)), 1, "any usage lights a cell");
	assert.equal(lit(at(100)), cells);
	for (const percent of [25, 58, 93.3]) assert.equal(lit(at(percent)), Math.ceil((percent * cells) / 100));
	assert.doesNotMatch(plain(at(70)).join("\n"), /WARN/); assert.match(plain(at(70.1)).join("\n"), / 90k\/128k .*▲ WARN/);
	assert.match(plain(at(90)).join("\n"), /▲ WARN/); assert.match(plain(at(90.1)).join("\n"), / 115k\/128k .*▲ HIGH/);
	for (const percent of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
		const out = at(percent as number | null), gauge = gaugeOf(out, 72);
		assert.equal(text(gauge.slice(0, 8)), " ?/128k ", "unknown readout keeps both pad cells");
		assert.ok(gauge.slice(8).every((c) => c.ch === "╱" && c.bg === "surface"), "unknown is hatched, never empty or zero");
		assert.match(plain(out).join("\n"), /\? UNKNOWN/); assert.doesNotMatch(plain(out).join("\n"), /0\.0%| 0k\//);
	}
	assert.match(plain(at(null, 100)).join("\n"), /▐ ▀▀█ +\n.*▐  ▀▀ +UNKNOWN/s);
	assert.match(plain(at(150)).join("\n"), / 192k\/128k .*▲ HIGH/); assert.equal(lit(at(150)), cells, "graphical extent clamps; readout does not");
	assert.match(plain(at(150, 100)).join("\n"), /▐ ▄█  █▀▀ █▀█   █▀█ %/, "wide numeral shows the truthful value");
	const huge = plain(at(1e21, 100)).join("\n");
	assert.match(huge, /1\.28e\+21k\/128k/); assert.doesNotMatch(huge, /▐/, "no misleading numeral for values without glyphs");
	assert.match(plain(at(-1)).join("\n"), / -1k\/128k/); assert.equal(lit(at(-1)), 0);
	const f = fixture(); f.contextUsage = undefined; f.model = undefined;
	assert.match(rows(f, 72).join("\n"), / \? .*\? UNKNOWN/); assert.match(rows(f, 72).join("\n"), /no-model · thinking high/);
	f.contextUsage = { tokens: 1, contextWindow: 0, percent: 1 }; f.model = { provider: "p", id: "m", contextWindow: Number.NaN };
	const noWindow = rows(f, 100).join("\n");
	assert.match(noWindow, /02 CTX {3}1 /); assert.doesNotMatch(noWindow, /%\/|1\/|of /);
	f.contextUsage = { tokens: 84_000, contextWindow: 0, percent: 1 };
	assert.match(rows(f, 100).join("\n"), /02 CTX {3}84k /, "without a window, tokens use their own scale");
	// Tokens take the window's unit and precision, so the pair reads as one fraction.
	for (const [tokens, contextWindow, readout] of [[400, 200_000, " 0k/200k "], [83_600, 200_000, " 84k/200k "], [100_000, 1_000_000, " 0.1M/1.0M "], [800_000, 1_000_000, " 0.8M/1.0M "], [999_600, 1_000_000, " 1.0M/1.0M "], [12, 999, " 12/999 "]] as const) {
		f.contextUsage = { tokens, contextWindow, percent: (tokens * 100) / contextWindow };
		assert.equal(text(gaugeOf(renderFooter(f, 72, theme), 72).slice(0, readout.length)), readout);
	}
	// A readout that would cover the 70 mark moves below a full-width gauge instead.
	f.contextUsage = { tokens: 2_500_000, contextWindow: 10_000_000, percent: 25 };
	const narrow = rows(f, 40);
	assert.ok(narrow.some((line) => /^ {9,}2\.5M\/10\.0M/.test(line)), narrow.join("\n"));
});

// Named by default, so a known branch replaces the path; pass false to keep the path with its Git details.
const hostile = (named = true) => {
	const f = fixture();
	if (!named) f.workspace!.github = { kind: "none", reason: "No GitHub remote" };
	f.activePath = "/项目/e\u0301/👩‍💻/" + "long".repeat(30);
	f.launchPath = "/très/長い/" + "path-segment-".repeat(12);
	repository(f).active.branch = "feature/" + "branch-name-".repeat(12) + "👩🏽‍🚀";
	f.pullRequest = { kind: "open", number: 123456, url: "https://github.com/owner/repo/pull/123456?" + "q=".repeat(30) };
	f.model = { provider: "provider-" + "x".repeat(40), id: "model-id-" + "y".repeat(50), contextWindow: 2_000_000 };
	f.statuses = new Map([["color", "\x1b[38;2;255;10;20m彩色 status " + "verylong".repeat(10) + "\x1b[0m tail"], ["emoji", "○ 🐴 ponytail: ⚡ FULL"]]);
	f.activity = { working: true, units: 1234 };
	f.compactions = 123;
	return f;
};
// Frames that exercise every decoration path at once.
const eventFrames = (f: FooterSnapshot): FooterFrame[] => {
	const out: FooterFrame[] = [SETTLED_FRAME, { ...SETTLED_FRAME, wipe: { from: "ok", cells: 5 }, tagFlash: true, flash70: true, flash90: true, cal: -1, pulse: 7 }];
	const booting = startMotion(f, 0, 3, true);
	for (const t of [0, 150, 400, 900]) out.push(motionFrame(advanceMotion(booting, f, t), t));
	for (const seed of [1, 2, 3]) {
		const s = strikeAt(f, seed);
		for (const k of [0, 2, 5]) out.push({ ...motionFrame(s, s.strike!.at + k * MOTION_TICK_MS), glitch: { level: 3, seed: seed * 17 } });
	}
	return out;
};
const content = (lines: string[]) => plain(lines).map((line) => line.split("▐")[0]).join("").replace(/[\s┃┗┛━┏┓┼]/g, "");
test("every line fits widths 1..160 for each state and motion frame, and no field is dropped", () => {
	for (const [percent, named] of [[0, true], [75, false], [95.5, true], [null, false]] as const) {
		const f = hostile(named); f.contextUsage = { tokens: null, contextWindow: 2_000_000, percent };
		const frames = eventFrames(f);
		for (let width = 1; width <= 160; width++) {
			for (const frame of frames) {
				const lines = renderFooter(f, width, theme, frame);
				for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)}`);
				if (width >= 40) for (const line of lines) assert.equal(visibleWidth(line), width, "framed rows fill the field exactly");
			}
			if (width < 3) continue;
			const out = content(renderFooter(f, width, theme));
			assert.doesNotMatch(out, /https:|github\.com|q=/, `width ${width}: no full PR URL`);
			const expected = ["長い/" + "path-segment-".repeat(12), "branch-name-".repeat(12) + "👩🏽‍🚀", "⑂", "y".repeat(50), "verylong".repeat(10) + "tail", "○🐴ponytail:⚡FULL", "1234AU", "ROOT", "CMP×99+"];
			// Named: the repository and PR title; otherwise the Active path the branch would have replaced.
			for (const value of [...expected, ...(named ? ["owner/repo", "PR#123456"] : ["👩‍💻/" + "long".repeat(30)])]) {
				assert.ok(out.includes(value.replace(/\s/g, "")), `${named}@${width} dropped ${value}`);
			}
			if (named) assert.ok(!out.includes("long".repeat(30)), `${width}: the branch replaces the path`);
		}
	}
	for (const width of [200, 240, 400]) for (const frame of eventFrames(hostile())) for (const line of renderFooter(hostile(), width, theme, frame)) assert.equal(visibleWidth(line), width);
	assert.deepEqual(renderFooter(fixture(), 0, theme), []); assert.deepEqual(renderFooter(fixture(), Number.NaN, theme), []);
});

test("continuation rows never carry colored tabs below label plates", () => {
	for (const [percent, named] of [[0, true], [75, false], [95.5, true], [null, false]] as const) {
		const f = hostile(named); f.contextUsage = { tokens: null, contextWindow: 2_000_000, percent };
		for (let width = 40; width <= 160; width++) {
			const { G, P } = metrics(width);
			const lines = renderFooter(f, width, theme);
			let continuations = 0;
			const first = plain(lines).findIndex((line) => line.includes("01 ACT"));
			lines.forEach((line, i) => {
				const plate = sliceByColumn(line, G, P);
				if (i <= first || stripTerminalSequences(plate).trim()) return;
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
	for (const frame of eventFrames(f)) {
		const lines = renderFooter(f, 200, theme, frame);
		assert.doesNotMatch(lines.join(""), /\x1b\[2J|\x1b\]|\x07|\x00|\u202e/);
		const unclosed = lines.findIndex((line: string) => line.includes("UNCLOSED"));
		assert.ok(lines[unclosed].indexOf("\x1b[0m", lines[unclosed].indexOf("UNCLOSED")) > 0, "status style is closed before footer padding and frame");
		assert.doesNotMatch(lines[unclosed + 1], /38;2;1;2;3/);
		assert.ok(stripTerminalSequences(lines[unclosed + 1]).includes("plain after"));
	}
	const white = fg("#ffffff"), black = bg("#000000");
	assert.ok(renderFooter(f, 200, theme).some((line: string) => line.includes(`\x1b[31mred\x1b[0m${white}${black} next`)), "a status reset restores the footer field, not terminal default");
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

test("live values: context unknown after compaction, current model/thinking, statuses and activity each render", () => {
	const f = fixture(); f.contextUsage = { tokens: null, percent: null, contextWindow: 128_000 };
	assert.match(rows(f, 80).join("\n"), / \?\/128k .*\? UNKNOWN/);
	const statuses = new Map([["first", "first"]]); f.statuses = statuses;
	assert.match(rows(f, 80).join("\n"), /first/);
	statuses.set("later", "later"); f.thinking = "off"; f.model!.id = "new-model"; f.activity = { working: false, units: 12 };
	const lines = rows(f, 80).join("\n");
	assert.match(lines, /later/); assert.match(lines, /new-model · thinking off/); assert.match(lines, /12 AU/);
	assert.doesNotMatch(lines, /\$|cache|↑|↓/);
});

test("decoration is a pure function of supplied time, seed and memory; values stay current in every frame", () => {
	const f = session(41.8);
	const tokens = ["⑂ main", "modified", " 114k/272k ", "openai-codex/gpt-6-astra", "thinking xhigh", "tatsu-cli: current | agent-workspace: update available (3)", "CMP×04  ■ jigenator/pi-status-bar"];
	const lit = Math.ceil(41.8 * 60 / 100);
	let frames = 0;
	simulate(f, 99, 30_000, (state, now) => {
		const frame = motionFrame(state, now), lines = renderFooter(f, 120, theme, frame), out = plain(lines).join("\n");
		for (const token of tokens) assert.ok(out.includes(token), `${now}: ${token}`);
		assert.equal(text(rail(grid(lines)[0]).badge).replace(/[▓▚▞░]/g, " "), " 03 AU ", `${now}: exact count including header draw-in`);
		// Fill extent is truthful: the fill-edge cell is solid and nothing past it is fill-coloured.
		const gauge = grid(lines)[3].slice(11, 71);
		if (frame.boot === Infinity) assert.deepEqual([gauge[lit - 1].ch, gauge[lit - 1].bg], ["█", "primary"], `${now}`);
		assert.ok(gauge.slice(lit).every((c) => !["primary"].includes(c.bg) && c.fg !== "primary"), `${now}: no fake extent`);
		frames++;
	});
	assert.ok(frames > 100);
	// Same seed and inputs give the same decoration; frames reference the event's plan instead of re-randomising.
	const a = simulate(f, 7, 12_000), b = simulate(f, 7, 12_000);
	assert.deepEqual(a, b);
	const s = strikeAt(f, 5);
	assert.equal(motionFrame(s, s.strike!.at).strike!.items, motionFrame(s, s.strike!.at + 100).strike!.items, "plan is generated once per event");
	assert.deepEqual(renderFooter(f, 120, theme), renderFooter(f, 120, theme, SETTLED_FRAME));
	assert.equal(advanceMotion(advanceMotion(s, f, s.strike!.at), f, s.strike!.at), advanceMotion(s, f, s.strike!.at), "unchanged input keeps the same state");
});

test("boot: varied treatments on real values, header draw-in, then a settled frame", () => {
	const f = session(41.8), state = startMotion(f, 0, 11, true);
	const at = (t: number) => renderFooter(f, 120, theme, motionFrame(advanceMotion(state, f, t), t));
	const first = grid(at(0));
	assert.equal(text(first[0]).slice(0, 2), "  ", "frame corners draw in");
	assert.match(text(first[0]), /CMP×04  ■ jigenator\/pi-status-bar/, "plate and title are present from the first frame");
	assert.ok(first[1].slice(2, 118).every((c) => c.ch === " "), "the spacer row stays blank inside the frame");
	assert.ok(first[2].slice(2, 10).every((c) => c.bg === "field" && c.fg === "primary"), "plates start outlined");
	assert.ok(first[3].slice(12, 21).every((c) => c.underline && !c.bold), "readout characters type-lock");
	assert.equal(text(first[3].slice(11, 22)), " 114k/272k ", "exact readout from the first frame");
	assert.ok(first[3].slice(22, 37).every((c) => c.ch === "░" || c.ch === "▒"), "lit cells acquire texture at the true extent");
	assert.equal(first[3].slice(37, 71).filter((c) => c.fg === "primary" || c.bg === "primary").length, 0, "no fake count-up");
	assert.match(text(first[2]).slice(90), /█/, "boot shows only the current numeral shape");
	assert.ok(first.slice(2, 5).flatMap((row) => row.slice(94, 107)).filter((c) => "█▀▄".includes(c.ch)).every((c) => c.fg === "graphic"), "current squares acquire color from grey");
	assert.equal(text(first[2].slice(11, 26)), "⑂ main modified", "exact branch and status from the first frame");
	assert.ok(first[2].slice(11, 17).filter((c) => c.ch !== " ").every((c) => c.bg === "surface"), "branch pieces wait on a grey band");
	assert.ok(first[2].slice(18, 26).every((c) => c.bg === "surface" && c.fg === "secondary"), "status text waits on a grey band");
	const lock = grid(at(6 * MOTION_TICK_MS));
	assert.ok(lock[2].slice(13, 17).every((c) => c.bg === "primary"), "the branch latches acid as it locks");
	const mid = grid(at(8 * MOTION_TICK_MS));
	assert.ok(mid[2].slice(13, 17).every((c) => c.bg === "field" && c.fg === "secondary"), "then settles to scale grey");
	assert.ok(mid[5].slice(11).some((c) => c.bg === "surface" && c.fg === "secondary"), "model words wait their turn");
	const settledStatus = grid(at(12 * MOTION_TICK_MS))[2].slice(18, 26);
	assert.ok(settledStatus.every((c) => c.bg === "field" && c.fg === "warn" && c.bold), "status settles to its bold ink");
	// Values change during boot and are shown at once.
	const changed = session(93.3), s2 = advanceMotion(state, changed, 300);
	assert.match(plain(renderFooter(changed, 120, theme, motionFrame(s2, 300))).join("\n"), / 254k\/272k .*▲ HIGH/);
	assert.equal(motionFrame(state, 31 * MOTION_TICK_MS).boot, Infinity);
	// Statuses settle in turn without losing their own SGR styling.
	const colored = session(41.8);
	colored.statuses = new Map([["a", "\x1b[38;2;255;10;20mred status\x1b[0m tail"], ["b", "second"]]);
	for (let t = 0; t <= 31 * MOTION_TICK_MS; t += MOTION_TICK_MS) {
		const lines = renderFooter(colored, 120, theme, motionFrame(advanceMotion(state, colored, t), t));
		assert.ok(lines.some((line: string) => line.includes("\x1b[38;2;255;10;20mred status")), `${t}`);
		assert.match(plain(lines).join("\n"), /red status tail[^]*second/);
	}
	const done = advanceMotion(state, f, 2_000);
	assert.equal(done.boot, undefined);
	assert.deepEqual(plain(renderFooter(f, 120, theme, { ...motionFrame(done, 2_000), ghosts: undefined, strike: undefined, glitch: undefined })), plain(renderFooter(f, 120, theme)).map((line, i) => i === 0 ? plain(renderFooter(f, 120, theme, { ...SETTLED_FRAME, pulse: motionFrame(done, 2_000).pulse }))[0] : line));
	assert.equal(state.ghostAt >= 31 * MOTION_TICK_MS, true, "no ambient during boot");
	assert.equal(state.strikeAt >= 31 * MOTION_TICK_MS, true);
});

test("boot never masks current activity or CMP in shared, separate or minimal header rows", () => {
	const expected = { null: ["  ? AU ", " CMP×?? "], 0: [" 00 AU ", " CMP×00 "], 12: [" 12 AU ", " CMP×12 "], 123: [" 123 AU ", " CMP×99+"], 3: [" 03 AU ", " CMP×03 "] };
	for (const width of [30, 48, 72, 120, 240, 400]) for (const working of [false, true]) {
		let f = session(41.8, { working, units: null }), state = startMotion(f, 0, 11, true);
		for (const [now, units] of [[0, null], [50, 0], [250, 12], [750, 123], [1500, 3]] as const) {
			f = { ...session(41.8, { working, units }), compactions: units };
			state = advanceMotion(state, f, now);
			const frame = motionFrame(state, now), lines = grid(renderFooter(f, width, theme, frame));
			const activity = lines.find((line) => text(line).includes("ROOT"));
			assert.ok(activity, `${width}/${working}/${now}: ROOT visible from first frame`);
			const content = text(activity), start = content.indexOf("ROOT") - 3, end = content.lastIndexOf("AU") + 3;
			assert.ok(content.includes(expected[String(units) as keyof typeof expected][0]), `${width}/${working}/${now}: exact current count`);
			assert.ok(plain(renderFooter(f, width, theme, frame))[0].includes(expected[String(units) as keyof typeof expected][1]), `${width}/${working}/${now}: current CMP`);
			const settled = grid(renderFooter(f, width, theme, { ...SETTLED_FRAME, pulse: frame.pulse })).find((line) => text(line).includes("ROOT"))!;
			assert.deepEqual(activity.slice(start, end), settled.slice(start, end), `${width}/${working}/${now}: activity cells bypass boot mask`);
		}
	}
});

test("numeral reconstructs current-shape squares only; rapid retarget preserves acquired current colors", () => {
	let f = session(41.8), state = startMotion(f, 0, 4, false);
	f = session(93.3); state = advanceMotion(state, f, 1_000);
	assert.equal(state.wipe?.from, "ok"); assert.equal(state.crossed[70], 1_000); assert.equal(state.crossed[90], 1_000);
	const settled = plain(renderFooter(f, 120, theme)).map((line) => line.slice(90));
	const mid = motionFrame(state, 1_200);
	assert.ok(mid.numeral, "rebuilding");
	const midRows = plain(renderFooter(f, 120, theme, mid));
	assert.match(midRows.join("\n"), / 254k\/272k /, "readout is current while the numeral resolves");
	assert.notDeepEqual(midRows.map((line) => line.slice(90)), settled);
	assert.equal(motionFrame(state, 1_500).numeral, undefined);
	assert.deepEqual(plain(renderFooter(f, 120, theme, { ...motionFrame(state, 1_500), pulse: null, cal: 0 })).map((line) => line.slice(90)), settled);
	// Retarget mid-transition: 350 ms, retaining only acquired colors that belong to the latest shape.
	f = session(null); state = advanceMotion(state, f, 1_200);
	assert.equal(state.numeral?.dur, 350);
	assert.ok(state.numeral!.from.g.flat().includes("graphic") || state.numeral!.from.g.flat().includes("high"));
	assert.equal(motionFrame(state, 1_550).numeral, undefined);
	assert.match(plain(renderFooter(f, 120, theme, motionFrame(state, 1_550))).join("\n"), /▐  ▀▀ +UNKNOWN/);
	// Unknown is never a crossing; no crossing is inferred through unknown.
	state = advanceMotion(state, session(95), 5_000);
	assert.notEqual(state.crossed[90], 5_000);
});

test("reconstruction immediately uses current geometry and pixel occupancy through width and Unknown changes", () => {
	let f = session(100), state = startMotion(f, 0, 4, false), now = 100;
	const pixels = (c: TestCell) => c.ch === "█" ? [true, true] : c.ch === "▀" ? [true, c.bg !== "field"] : c.ch === "▄" ? [c.bg !== "field", true] : [false, false];
	for (const percent of [0, 100, null, 93.3, 100, 41.8, null, -1, 150]) {
		f = session(percent); state = advanceMotion(state, f, now);
		const settled = grid(renderFooter(f, 120, theme)), targetRail = rail(settled[0]);
		for (const dt of [0, 50, 100]) {
			const frame = motionFrame(state, now + dt), actual = grid(renderFooter(f, 120, theme, frame));
			const actualRail = rail(actual[0]);
			assert.equal(actualRail.rootAt, targetRail.rootAt, `${percent}: current divider alignment immediately`);
			assert.equal(actualRail.badgeAt, targetRail.badgeAt, `${percent}: current caption alignment immediately`);
			for (let row = 3; row <= 5; row++) {
				const start = text(settled[row]).indexOf("▐") + 2, end = targetRail.badgeAt - 1;
				assert.deepEqual(actual[row].slice(start, end).map(pixels), settled[row].slice(start, end).map(pixels), `${percent} +${dt}: no old-only pixels or invented shape`);
			}
			assert.match(plain(renderFooter(f, 120, theme, frame)).join("\n"), new RegExp(` ${sessionReadout(percent).replace("?", "\\?")} `));
		}
		now += 100; // change again before the previous reconstruction settles
	}
	const unknown = session(null), boot = startMotion(unknown, 0, 9, true);
	const early = grid(renderFooter(unknown, 120, theme, motionFrame(boot, 400)));
	const late = grid(renderFooter(unknown, 120, theme, motionFrame(boot, 950)));
	assert.ok(early.slice(3, 6).flatMap((row) => row.slice(94, 107)).some((c) => "█▀▄".includes(c.ch) && c.fg === "secondary"), "Unknown reconstructs with a lighter grey before settling grey");
	assert.ok(late.slice(3, 6).flatMap((row) => row.slice(94, 107)).filter((c) => "█▀▄".includes(c.ch)).every((c) => c.fg === "graphic"));
});

test("re-strike plans: fresh random coverage, ROOT/AU about half the time, whole-plan shuffle with no fixed tail", () => {
	const f = session(41.8);
	const plans = [], unitStart = (items: readonly { zone?: string; key?: string; start: number }[]) => {
		const first = new Map<string, number>(), last = new Map<string, number>();
		for (const item of items) {
			const unit = item.zone === "plate" ? item.key! : item.zone === "digits" || item.zone === "labels" ? "panel" : item.zone!;
			first.set(unit, Math.min(first.get(unit) ?? Infinity, item.start)); last.set(unit, Math.max(last.get(unit) ?? -1, item.start));
		}
		return { first, last };
	};
	let root = 0, badge = 0, rootLeads = 0, badgeLeads = 0, rootTrails = 0, badgeTrails = 0;
	const tails = new Set<string>(), shapes = new Set<string>(), xs = { root: new Set<number>(), badge: new Set<number>() };
	for (let seed = 1; seed <= 400; seed++) {
		const items = strikeAt(f, seed).strike!.items as { fam: string; zone: string; key?: string; x: number; start: number }[];
		assert.ok(items.length > 0 && items.every((item) => item.fam === "restrike"), `seed ${seed}`);
		assert.ok(items.every((item) => item.key !== "main"), `seed ${seed}: no obsolete MN targets`);
		plans.push(items);
		shapes.add(JSON.stringify(items.map((item) => [item.zone, item.key, item.x, item.start])));
		const { first } = unitStart(items);
		if (first.has("root")) root++;
		if (first.has("badge")) badge++;
		for (const item of items) if (item.zone === "root" || item.zone === "badge") xs[item.zone].add(item.x);
		const order = [...first].sort((a, b) => a[1] - b[1]);
		if (order.length > 1 && first.has("root")) { if (order[0][0] === "root") rootLeads++; if (order.at(-1)![0] === "root") rootTrails++; }
		if (order.length > 1 && first.has("badge")) { if (order[0][0] === "badge") badgeLeads++; if (order.at(-1)![0] === "badge") badgeTrails++; }
		tails.add(order.at(-1)![0]);
	}
	assert.ok(root > 140 && root < 260, `ROOT in ${root}/400`); assert.ok(badge > 140 && badge < 260, `badge in ${badge}/400`);
	assert.ok(rootLeads > 10 && badgeLeads > 10 && rootTrails > 10 && badgeTrails > 10, JSON.stringify({ rootLeads, badgeLeads, rootTrails, badgeTrails }));
	assert.ok(tails.size >= 6, `tail units vary: ${[...tails]}`);
	assert.ok(shapes.size > 390, "every event draws a new plan");
	assert.deepEqual([...xs.root].sort(), [0, 1, 2, 3, 4, 5]); assert.deepEqual([...xs.badge].sort(), [0, 1, 2, 3, 4, 5, 6]);
	// Panel patches always anchor on occupied ink.
	for (let seed = 1; seed <= 400; seed++) {
		const s = strikeAt(f, seed), panel = s.strike!.items.filter((item: { zone: string }) => item.zone === "digits" || item.zone === "labels");
		if (!panel.length) continue;
		const settled = grid(renderFooter(f, 120, theme));
		const hits = panel.some((item: { zone: string; row: number; x: number }) => {
			const c = settled[2 + item.row][(item.zone === "digits" ? 96 : 110) + item.x];
			return c && c.ch !== " ";
		});
		assert.ok(hits, `seed ${seed}`);
	}
});

test("re-strike seed 279 retains a plate anchor, finite timing and no obsolete MN targets", () => {
	const f = session(), state = strikeAt(f, 279), event = state.strike!;
	assert.ok(event.items.length > 0);
	assert.ok(Number.isFinite(event.dur) && event.dur > 0);
	assert.ok(Number.isFinite(state.strikeAt) && Number.isFinite(nextMotionDelay(state, event.at)));
	assert.ok(event.items.every((item) => item.fam !== "restrike" || item.zone !== "plate" || String(item.key) !== "main"));
});

test("widened AU re-strikes cover every badge cell and stay inside the current badge after count changes", () => {
	for (const units of [100, 1234, Number.MAX_SAFE_INTEGER]) {
		const f = session(41.8, { working: true, units }), width = rail(grid(renderFooter(f, 120, theme))[0]).badge.length;
		const covered = new Set<number>();
		let tail: MotionState | undefined;
		for (let seed = 1; seed <= 400; seed++) {
			const state = strikeAt(f, seed);
			for (const item of state.strike!.items) if (item.fam === "restrike" && item.zone === "badge") {
				assert.ok(item.x >= 0 && item.x < width);
				covered.add(item.x);
				if (item.x === width - 1) tail = state;
			}
		}
		assert.deepEqual([...covered].sort((a, b) => a - b), Array.from({ length: width }, (_, i) => i), `${units}: entire widened badge participates`);
		const event = tail!.strike!, items = event.items.filter((item) => item.fam === "restrike" && item.zone === "badge");
		for (const current of [null, 0, 3, 1234, Number.MAX_SAFE_INTEGER]) {
			const snapshot = session(41.8, { working: false, units: current });
			const baseline = grid(renderFooter(snapshot, 120, theme)), r = rail(baseline[0]);
			for (let k = 0; k < event.dur; k++) {
				const actual = grid(renderFooter(snapshot, 120, theme, { ...SETTLED_FRAME, strike: { k, items } }));
				actual.forEach((row, y) => row.forEach((cell, x) => {
					if (y === 0 && x >= r.badgeAt && x < r.badgeAt + r.badge.length) {
						if (baseline[y][x].ch !== " ") assert.equal(cell.ch, baseline[y][x].ch, "latest count/label stays exact");
					} else assert.deepEqual(cell, baseline[y][x], "old wide targets never escape the current badge");
				}));
			}
		}
	}
});

test("re-strikes and ghosts touch only plates, panel ink, ROOT/AU and free frame cells; readable and fully recovered", () => {
	let struck = { root: 0, badge: 0, plate: 0, panel: 0, ghost: 0 };
	for (const [percent, units, working] of [[41.8, 3, true], [0, 0, false], [null, null, true], [100, 12, false], [93.3, 99, true]] as const) {
		const f = session(percent, { working, units });
		const settledLines = renderFooter(f, 120, theme), settled = grid(settledLines), r0 = rail(settled[0]), divider = plain(settledLines)[2].indexOf("▐");
		const protectedCols = new Set<number>([r0.rootAt - 3, r0.rootAt - 2, r0.rootAt - 1, ...Array.from({ length: 13 }, (_, i) => r0.rootAt + 6 + i), r0.badgeAt - 1, r0.badgeAt + 7]);
		for (let seed = 1; seed <= 60; seed++) {
			const s = strikeAt(f, seed);
			for (const event of [s.strike!, s.ghost].filter(Boolean)) {
				for (let k = 0; k < event!.dur; k++) {
					const frame = { ...motionFrame(s, event!.at + k * MOTION_TICK_MS), pulse: null, cal: 0, glitch: undefined };
					const out = grid(renderFooter(f, 120, theme, frame));
					out.forEach((row, r) => row.forEach((c, col) => {
						const base = settled[r][col];
						if (c.ch === base.ch && c.fg === base.fg && c.bg === base.bg) return;
						const where = `${percent}/${units} seed ${seed} k ${k} r${r}c${col} ${JSON.stringify(base)}→${JSON.stringify(c)}`;
						const inRoot = r === 0 && col >= r0.rootAt && col < r0.rootAt + 6, inBadge = r === 0 && col >= r0.badgeAt && col < r0.badgeAt + 7;
						const inPlate = r >= 1 && col >= 2 && col < 10 && base.bg !== "field";
						const inPanel = r >= 2 && r <= 4 && col >= divider + 2 && base.ch !== " ";
						const free = base.ch === " " && base.bg !== "default" || "┏┓┗┛━┃".includes(base.ch);
						assert.ok(!(r === 0 && protectedCols.has(col)), `lamp, separator, unit marks and margins are protected: ${where}`);
						assert.ok(!((r === 3 || r === 4) && col >= 11 && col <= divider), `gauge, readout, scale and divider are protected: ${where}`);
						if (inRoot || inBadge || inPlate || inPanel) {
							if (base.ch !== " ") {
								assert.equal(c.ch, base.ch, `characters stay exact: ${where}`);
								assert.ok(contrast(c.fg, c.bg) >= 4.5 || "█▀▄".includes(c.ch), `lettering contrast: ${where}`);
							}
							if (inRoot) struck.root++; else if (inBadge) struck.badge++; else if (inPlate) struck.plate++; else struck.panel++;
						} else {
							assert.ok(free, `only free cells change outside surfaces: ${where}`);
							struck.ghost++;
						}
					}));
				}
				// Eventual full recovery.
				const after = { ...motionFrame(s, event!.at + event!.dur * MOTION_TICK_MS), pulse: null, cal: 0, glitch: undefined };
				assert.ok(!after.strike || after.strike.items !== event!.items || event === s.ghost);
			}
			const end = Math.max(s.strike!.at + s.strike!.dur * MOTION_TICK_MS, s.ghost ? s.ghost.at + s.ghost.dur * MOTION_TICK_MS : 0);
			assert.deepEqual(plain(renderFooter(f, 120, theme, { ...motionFrame(s, end), pulse: null, cal: 0, glitch: undefined })), plain(settledLines), "recovers to the current baseline");
		}
	}
	for (const [surface, count] of Object.entries(struck)) assert.ok(count > 0, `${surface} was struck`);
	// Ghosts alone never alter any activity cell, readout padding, gauge or plate.
	for (const [percent, units] of [[41.8, 3], [null, null], [0, 0]] as const) {
		const f = session(percent, { working: true, units }), settled = grid(renderFooter(f, 120, theme)), r0 = rail(settled[0]);
		for (let seed = 1; seed <= 80; seed++) {
			const s = strikeAt(f, seed);
			if (!s.ghost) continue;
			for (let k = 0; k < s.ghost.dur; k++) {
				const out = grid(renderFooter(f, 120, theme, { ...motionFrame(s, s.ghost.at + k * MOTION_TICK_MS), strike: undefined, pulse: null, cal: 0, glitch: undefined }));
				for (let col = r0.rootAt - 3; col <= r0.badgeAt + 7; col++) assert.deepEqual(out[0][col], settled[0][col], `seed ${seed} col ${col}`);
				for (const r of [2, 3, 4, 5, 6]) assert.deepEqual(out[r].slice(2, 10), settled[r].slice(2, 10), `plates untouched by ghosts, row ${r}`);
				assert.deepEqual(out[3].slice(11, 94), settled[3].slice(11, 94));
			}
		}
	}
	// Zero and Unknown badges visibly change and stay readable.
	for (const units of [0, null]) {
		const f = session(41.8, { working: false, units });
		let seen = false;
		for (let seed = 1; seed <= 200 && !seen; seed++) {
			const s = strikeAt(f, seed);
			if (!s.strike!.items.some((item: { zone: string }) => item.zone === "badge")) continue;
			for (let k = 0; k < s.strike!.dur; k++) {
				const badge = rail(grid(renderFooter(f, 120, theme, { ...motionFrame(s, s.strike!.at + k * MOTION_TICK_MS), pulse: null }))[0]).badge;
				if (badge.some((c, i) => c.bg !== (units === 0 ? "surface" : "plate") || c.ch !== (units === 0 ? " 00 AU " : "  ? AU ")[i])) seen = true;
				for (const c of badge) if (/[0-9?AU]/.test(c.ch)) assert.ok(contrast(c.fg, c.bg) >= 4.5, `${units}: ${JSON.stringify(c)}`);
			}
		}
		assert.ok(seen, `${units} badge visibly re-strikes`);
	}
});

test("live geometry and values during events: changed context, counts and Working/Idle are reflected immediately", () => {
	for (let seed = 1; seed <= 40; seed++) {
		const s = strikeAt(session(41.8), seed), t = s.strike!.at + 2 * MOTION_TICK_MS, frame = { ...motionFrame(s, t), pulse: null };
		for (const [percent, units, working] of [[100, 12, false], [null, 99, true], [0, 0, false], [41.8, null, true]] as const) {
			const f = session(percent, { working, units }), lines = renderFooter(f, 120, theme, frame), out = plain(lines);
			const r = rail(grid(lines)[0]);
			assert.equal(r.rootAt + 5, out[2].indexOf("▐"), `seed ${seed}: ROOT follows the divider`);
			assert.equal(text(r.root).slice(1, 5), "ROOT");
			assert.equal(text(r.badge).replace(/[▓▚▞░]/g, " "), { 12: " 12 AU ", 99: " 99 AU ", 0: " 00 AU ", null: "  ? AU " }[String(units)]);
			assert.equal(r.lamp.bg, working ? "primary" : "surface");
			assert.match(out[3], new RegExp(` ${sessionReadout(percent).replace("?", "\\?")} `));
		}
	}
	// Panel re-strikes wait for a settled numeral.
	let f = session(41.8);
	for (let seed = 1; seed <= 80; seed++) {
		let s = strikeAt(f, seed);
		if (!s.strike!.items.some((item: { zone: string }) => item.zone === "digits")) continue;
		f = session(93.3); s = advanceMotion(s, f, s.strike!.at);
		const frame = { ...motionFrame(s, s.strike!.at + 50), pulse: null };
		assert.ok(frame.numeral);
		const noStrike = renderFooter(f, 120, theme, { ...frame, strike: undefined, ghosts: undefined });
		assert.deepEqual(plain(renderFooter(f, 120, theme, frame)).slice(2, 5).map((line) => line.slice(94)), plain(noStrike).slice(2, 5).map((line) => line.slice(94)));
		break;
	}
});

test("activity lamp and unit marks: Working blinks 500/300 ms, Idle is static dim, motion off is static", () => {
	const lampAt = (working: boolean, pulse: number | null) => rail(grid(renderFooter(session(41.8, { working, units: 3 }), 120, theme, { ...SETTLED_FRAME, pulse }))[0]).lamp.bg;
	assert.deepEqual(Array.from({ length: 16 }, (_, k) => lampAt(true, k)), [...Array(10).fill("primary"), ...Array(6).fill("surface")]);
	assert.ok(Array.from({ length: 32 }, (_, k) => lampAt(false, k)).every((c) => c === "surface"));
	assert.equal(lampAt(true, null), "primary"); assert.equal(lampAt(false, null), "surface");
	const marks = (units: number, pulse: number | null) => rail(grid(renderFooter(session(41.8, { working: false, units }), 120, theme, { ...SETTLED_FRAME, pulse }))[0]).marks;
	assert.equal(new Set(Array.from({ length: 40 }, (_, k) => marks(3, k))).size > 1, true, "marks shuttle while units run, even when Idle");
	assert.equal(new Set(Array.from({ length: 40 }, (_, k) => marks(0, k))).size, 1, "no invented motion at zero");
	for (let k = 0; k < 40; k++) assert.equal(marks(3, k).replace(/·/g, "").length, 3, "each visible unit keeps exactly one mark");
	assert.equal(marks(3, null), "█·█·█·······");
});

test("cadence: re-strikes every 4–6 s start-to-start and ghosts after their event plus 2.2–4.2 s, Working and Idle", () => {
	for (const working of [true, false]) {
		for (const seed of [1, 2, 3]) {
			const f = session(41.8, { working, units: 3 }), strikes: number[] = [], ghosts: { at: number; dur: number }[] = [];
			simulate(f, seed, 90_000, (state) => {
				if (state.strike && strikes.at(-1) !== state.strike.at) strikes.push(state.strike.at);
				if (state.ghost && ghosts.at(-1)?.at !== state.ghost.at) ghosts.push(state.ghost);
			});
			assert.ok(strikes[0] >= 31 * MOTION_TICK_MS && ghosts[0].at >= 31 * MOTION_TICK_MS, "nothing during boot");
			const gaps = strikes.slice(1).map((t, i) => t - strikes[i]);
			assert.ok(gaps.length >= 14 && gaps.every((gap) => gap >= 4_000 && gap <= 6_000), `${working}/${seed}: ${gaps}`);
			const waits = ghosts.slice(1).map((g, i) => g.at - ghosts[i].at - ghosts[i].dur * MOTION_TICK_MS);
			assert.ok(waits.every((wait) => wait >= 2_200 && wait <= 4_200), `${waits}`);
		}
	}
});

test("motion schedule wakes only for the next visible decoration step or due event", () => {
	const wakes: number[] = [];
	for (const activity of [{ working: true, units: 3 }, { working: false, units: 0 }]) {
		const f = session(0, activity);
		let count = 0;
		simulate(f, 5, 20_000, (state, now) => {
			const delay = nextMotionDelay(state, now);
			assert.ok(delay >= 1, `${now}: ${delay}`);
			const key = (s: MotionState, t: number) => JSON.stringify({ ...motionFrame(s, t), pulse: activity.working || activity.units ? motionFrame(s, t).pulse : 0 }, (k, v) => (k === "items" || k === "from" ? undefined : v));
			const later = advanceMotion(state, f, now + delay);
			assert.ok(key(later, now + delay) !== key(state, now) || later !== state, `${now}: wakes for a change`);
			count++;
		});
		wakes.push(count);
	}
	assert.ok(wakes[1] < wakes[0] && wakes[1] < 20 * 15, `Idle wakes less than Working: ${wakes}`);
	// Settled and Idle: sleep straight to the next ┼ nudge or due event, never poll at the tick rate.
	const quiet = session(0, { working: false, units: 0 });
	let checked = 0;
	simulate(quiet, 8, 40_000, (state, now) => {
		const tick = Math.floor((now - state.epoch) / MOTION_TICK_MS);
		if (state.boot || state.numeral || state.wipe || state.glitch || state.ghost || state.strike || tick % 120 < 6) return;
		const nudge = state.epoch + (Math.floor(tick / 120) + 1) * 120 * MOTION_TICK_MS;
		assert.equal(nextMotionDelay(state, now), Math.max(1, Math.ceil(Math.min(nudge, state.ghostAt, state.strikeAt) - now)), `${now}`);
		checked++;
	});
	assert.ok(checked > 5);
});

test("glitch is fill-only: never the readout, the fill edge, unlit track or unknown", () => {
	for (const percent of [5, 41.8, 76.4, 93.3, 100, 0, null]) {
		const f = session(percent), lit = percent ? Math.ceil(percent * 60 / 100) : 0, span = sessionReadout(percent).length + 2;
		const base = grid(renderFooter(f, 120, theme))[4].slice(11, 71);
		for (let seed = 0; seed < 60; seed++) {
			const gauge = grid(renderFooter(f, 120, theme, { ...SETTLED_FRAME, glitch: { level: 3, seed } }))[4].slice(11, 71);
			gauge.forEach((c, i) => {
				if (c.ch === base[i].ch && c.bg === base[i].bg && c.fg === base[i].fg) return;
				assert.ok(i >= span && i < lit - 1, `${percent} seed ${seed} cell ${i}`);
			});
		}
	}
});

const ponytailStates = ["lite", "full", "ultra", "off", "review", "checking", "unknown"] as const;
const ponytailCodes = ["LTE", "FUL", "ULT", "OFF", "REV", "CHK", "UNK"];
const ponytailInks = ["rgb(0,79,232)", "violet", "rgb(192,0,146)", "plate", "rgb(0,110,112)", "plate", "plate"];
// Anchored on the title: the icon cell (index 2) may show the activity light instead of ⌑.
function ponytailCells(lines: string[]) {
	const row = grid(lines).find((cells) => text(cells).includes(" PNYTL //"));
	assert.ok(row);
	const start = text(row).indexOf(" PNYTL //") - 3;
	return row.slice(start, start + 18);
}

test("PNYTL activity light: icon alternates with a pink • at 200/200 ms only while Ponytail reports activity; motion off holds it lit", () => {
	const icon = (snapshot: FooterSnapshot, frame?: FooterFrame) => { const c = ponytailCells(renderFooter(snapshot, 120, theme, frame))[2]; return [c.ch, c.fg, c.bg]; };
	const idle: FooterSnapshot = { ...session(), ponytail: "full", ponytailActive: false }, active: FooterSnapshot = { ...idle, ponytailActive: true };
	const at = (pulse: number | null): FooterFrame => ({ ...SETTLED_FRAME, pulse });
	for (let pulse = 0; pulse < 32; pulse++) {
		assert.deepEqual(icon(active, at(pulse)), pulse % 8 < 4 ? ["•", "pink", "text"] : ["⌑", "field", "text"], `pulse ${pulse}: four 50 ms ticks lit, four unlit`);
		assert.deepEqual(icon(idle, at(pulse)), ["⌑", "field", "text"], "idle never lights");
	}
	assert.deepEqual(icon(active), ["•", "pink", "text"], "motion off holds the light on, like ROOT");
	for (const ponytail of ["lite", "ultra", "review"] as const) assert.deepEqual(icon({ ...active, ponytail }, at(0)), ["•", "pink", "text"], ponytail);
	// Only a confirmed enabled mode lights; OFF, CHK and UNK keep the static icon.
	for (const ponytail of ["off", "checking", "unknown"] as const) for (const pulse of [0, null]) assert.deepEqual(icon({ ...active, ponytail }, at(pulse)), ["⌑", "field", "text"], ponytail);
	// Same 18 cells; only the icon cell changes, at every layout.
	for (const width of [30, 48, 100, 120, 280]) {
		const on = ponytailCells(renderFooter(active, width, theme, at(0))), off = ponytailCells(renderFooter(idle, width, theme, at(0)));
		assert.equal(text(on), `  • PNYTL // FUL  `); assert.equal(text(off), `  ⌑ PNYTL // FUL  `);
		assert.deepEqual(on.filter((_, i) => i !== 2), off.filter((_, i) => i !== 2), `${width}: rest of the plate unchanged`);
		assert.ok(renderFooter(active, width, theme, at(0)).every((line) => visibleWidth(line) <= width));
	}
	// The scheduler wakes for every light change: 400 ms per blink, 2.5 a second, under three, faster than ROOT's 800 ms.
	const quiet: FooterSnapshot = { ...active, activity: { working: false, units: 0 } };
	let state = startMotion(quiet, 0, 5, false), now = 0, last: boolean | undefined;
	const onsets: number[] = [];
	while (now <= 10_000) {
		state = advanceMotion(state, quiet, now);
		const lit = icon(quiet, motionFrame(state, now))[0] === "•";
		if (lit && last === false) onsets.push(now);
		last = lit; now += nextMotionDelay(state, now);
	}
	assert.ok(onsets.length >= 24 && onsets.slice(1).every((t, i) => t - onsets[i] === 400), `${onsets.slice(0, 6)}`);
	for (const t of onsets) assert.ok(onsets.filter((u) => u >= t && u < t + 1000).length <= 3, "at most three flashes in any second");
	// Activity changes are tracked without disturbing other decoration memory.
	const s0 = startMotion(idle, 0, 5, false), s1 = advanceMotion(s0, active, 10);
	assert.equal(s0.ponytailActive, false); assert.equal(s1.ponytailActive, true); assert.equal(s1.ponytailBurst, undefined, "activity is not a mode change");
	assert.equal(advanceMotion(s1, active, 10), s1);
});

test("PNYTL: seven exact codes/inks on a static white 16-cell body, optional compatibility and native color conversion", () => {
	assert.equal(visibleWidth("⌑"), 1);
	for (const [i, ponytail] of ponytailStates.entries()) {
		const f = { ...session(), ponytail };
		for (const width of [30, 48, 80, 100, 120, 280]) {
			const lines = renderFooter(f, width, theme), cells = ponytailCells(lines);
			assert.equal(text(cells), `  ⌑ PNYTL // ${ponytailCodes[i]}  `);
			assert.ok(cells.slice(1, 17).every((c) => c.bg === "text" && c.bold));
			assert.ok(cells.filter((_, j) => j < 13 || j > 15).every((c, j) => c.bg !== "text" || c.fg === "field"));
			assert.deepEqual(cells.slice(13, 16).map((c) => c.fg), Array(3).fill(ponytailInks[i]));
			assert.equal(cells[0].bg, "field"); assert.equal(cells[17].bg, "field");
			const indexed = renderFooter(f, width, hostTheme("256color"));
			assert.deepEqual(plain(indexed), plain(lines));
			assert.doesNotMatch(indexed.join(""), /\x1b\[(38|48);2;/);
		}
	}
	assert.doesNotMatch(rows(session()).join(""), /PNYTL/);
	for (const hex of ["#004fe8", "#5200ff", "#c00092", "#006e70", "#555555"]) {
		const ink = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
		assert.ok(1.05 / (luminance(ink) + 0.05) >= 5.74, hex);
	}
});

test("PNYTL layout: on the numeral's digit column (else right-aligned), model row or continuation before EXT, no truncation at widths 1..280", () => {
	for (const long of [false, true]) for (const ponytail of ponytailStates) {
		const f = { ...session(), ponytail };
		f.model = { ...f.model!, id: long ? "模型👩‍💻" + "long-model-".repeat(10) + "\x1b[2Jend" : "model" };
		f.statuses = new Map([["ponytail", "\x1b[31mPonytail: ready\x1b[0m"], ["z", "status-".repeat(15)]]);
		for (let width = 1; width <= 280; width++) {
			const lines = renderFooter(f, width, theme), out = plain(lines), joined = out.join("").replace(/[\s┃┗┛━┏┓┼]/g, "");
			assert.ok(lines.every((line: string) => visibleWidth(line) <= width), `${width}/${ponytail}`);
			assert.doesNotMatch(lines.join(""), /\x1b\[2J/);
			assert.ok(joined.includes(`⌑PNYTL//${ponytailCodes[ponytailStates.indexOf(ponytail)]}`), `${width}: indicator lost`);
			assert.ok(joined.includes("Ponytail:ready") && joined.includes("status-".repeat(15)), `${width}: EXT lost`);
			if (width >= 40) {
				const mdl = out.findIndex((line: string) => line.includes("03 MDL")), pnytl = out.findIndex((line: string) => line.includes("PNYTL")), ext = out.findIndex((line: string) => line.includes("04 EXT"));
				assert.ok(pnytl >= mdl && pnytl < ext);
				// Beside the numeral the white body starts on the digits' first column (spine + 2); otherwise it right-aligns.
				const G = width >= 60 ? 2 : 1, column = (line: string, ch: string) => visibleWidth(line.slice(0, line.indexOf(ch)));
				const numeralRow = out.find((line: string) => line.includes("▐")), body = numeralRow ? column(numeralRow, "▐") + 2 : width - G - 17;
				assert.equal(column(out[pnytl], "⌑") - 1, body, `${width}/${long}: plate column`);
				const natural = visibleWidth(`openai-codex/${safeText(f.model.id)} · thinking xhigh`);
				assert.equal(pnytl === mdl, natural <= body - G - 10, `${width}/${long}: same row only when the model reaches no further than the left gap`);
				if (!long) {
					// One black gap each side; the band fills before and, beside the numeral, after the plate.
					const cells = grid(lines)[pnytl];
					assert.deepEqual([cells[body - 1].bg, cells[body + 16].bg], ["field", "field"], `${width}: gaps`);
					assert.ok(cells.slice(body, body + 16).every((c) => c.bg === "text"), `${width}: white body`);
					assert.ok(cells.slice(G + 8, body - 1).every((c) => c.bg === "surface") && cells.slice(body + 17, width - G).every((c) => c.bg === "surface"), `${width}: band`);
					assert.equal(cells.slice(body + 17, width - G).length > 0, !!numeralRow, `${width}: band extends only beside the numeral`);
				}
			}
			if (width >= 3) assert.ok(joined.includes(safeText(f.model.id)), `${width}: model lost`);
		}
	}
	// The plate follows the digits when the numeral widens (100%+) and through Unknown.
	for (const percent of [0, 41.8, 100, 150, null]) for (const width of [120, 280]) {
		const out = rows({ ...session(percent), ponytail: "full" }, width), spine = out.find((line) => line.includes("▐"))!;
		assert.equal(out.find((line) => line.includes("⌑"))!.indexOf("⌑") - 1, spine.indexOf("▐") + 2, `${percent}@${width}`);
	}
	const f = { ...session(), ponytail: "full" as const, statuses: new Map() };
	for (const width of [30, 48, 100, 120, 280]) {
		const out = rows(f, width).join("\n");
		assert.match(out, /PNYTL \/\/ FUL/); assert.doesNotMatch(out, /04 EXT/);
		if (width >= 40) assert.match(out.split("\n").at(-1)!, /┛$/);
	}
});

test("PNYTL random plans: deterministic seed, varying nonempty subsets, only three foregrounds change and no ambient/boot overlay", () => {
	const f = { ...session(), ponytail: "lite" as const };
	const changed = { ...f, ponytail: "full" as const };
	const plans = new Set<string>(), firsts = new Set<number>();
	for (let seed = 1; seed <= 24; seed++) {
		let s = startMotion(f, 0, seed, false);
		s = advanceMotion(s, changed, 1000);
		assert.deepEqual(s, advanceMotion(startMotion(f, 0, seed, false), changed, 1000));
		const masks = s.ponytailBurst!.masks;
		assert.ok(masks.every((mask: number) => mask >= 1 && mask <= 7));
		assert.notEqual(masks[0], masks[1]); plans.add(masks.join()); firsts.add(masks[0]);
		const settled = ponytailCells(renderFooter(changed, 120, theme));
		for (let elapsed = 0; elapsed <= 500; elapsed += 50) {
			s = advanceMotion(s, changed, 1000 + elapsed);
			const frame = motionFrame(s, 1000 + elapsed);
			for (const width of [30, 48, 100, 120, 280]) {
				const cells = ponytailCells(renderFooter(changed, width, theme, frame));
				assert.equal(text(cells), text(settled), "no stale/scrambled characters");
				cells.forEach((c, i) => {
					if (i < 13 || i > 15) assert.deepEqual(c, settled[i], `${seed}/${elapsed}/${i}: fixed plate`);
					else { assert.deepEqual({ ...c, fg: settled[i].fg }, settled[i]); assert.ok(["field", "violet"].includes(c.fg)); }
				});
			}
		}
	}
	assert.ok(plans.size > 10); assert.equal(firsts.size, 7, "no forced left-first acquisition");
	for (const ponytail of ponytailStates) {
		const current = { ...f, ponytail }, settled = ponytailCells(renderFooter(current, 120, theme));
		simulate(current, 17, 20_000, (s, now) => {
			assert.deepEqual(ponytailCells(renderFooter(current, 120, theme, motionFrame(s, now))), settled, `${ponytail}/${now}: no ambient or boot effects`);
		});
		if (["off", "checking", "unknown"].includes(ponytail)) {
			const s = advanceMotion(startMotion(f, 0, 2, false), current, 1000);
			assert.equal(s.ponytailBurst, undefined);
			assert.deepEqual(ponytailCells(renderFooter(current, 120, theme, { ...SETTLED_FRAME, ponytailMask: 7 })), settled);
		}
	}
});

test("PNYTL motion guard: rapid interruption, repeated redraws, same-mode refresh, late recovery and resume do not replay flashes", () => {
	let f: FooterSnapshot = { ...session(), ponytail: "lite" }, s = startMotion(f, 0, 12, false);
	f = { ...f, ponytail: "ultra" }; s = advanceMotion(s, f, 1000);
	assert.ok(s.ponytailBurst);
	s = advanceMotion(s, f, 1100); assert.ok(motionFrame(s, 1100).ponytailMask);
	for (let n = 0; n < 100; n++) assert.equal(advanceMotion(s, f, 1100), s);
	f = { ...f, ponytail: "review" }; s = advanceMotion(s, f, 1150);
	assert.equal(s.ponytailBurst, undefined, "interrupt settles instead of restarting");
	for (let now = 1200; now < 2800; now += 50) {
		f = { ...f, ponytail: now % 100 ? "lite" : "full" }; s = advanceMotion(s, f, now);
		assert.equal(s.ponytailBurst, undefined);
	}
	// A refresh back to the same confirmed mode never flashes, even after the guard.
	f = { ...f, ponytail: "checking" }; s = advanceMotion(s, f, 4000);
	f = { ...f, ponytail: "lite" }; s = advanceMotion(s, f, 4300);
	assert.equal(s.ponytailBurst, undefined);
	f = { ...f, ponytail: "review" }; s = advanceMotion(s, f, 5000);
	s = advanceMotion(s, f, 5100); assert.ok(motionFrame(s, 5100).ponytailMask);
	s = advanceMotion(s, f, 9000); assert.equal(s.ponytailBurst, undefined, "late wake skips missed frames");
	assert.ok(s.ponytailGuardUntil >= 10100, "late recovery reserves quiet time from actual wake");
	f = { ...f, ponytail: "ultra" }; s = advanceMotion(s, f, 9100); assert.equal(s.ponytailBurst, undefined);
	const resumed = startMotion(f, 9200, 3, false, s.ponytailGuardUntil);
	assert.equal(resumed.ponytailBurst, undefined);
	assert.equal(advanceMotion(resumed, { ...f, ponytail: "full" }, 9250).ponytailBurst, undefined);
	assert.equal(motionFrame(resumed, 9300).ponytailMask, undefined);
});

test("PNYTL rolling one-second pulse budget stays at most two per letter under normal and rapid changes", () => {
	for (const period of [50, 150, 400, 1800, 2300]) for (let seed = 1; seed <= 8; seed++) {
		let f: FooterSnapshot = { ...session(), ponytail: "lite" }, s = startMotion(f, 0, seed, false), previous = 0;
		const flashes: number[][] = [[], [], []];
		for (let now = 0; now <= 20000; now += 50) {
			if (now % period === 0) f = { ...f, ponytail: ponytailStates[(now / period) % 5] };
			s = advanceMotion(s, f, now);
			const mask = motionFrame(s, now).ponytailMask ?? 0;
			for (let i = 0; i < 3; i++) {
				if ((previous & (1 << i)) && !(mask & (1 << i))) flashes[i].push(now);
				assert.ok(flashes[i].filter((at) => at > now - 1000).length <= 2, `${period}/${seed}/${now}/${i}`);
			}
			previous = mask;
		}
	}
});

test("PNYTL transition frames stay width-safe at every width 1..280 and leave unrelated inline cells unchanged", () => {
	const before = { ...session(), ponytail: "lite" as const }, after = { ...before, ponytail: "full" as const };
	for (const seed of [1, 2, 7]) {
		let s = advanceMotion(startMotion(before, 0, seed, false), after, 1000);
		for (const now of [1000, 1100, 1200, 1350, 1450]) {
			s = advanceMotion(s, after, now); const frame = motionFrame(s, now);
			for (let width = 1; width <= 280; width++) {
				const lines = renderFooter(after, width, theme, frame);
				assert.ok(lines.every((line: string) => visibleWidth(line) <= width), `${seed}/${now}/${width}`);
				assert.ok(plain(lines).join("").replace(/[\s┃┗┛━┏┓┼]/g, "").includes("⌑PNYTL//FUL"));
			}
			for (const width of [100, 120, 280]) {
				const absent = { ...after, ponytail: undefined };
				const baseline = grid(renderFooter(absent, width, theme, frame)), current = grid(renderFooter(after, width, theme, frame));
				assert.equal(current.length, baseline.length);
				current.forEach((row, y) => {
					const indicator = text(row).indexOf("⌑") - 2;
					row.forEach((cell, x) => { if (indicator < 0 || x < indicator || x >= indicator + 18) assert.deepEqual(cell, baseline[y][x], `${width}/${now}/${x},${y}: unrelated field changed`); });
				});
			}
		}
	}
});


test("linked-worktree footer (branch-only or directory first) and PNYTL coexist through mode changes and wrapping", () => {
	const f = fixture();
	f.activePath = "/Users/example/" + "parent-".repeat(8) + "/" + "current-".repeat(8);
	repository(f).active.branch = "feat/" + "footer/ponytail/".repeat(4);
	repository(f).main!.path = "/hidden-primary-checkout";
	repository(f).main!.branch = "hidden-primary-branch";
	repository(f).mainUnavailableReason = "hidden-primary-unavailable";
	const unnamed: FooterSnapshot = { ...f, workspace: { ...f.workspace!, github: { kind: "none", reason: "No GitHub remote" } } };
	const check = (snapshot: FooterSnapshot, width: number, frame: FooterFrame) => {
		const named = snapshot.workspace?.github.kind === "repository", label = `${snapshot.ponytail}/${named}@${width}`;
		const lines = renderFooter(snapshot, width, theme, frame), out = content(lines);
		assert.ok(lines.every((line: string) => visibleWidth(line) <= width), label);
		assert.doesNotMatch(out, /MN|hidden-primary|https:|github\.com/);
		assert.ok(out.includes(`⌑PNYTL//${ponytailCodes[ponytailStates.indexOf(snapshot.ponytail!)]}`));
		assert.ok(out.includes("CMP×12") && out.includes("ROOT"));
		assert.equal(out.includes("PR#42"), named, `${label}: PR only with a repository`);
		assert.ok(out.replace(/[▓▚▞░]/g, "").includes("03AU"), "AU remains exact through padding textures");
		assert.ok(out.includes("Otherstatus") && out.includes("Ponytail:ready"), "unrecognized Ponytail status and other keys stay in EXT");
		assert.ok(out.includes("feat/" + "footer/ponytail/".repeat(4)) && out.includes("modified"));
		const path = "parent-".repeat(8) + "/" + "current-".repeat(8);
		if (named) assert.ok(!out.includes(path), `${label}: the branch replaces the path`);
		else assert.ok(out.includes(path) && out.indexOf(path) < out.indexOf("⑂"), `${label}: complete directory before Git details`);
		if (width >= 40) {
			const rows = grid(lines), forkRow = rows.findIndex((row) => text(row).includes("⑂"));
			const { G, P } = metrics(width);
			if (named) assert.equal(text(rows[forkRow].slice(G, G + P)), " 01 ACT ", `${label}: the branch sits on the ACT row`);
			else assert.ok(rows[forkRow].slice(G, G + P).every((c) => c.ch === " " && c.bg === "field"), "Git details have no ACT continuation plate");
		}
	};
	for (const snapshot of [f, unnamed]) for (const ponytail of ponytailStates) for (let width = 3; width <= 160; width++) check({ ...snapshot, ponytail }, width, SETTLED_FRAME);
	const before = { ...f, ponytail: "lite" as const }, after = { ...f, ponytail: "full" as const };
	const state = advanceMotion(startMotion(before, 0, 279, false), after, 1000);
	assert.ok(state.ponytailBurst, "real mode transition remains active with the retained plate anchor fix");
	const frames = [...eventFrames(after), ...[1000, 1100, 1200, 1350, 1450].map((now) => motionFrame(state, now))];
	for (let width = 3; width <= 160; width++) for (const frame of frames) for (const snapshot of [after, { ...unnamed, ponytail: "full" as const }]) check(snapshot, width, frame);
});
