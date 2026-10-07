import { basename, dirname, isAbsolute, relative, sep } from "node:path";
import type { ContextUsage, Theme } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, foregroundAnsi, rgbColor, stripTerminalSequences, sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { UsageProviderId, UsageWindow, UsageWindows } from "./usage.ts";
import type { CheckoutInfo, PullRequestInfo, WorkspaceInfo } from "./workspace.ts";

/** Confirmed producer modes, distinct from checking/unavailable display state. */
export type PonytailMode = "off" | "lite" | "full" | "ultra" | "review";
export type PonytailState = PonytailMode | "checking" | "unknown";
/** Root session state and native active-work units. Absent activity or null units are unknown, never zero. */
export type FooterActivity = { working: boolean; units: number | null };
/** Last good CodexBar sample. `fetchedAt` is the adapter's wall-clock receipt time and identifies the sample. */
export type UsageSample = { windows: UsageWindows; updatedAt: number | null; fetchedAt: number };
/** Never fetched (neither field), the last good sample, and/or the latest fetch's failure. */
export type UsageProviderState = { provider: UsageProviderId; data?: UsageSample; failure?: "timeout" | "failed" };
/** Supplied only once CodexBar is known to be installed. `now` is wall-clock epoch ms from the adapter. */
export type FooterUsage = { now: number; providers: readonly UsageProviderState[] };
/** Minimal validated public Tatsu v1 data; no provider prose or identifiers. */
export type TatsuComponent = { component: "tatsu-cli" | "agent-workspace"; state: "inactive" | "checking" | "current" | "behind" | "repair" | "local_changes" | "missing" | "not_runnable" | "unavailable"; commitsBehind?: number; localChanges?: boolean };
export type TatsuSnapshot = { phase: "inactive" | "checking" | "completed"; components: readonly TatsuComponent[] };
const activeTatsu = (snapshot: FooterSnapshot) => snapshot.tatsu && snapshot.tatsu.phase !== "inactive" ? snapshot.tatsu : undefined;
const tatsuKey = (c: TatsuComponent) => `${c.state}/${c.commitsBehind ?? "?"}/${c.localChanges ?? "?"}`;
// A component's state: shape and short code, bold in the state colour (`ink`). Behind/repair append local edits.
const tatsuLook = (c: TatsuComponent): { shape: string; code: string; ink: Hue } => {
	const edit = c.localChanges === true ? " ◆ EDIT" : "";
	switch (c.state) {
		case "current": return { shape: "•", code: "OK", ink: "primary" };
		case "behind": return { shape: "▲", code: `UP${c.commitsBehind === undefined ? "" : `×${c.commitsBehind}`}${edit}`, ink: "warn" };
		case "repair": return { shape: "▲", code: `FIX${edit}`, ink: "warn" };
		case "local_changes": return { shape: "◆", code: "EDIT", ink: "warn" };
		case "missing": return { shape: "✕", code: "MISS", ink: "high" };
		case "not_runnable": return { shape: "✕", code: "NRUN", ink: "high" };
		case "unavailable": return { shape: "✕", code: "UNAV", ink: "high" };
		case "checking": return { shape: "·", code: "CHK", ink: "graphic" };
		case "inactive": return { shape: "·", code: "OFF", ink: "graphic" };
	}
};
// Plain text per component, `TCLI <shape> <code>` (single-width glyphs), three field cells apart.
const TATSU_GAP = 3;
export type FooterSnapshot = {
	homePath: string;
	launchPath: string;
	activePath: string;
	workspace?: WorkspaceInfo;
	pullRequest: PullRequestInfo;
	contextUsage?: ContextUsage;
	model?: { id: string; provider: string; contextWindow: number };
	thinking: string;
	statuses: ReadonlyMap<string, string>;
	/** Active validated Tatsu status replaces only its EXT entry, at the same sorted key. */
	tatsu?: TatsuSnapshot;
	activity?: FooterActivity;
	/** Optional for renderer compatibility; the native adapter always supplies a state. */
	ponytail?: PonytailState;
	/** Ponytail's own activity dot (● while the agent runs a turn); lights the plate only with a confirmed enabled mode. */
	ponytailActive?: boolean;
	/** Successful persisted compactions on the selected branch. Absent, null or invalid is unknown, never zero. */
	compactions?: number | null;
	/** Pi's effective compaction reserve for the model; absent when auto-compaction is off or the setting is unusable. */
	compactionReserve?: number;
	/** Subscription usage windows; absent hides the USG row (CodexBar missing or not yet detected). */
	usage?: FooterUsage;
};
/** Pi's theme converts these concrete colors for truecolor or 256-color terminals. */
export type FooterTheme = Pick<Theme, "style" | "getColorMode">;

// Only SGR styling is permitted from extension statuses. Paths and repository
// metadata permit no terminal escapes at all (including OSC links and C1 CSI).
export function safeText(input: string, allowStyles = false): string {
	let result = "";
	for (let i = 0; i < input.length; i++) {
		const code = input.charCodeAt(i);
		if (code === 0x1b || (code >= 0x80 && code <= 0x9f)) {
			const start = i;
			const lead = code === 0x1b ? input[++i] : String.fromCharCode(code - 0x40);
			if (lead === "[") {
				while (++i < input.length && !/[\x40-\x7e]/.test(input[i])) {}
				const sequence = input.slice(start, i + 1);
				if (allowStyles && /^\x1b\[[0-9;:]*m$/.test(sequence)) {
					// Pi's wrapping state tracks semicolon SGR, not colon color forms.
					result += sequence
						.replace(/(^\x1b\[|;)(38|48):2:(?:(?:0)?:)?(\d+):(\d+):(\d+)(?=;|m)/g, "$1$2;2;$3;$4;$5")
						.replace(/(^\x1b\[|;)(38|48):5:(\d+)(?=;|m)/g, "$1$2;5;$3");
				}
			} else if (lead && "]PX^_".includes(lead)) {
				while (++i < input.length) {
					if (input.charCodeAt(i) === 0x9c || (lead === "]" && input[i] === "\x07")) break;
					if (input[i] === "\x1b" && input[i + 1] === "\\") { i++; break; }
				}
			}
			continue;
		}
		if (code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029) {
			result += " ";
		} else if (!/[\u202a-\u202e\u2066-\u2069]/.test(input[i])) {
			result += input[i];
		}
	}
	return result.trim();
}

// Checking's state-half background: a gentle triangle wave up from graphic grey; black text stays at least 4.3:1.
export const TATSU_CHECK_FADE_LEVELS = ["#717171", "#7b7b7b", "#868686", "#919191", "#9c9c9c", "#919191", "#868686", "#7b7b7b"] as const;
const tatsuFadeColors = TATSU_CHECK_FADE_LEVELS.map((hex) => {
	const level = parseInt(hex.slice(1, 3), 16);
	return rgbColor(level, level, level);
});
// Selected "01 — Acid / Black" palette. Fixed by design rather than taken from the host theme.
const C = {
	field: rgbColor(0x00, 0x00, 0x00),
	primary: rgbColor(0xc0, 0xfe, 0x04),
	text: rgbColor(0xff, 0xff, 0xff),
	secondary: rgbColor(0xcf, 0xcf, 0xcf),
	plate: rgbColor(0x55, 0x55, 0x55),
	surface: rgbColor(0x1c, 0x1c, 0x1c),
	warn: rgbColor(0xd7, 0x9e, 0x52),
	high: rgbColor(0xf2, 0x47, 0x23),
	graphic: rgbColor(0x71, 0x71, 0x71),
	checkLow: tatsuFadeColors[1], checkMid: tatsuFadeColors[2], checkHigh: tatsuFadeColors[3], checkPeak: tatsuFadeColors[4],
	warnDim: rgbColor(0x6c, 0x4f, 0x29), // Tatsu beacon, 50% amber over black
	// Tatsu warm-up steps, 25/50/75% of each state colour over the field (warn 50% is warnDim; grey reuses surface, plate).
	primary25: rgbColor(0x30, 0x40, 0x01), primary50: rgbColor(0x60, 0x7f, 0x02), primary75: rgbColor(0x90, 0xbe, 0x03),
	warn25: rgbColor(0x36, 0x28, 0x14), warn75: rgbColor(0xa1, 0x76, 0x3e),
	high25: rgbColor(0x3c, 0x12, 0x09), high50: rgbColor(0x79, 0x24, 0x12), high75: rgbColor(0xb6, 0x35, 0x1a),
	graphic50: rgbColor(0x38, 0x38, 0x38),
	cobalt: rgbColor(0x00, 0x4f, 0xe8), // PNYTL LTE
	magenta: rgbColor(0xc0, 0x00, 0x92), // PNYTL ULT
	teal: rgbColor(0x00, 0x6e, 0x70), // PNYTL REV
	violet: rgbColor(0x52, 0x00, 0xff), // CMP 1–2
	pink: rgbColor(0xff, 0x15, 0xbd), // CMP 3–4
	wz: rgbColor(0x2b, 0x20, 0x10), // 20% warning over the field
	hz: rgbColor(0x30, 0x0e, 0x07), // 20% high over the field
	// USG providers, from the new Marathon (GPT its white foreground token, CLD its "Signal orange" token, KMI a key-art
	// sample): lit, used (20% over the field) and burn-out mid (50%), for the pulse and burn-out frames.
	codex: rgbColor(0xff, 0xff, 0xff), codexUsed: rgbColor(0x33, 0x33, 0x33), codexMid: rgbColor(0x80, 0x80, 0x80),
	claude: rgbColor(0xff, 0x5c, 0x00), claudeUsed: rgbColor(0x33, 0x12, 0x00), claudeMid: rgbColor(0x80, 0x2e, 0x00),
	kimi: rgbColor(0x25, 0x55, 0xfc), kimiUsed: rgbColor(0x07, 0x11, 0x32), kimiMid: rgbColor(0x13, 0x2b, 0x7e),
	// A settled lost square, the same neutral grey for every provider.
	usageGhost: rgbColor(0x33, 0x33, 0x33),
};
type Hue = keyof typeof C;
const PONYTAIL: Record<PonytailState, { code: string; ink: Hue }> = {
	lite: { code: "LTE", ink: "cobalt" }, full: { code: "FUL", ink: "violet" }, ultra: { code: "ULT", ink: "magenta" },
	review: { code: "REV", ink: "teal" }, off: { code: "OFF", ink: "plate" },
	checking: { code: "CHK", ink: "plate" }, unknown: { code: "UNK", ink: "plate" },
};
const confirmedPonytail = (value: PonytailState | undefined): PonytailMode | undefined =>
	value === "checking" || value === "unknown" ? undefined : value;
const ponytailLit = (snapshot: FooterSnapshot) => snapshot.ponytailActive === true && confirmedPonytail(snapshot.ponytail) !== undefined && snapshot.ponytail !== "off";
const RESET = "\x1b[0m";

export type Tone = "ok" | "warn" | "high" | "unknown";
type Style = { fg?: Hue; bg?: Hue; bold?: boolean; underline?: boolean };
type PlateKey = "act" | "ctx" | "mdl" | "ext";
type Zone = "plate" | "digits" | "labels" | "root" | "badge";
// One terminal column of a renderer-owned glyph. `ghost` admits registration ghosts; `zone` admits re-strikes.
type Cell = Style & { ch: string; ghost?: boolean; frame?: boolean; zone?: Zone };
// Pre-styled untrusted text: never split into cells and never touched by decoration.
type Run = { run: string; width: number; scanWidth: number };
type Part = Cell | Run;
const isRun = (part: Part): part is Run => "run" in part;

const FILL: Record<Tone, Hue> = { ok: "primary", warn: "warn", high: "high", unknown: "graphic" };
const TRACK: Record<Tone, Hue> = { ok: "surface", warn: "wz", high: "hz", unknown: "surface" };
const NUM: Record<Tone, Hue> = { ok: "text", warn: "warn", high: "high", unknown: "graphic" };
const PLATE: Record<Tone, Style> = {
	ok: { fg: "field", bg: "primary", bold: true }, warn: { fg: "field", bg: "warn", bold: true },
	high: { fg: "field", bg: "high", bold: true }, unknown: { fg: "text", bg: "plate", bold: true },
};
const READOUT_CHIP: Record<Tone, Style> = { ...PLATE, ok: { fg: "field", bg: "text", bold: true } };
const TAG: Record<Tone, string> = { ok: "", warn: "▲ WARN", high: "▲ HIGH", unknown: "? UNKNOWN" };
const GREY_PLATE: Style = { fg: "text", bg: "plate", bold: true };
const LABEL = { act: "01 ACT", ctx: "02 CTX", mdl: "03 MDL", usg: "04 USG", ext: "05 EXT" } as const;

const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const toneOf = (percent: number | undefined): Tone => percent === undefined ? "unknown" : percent > 90 ? "high" : percent > 70 ? "warn" : "ok";
const levelOf = (percent: number | undefined) => percent === undefined || percent <= 0 ? 0 : percent > 90 ? 3 : percent > 70 ? 2 : 1;
const knownCount = (count: unknown) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
// The badge text is the single source of the rendered and re-strike width; known counts keep at least two digits.
const unitBadge = (units: number | undefined) => ` ${units === undefined ? " ?" : String(units).padStart(2, "0")} AU `;
// Fixed eight-cell compaction plate: 00–99, then 99+ in the trailing pad cell; ?? when unknown.
const cmpPlate = (count: number | undefined) => count === undefined ? " CMP×?? " : count > 99 ? " CMP×99+" : ` CMP×${String(count).padStart(2, "0")} `;
const USG_PLATE: Style = { fg: "field", bg: "pink", bold: true };
const cmpStyle = (count: number | undefined): Style => ({
	...(count === undefined || count === 0 ? { fg: "text", bg: "plate" } : count <= 2 ? { fg: "text", bg: "violet" } : count <= 4 ? { fg: "field", bg: "pink" } : { fg: "field", bg: "high" }),
	bold: true,
});

// `unit` selects the scale and precision, so tokens can share the window's (84k/200k, 0.1M/1.0M).
function compact(count: number, unit = count): string {
	return unit >= 1_000_000 ? `${(count / 1_000_000).toFixed(1)}M` : unit >= 1_000 ? `${(count / 1_000).toFixed(0)}k` : `${count}`;
}
// Context values shared by rendering and motion memory. Pi auto-compacts above
// window − reserve, so that budget (when positive) is the gauge's 100%.
function contextOf(snapshot: FooterSnapshot) {
	const usage = snapshot.contextUsage, tokens = finite(usage?.tokens), reserve = knownCount(snapshot.compactionReserve);
	const fullWindow = [usage?.contextWindow, snapshot.model?.contextWindow].find((value) => typeof value === "number" && Number.isFinite(value) && value > 0);
	const budget = fullWindow !== undefined && reserve !== undefined && reserve < fullWindow ? fullWindow - reserve : undefined;
	const windowSize = budget ?? fullWindow;
	const percent = budget === undefined ? finite(usage?.percent) : tokens === undefined ? undefined : (tokens * 100) / budget;
	return { percent, tone: toneOf(percent), windowText: windowSize ? compact(windowSize) : "", tokensText: tokens === undefined ? "?" : compact(tokens, windowSize) };
}
const panelLabels = (percent: number | undefined, windowText: string) =>
	[percent === undefined ? "" : "%", percent === undefined ? "UNKNOWN" : "USED", windowText ? `of ${windowText}` : ""];

/* ---------- USG: subscription usage windows (values only; no clock, no I/O) ---------- */

const USAGE_WINDOWS = ["5h", "wk"] as const;
type UsageWindowKey = typeof USAGE_WINDOWS[number];
// `windows` is each provider's declared layout, not a parse rule: it fixes the column so polling never shifts it.
const USAGE: Record<UsageProviderId, { tag: string; lit: Hue; used: Hue; mid: Hue; windows: readonly UsageWindowKey[] }> = {
	codex: { tag: "GPT", lit: "codex", used: "codexUsed", mid: "codexMid", windows: ["wk"] },
	claude: { tag: "CLD", lit: "claude", used: "claudeUsed", mid: "claudeMid", windows: ["5h", "wk"] },
	kimi: { tag: "KMI", lit: "kimi", used: "kimiUsed", mid: "kimiMid", windows: ["5h", "wk"] },
};
const USAGE_STALE_MS = 15 * 60_000, BURN_STEPS = [100, 250, 400, 600] as const;
// The edge square's pulse at the end of each period, in steps that end at `until` ms: it shrinks to the small square
// (still filled, so the lit count stays readable), dims, then grows back before settling. The only USG glyph change.
const EDGE_PULSE = [{ until: 50, glyph: "▪", dim: false }, { until: 100, glyph: "▪", dim: true }, { until: 150, glyph: "■", dim: true }] as const;
const EDGE_PULSE_MS = EDGE_PULSE[EDGE_PULSE.length - 1].until;
// Each window is USAGE_SQUARES squares, each an equal share of its quota.
const USAGE_SQUARES = 8, USAGE_SLICE = 100 / USAGE_SQUARES;
// Tag, then one square group per window, one cell apart; columns sit three cells apart. A state word (`pending`,
// `timeout`, `failed`) wider than its slot may spill up to two cells into that gap, so one blank always precedes the
// next column; with eight-square slots none needs to.
const USAGE_GAP = 3, USAGE_SPILL = 2, USAGE_WORD = 7;
const usageColumn = (n: number) => 3 + 1 + USAGE_SQUARES * n + (n - 1);
// Shown windows: the declared slots plus any reported undeclared window, all in 5H/WK order. Only the latter
// (a declaration that needs updating) widens a column.
const usageSlots = (provider: UsageProviderId, windows: UsageWindows | undefined) =>
	USAGE_WINDOWS.filter((key) => USAGE[provider].windows.includes(key) || windows?.[key]);
// Remaining share, clamped for display; null is an unknown window.
const remainingOf = (window: UsageWindow) => window.usedPercent === null || !Number.isFinite(window.usedPercent) ? null : Math.min(100, Math.max(0, 100 - window.usedPercent));
// Squares of 12.5% each; the epsilon keeps float noise on a boundary (87.5000000001) from lighting another square,
// but any positive remainder keeps one lit: only exhausted quota is all dim.
const litOf = (remaining: number) => remaining <= 0 ? 0 : Math.min(USAGE_SQUARES, Math.max(1, Math.ceil(remaining / USAGE_SLICE - 1e-6)));
// The edge square pulses every 600–4000 ms, faster as its slice drains: at most 1.7 pulses a second.
function edgePeriod(remaining: number): number | undefined {
	const lit = litOf(remaining);
	if (!lit || remaining >= 100) return undefined;
	return 600 + 3400 * Math.min(1, Math.max(0, (remaining - USAGE_SLICE * (lit - 1)) / USAGE_SLICE));
}
// Whole minutes, rounded up so a positive span never reads 0m: 41m, 4h03m, 12h, 5d15h, 12d.
function span(ms: number): string {
	const m = Math.max(0, Math.ceil(ms / 60_000)), h = Math.floor(m / 60), d = Math.floor(m / 1440);
	return m < 60 ? `${m}m` : m < 600 ? `${h}h${String(m % 60).padStart(2, "0")}m` : m < 1440 ? `${h}h` : m < 14_400 ? `${d}d${Math.floor((m % 1440) / 60)}h` : `${d}d`;
}
const countdown = (resetsAt: number | null, now: number | undefined) =>
	resetsAt === null || now === undefined || !Number.isFinite(resetsAt) ? "?" : resetsAt <= now ? "reset" : span(resetsAt - now);
const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
// At most three cells, to fit under the tag: minutes rounded up (a positive age never reads 0m), then floor hours
// and days, then 99+.
function ageText(ms: number): string {
	if (!(ms > 0)) return "0m";
	if (ms <= 59 * MINUTE) return `${Math.ceil(ms / MINUTE)}m`;
	if (ms < DAY) return `${Math.max(1, Math.floor(ms / HOUR))}h`;
	return ms < 100 * DAY ? `${Math.floor(ms / DAY)}d` : "99+";
}
// Milliseconds until `ageText` next changes, consistent with its boundaries; undefined once it reads 99+.
function ageStep(ms: number): number | undefined {
	if (ms <= 0) return 1 - ms;
	if (ms <= 59 * MINUTE) return Math.ceil(ms / MINUTE) * MINUTE - ms + 1;
	if (ms < DAY) return Math.max(2 * HOUR, (Math.floor(ms / HOUR) + 1) * HOUR) - ms;
	return ms < 100 * DAY ? (Math.floor(ms / DAY) + 1) * DAY - ms : undefined;
}
// Age of the last good sample (CodexBar's updatedAt, else receipt) once a fetch failed or it is older than 15 min.
function staleAge(provider: UsageProviderState, now: number | undefined): string | undefined {
	if (!provider.data) return undefined;
	const age = now === undefined ? NaN : now - (finite(provider.data.updatedAt) ?? provider.data.fetchedAt);
	if (!provider.failure && !(age > USAGE_STALE_MS)) return undefined;
	return Number.isFinite(age) ? ageText(age) : "?";
}
/**
 * Milliseconds until displayed USG text (a countdown, stale age or the 15-minute stale mark) can next change, or
 * undefined when nothing on the row depends on time. The adapter repaints then, with or without motion.
 */
export function usageRepaintDelay(usage: FooterUsage | undefined): number | undefined {
	const now = finite(usage?.now);
	if (!usage || now === undefined) return undefined;
	let due = Infinity;
	const minuteStep = (ms: number) => ms - (Math.ceil(ms / 60_000) - 1) * 60_000;
	for (const provider of usage.providers) {
		if (!provider.data) continue;
		for (const key of USAGE_WINDOWS) {
			const resetsAt = finite(provider.data.windows[key]?.resetsAt);
			if (resetsAt !== undefined && resetsAt > now) due = Math.min(due, minuteStep(resetsAt - now));
		}
		const age = now - (finite(provider.data.updatedAt) ?? provider.data.fetchedAt);
		if (!Number.isFinite(age)) continue;
		if (provider.failure || age > USAGE_STALE_MS) due = Math.min(due, ageStep(age) ?? Infinity);
		else due = Math.min(due, USAGE_STALE_MS - age + 1);
	}
	return due === Infinity ? undefined : Math.max(1, Math.ceil(due));
}

/* ---------- seeded randomness: plans are drawn once per event, never per render ---------- */

type Random = { (): number; cursor: number };
function random(seed: number): Random {
	const next = (() => {
		next.cursor = (next.cursor + 0x6d2b79f5) | 0;
		let t = Math.imul(next.cursor ^ (next.cursor >>> 15), 1 | next.cursor);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	}) as Random;
	next.cursor = seed | 0;
	return next;
}
const hash = (a: number, b: number, c: number) => {
	let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(c, 1013904223)) | 0;
	h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
	return (h >>> 0) / 4294967296;
};
const between = (r: Random, [a, b]: readonly [number, number]) => a + Math.floor(r() * (b - a + 1));
const pick = <T>(r: Random, list: readonly T[]) => list[Math.floor(r() * list.length)];
const shuffle = <T>(r: Random, list: readonly T[]) => {
	const a = list.slice();
	for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
	return a;
};
const seedFrom = (r: Random) => Math.floor(r() * 2 ** 31);

/* ---------- large numeral: 3×5 pixel digits as square half-block pixels ---------- */

const FONT: Record<string, string[]> = {
	0: ["111", "101", "101", "101", "111"], 1: ["010", "110", "010", "010", "111"], 2: ["111", "001", "111", "100", "111"],
	3: ["111", "001", "111", "001", "111"], 4: ["101", "101", "111", "001", "001"], 5: ["111", "100", "111", "001", "111"],
	6: ["111", "100", "111", "101", "111"], 7: ["111", "001", "001", "001", "001"], 8: ["111", "101", "111", "101", "111"],
	9: ["111", "101", "111", "001", "111"], ".": ["0", "0", "0", "0", "1"], "-": ["000", "000", "111", "000", "000"],
	"?": ["111", "001", "011", "000", "010"],
};
/** Six pixel rows of numeral colors (null is empty), at least 13 columns wide. */
export type NumeralGrid = { w: number; g: (Hue | null)[][] };
const emptyGrid = (w: number): NumeralGrid => ({ w, g: Array.from({ length: 6 }, () => Array<Hue | null>(w).fill(null)) });
// Exponent forms such as 1e+21 have no glyphs; the readout still shows them.
function numeralGrid(percent: number | undefined): NumeralGrid | undefined {
	const text = percent === undefined ? "?" : percent.toFixed(1);
	if (![...text].every((ch) => FONT[ch])) return undefined;
	const color = NUM[toneOf(percent)], cols: boolean[][] = [];
	[...text].forEach((ch, k) => {
		const px = FONT[ch];
		if (k) cols.push([false, false, false, false, false]);
		for (let x = 0; x < px[0].length; x++) cols.push(px.map((row) => row[x] === "1"));
	});
	const w = Math.max(13, cols.length);
	return { w, g: Array.from({ length: 6 }, (_, y) => Array.from({ length: w }, (_, x) => (cols[x]?.[y] ? color : null))) };
}
const NOISE_BAND = 0.25, BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
// Reconstruct only the CURRENT shape and width: old-only pixels disappear immediately.
// Current pixels acquire their current color square by square from grey, never display stale digits.
function numeralAt(target: NumeralGrid, from: NumeralGrid, progress: number, seed: number): NumeralGrid {
	const w = target.w;
	return { w, g: Array.from({ length: 6 }, (_, y) => Array.from({ length: w }, (_, x) => {
		const old = from.g[y][x] ?? null, now = target.g[y][x] ?? null;
		if (!now || old === now) return now;
		const threshold = NOISE_BAND + ((BAYER[(y % 4) * 4 + (x % 4)] + hash(x + 1, y + 1, seed)) / 16) * (1 - NOISE_BAND);
		return progress >= threshold ? now : now === "graphic" ? "secondary" : "graphic";
	})) };
}

/* ---------- decorative motion: pure functions of supplied time, seed and memory ---------- */

export const MOTION_TICK_MS = 50;
const TICK = MOTION_TICK_MS;
const BOOT_TICKS = 30, WIPE_TICKS = 15, TAG_TICKS = 8, FLASH_TICKS = 6, CAL_PERIOD = 120;
const CAL = [1, 1, 0, -1, -1, 0]; // the header's ┼ nudges ±1 cell once per 6 s
const SCALE_T0 = 6, NUM_BOOT_T0 = 8, NUM_MS = 500, NUM_RETARGET_MS = 350;
const BOOT_AT = { github: 1, launch: 3, active: 6, branch: 8, git: 10, gauge: 5, readout: 12, tag: 13, model: 12, ext: 14 };
const GLITCH: Record<number, { wait: [number, number]; frames: [number, number]; runs: [number, number]; len: [number, number]; glyphs: string[] }> = {
	1: { wait: [5500, 10000], frames: [2, 3], runs: [1, 1], len: [1, 3], glyphs: ["▓", "▒"] },
	2: { wait: [2600, 5200], frames: [3, 4], runs: [1, 2], len: [2, 4], glyphs: ["▓", "▒", "▚", "▞"] },
	3: { wait: [1200, 2800], frames: [4, 6], runs: [2, 3], len: [2, 6], glyphs: ["▓", "▒", "░", "▚", "▞", "▀", "▄"] },
};
const GHOST_WAIT: [number, number] = [2200, 4200]; // after each ghost event ends
const STRIKE_WAIT: [number, number] = [4000, 6000]; // start-to-start, independent of ghosts
const BOOT_GHOST_DELAY = (BOOT_TICKS + 1) * TICK + 600, RESUME_GHOST_DELAY = 800;
const PULSE_CAP = 6;
// A late provider's fill-in latches one cell per tick.
const USAGE_FILL_TICKS = USAGE_SQUARES;
// USG row boot: a draw-in front sweeps this many cells a tick from the plate's left edge, the text row one tick behind.
export const USAGE_SWEEP_CELLS_PER_TICK = 3;
// The widest natural row: plate, gap and every provider column with its declared windows plus room for one
// undeclared window (where one exists), three cells apart. The boot covers it, then the text row's lag; wider rows
// are drawn settled when it ends.
const USAGE_ROW_CELLS = ` ${LABEL.usg} `.length + 1 - USAGE_GAP
	+ Object.values(USAGE).reduce((sum, look) => sum + usageColumn(Math.min(look.windows.length + 1, USAGE_WINDOWS.length)) + USAGE_GAP, 0);
export const USAGE_BOOT_TICKS = Math.ceil(USAGE_ROW_CELLS / USAGE_SWEEP_CELLS_PER_TICK) + 1;

export const TATSU_CHECK_STEP_MS = 150;
const TATSU_CHECK_FADE_INKS: readonly Hue[] = ["graphic", "checkLow", "checkMid", "checkHigh", "checkPeak", "checkHigh", "checkMid", "checkLow"];
export const TATSU_CHECK_GLYPHS = ["·", "•", "•", "•", "·"] as const;
export const TATSU_LATCH_TICKS = 3;
export const TATSU_BEACON_PERIOD_MS = 4000;
export const TATSU_BEACON_STEP_MS = 50;
export const TATSU_BEACON_MS = 3 * TATSU_BEACON_STEP_MS;
// Warm-up on appearance: each part brightens out of the field in four steps of TATSU_WARM_STEP_TICKS, shape first, then
// code, then label; each component starts TATSU_WARM_STAGGER ticks after the one before. Colour only: every character
// is the current one from the first frame. 14 ticks (700 ms) for the two components.
export const TATSU_WARM_STEP_TICKS = 2;
export const TATSU_WARM_STAGGER = 3;
const TATSU_WARM_ROLE = { shape: 0, code: 2, label: 4 } as const;
export const TATSU_WARM_TICKS = TATSU_WARM_STAGGER + TATSU_WARM_ROLE.label + 3 * TATSU_WARM_STEP_TICKS + 1;
const TATSU_WARM_INKS: Partial<Record<Hue, readonly [Hue, Hue, Hue]>> = {
	primary: ["primary25", "primary50", "primary75"], warn: ["warn25", "warnDim", "warn75"],
	high: ["high25", "high50", "high75"], graphic: ["surface", "graphic50", "plate"],
};
/** One cell group's warm-up colour on tick `k` (negative before it starts): the field, a 25/50/75% step, then `ink`. */
const tatsuWarmInk = (ink: Hue, k: number, component: number, role: keyof typeof TATSU_WARM_ROLE): Hue => {
	const step = Math.floor((k - component * TATSU_WARM_STAGGER - TATSU_WARM_ROLE[role]) / TATSU_WARM_STEP_TICKS);
	return step < 0 ? "field" : step < 3 ? TATSU_WARM_INKS[ink]?.[step] ?? ink : ink;
};

type StrikeKind = "heavy" | "void" | "flash" | "mid" | "light" | "worn";
type GhostSpec = { hide: true } | { ch: string; fg: Hue | "@edge" | "@edgeL" };
// Ghost positions are semantic, resolved against the current layout each frame.
type GhostAt = { row: number | PlateKey; fromEnd?: boolean; col: number; colFrom?: "right" | "mid" | "plate" };
/** One planned decoration cell: a ghost at a frame anchor, or a re-strike at a zone-relative cell. */
export type MotionItem = { start: number } & (
	| { fam: "ghost"; at: GhostAt; frames: (GhostSpec | null)[] }
	| { fam: "restrike"; zone: "plate"; key: PlateKey; x: number; frames: (StrikeKind | null)[] }
	| { fam: "restrike"; zone: "digits" | "labels"; row: number; x: number; frames: (StrikeKind | null)[] }
	| { fam: "restrike"; zone: "root" | "badge"; x: number; frames: (StrikeKind | null)[] }
);
type MotionEvent = { at: number; dur: number; items: MotionItem[] };

/** Decoration memory only. Displayed values always come from the current snapshot. */
export type MotionState = Readonly<{
	tatsu?: TatsuSnapshot;
	/** Last completed result survives checking, but not invalid/inactive transitions. */
	tatsuCompleted?: TatsuSnapshot;
	tatsuWarm?: number;
	tatsuLatches: Readonly<Partial<Record<TatsuComponent["component"], number>>>;
	cursor: number;
	epoch: number;
	boot?: { at: number; seed: number };
	percent?: number;
	windowText: string;
	numeral?: { from: NumeralGrid; at: number; dur: number; seed: number };
	wipe?: { from: Tone; at: number };
	crossed: Readonly<{ 70?: number; 90?: number }>;
	glitch?: { at: number; level: number; seed: number; frames: number };
	glitchAt: number;
	ghost?: MotionEvent;
	ghostAt: number;
	strike?: MotionEvent;
	strikeAt: number;
	working: boolean;
	units: number;
	ponytail?: PonytailState;
	ponytailKnown?: PonytailMode;
	/** Retained by the adapter across decoration/component resets. */
	ponytailGuardUntil: number;
	ponytailBurst?: { at: number; masks: readonly [number, number] };
	ponytailActive: boolean;
	/** Per `provider/window`: the sample seen, its lit count (undefined is unknown) and edge-pulse period. */
	usage: Readonly<Record<string, UsageMemory>>;
	/** Squares from..to−1 burning out after a newer sample lit fewer squares. */
	usageBurns: Readonly<Record<string, { at: number; from: number; to: number }>>;
	/** Whether the USG row was present when last observed; its appearance starts `usageBoot`. */
	usageShown: boolean;
	/** When the USG row booted (it appeared, or was present at a booting start). */
	usageBoot?: number;
	/** Per provider: when its fill-in started (data first arrived after any row boot). Present until it completes. */
	usageFill: Readonly<Partial<Record<UsageProviderId, number>>>;
}>;
type UsageMemory = Readonly<{ stamp: number; lit?: number; period?: number }>;
/** USG decoration for one `provider/window`: the edge square's pulse step, or an in-progress burn-out. */
export type UsageEffect = Readonly<{ edge?: number; burn?: { from: number; to: number; elapsed: number } }>;
/** Everything the renderer needs for one decoration frame; values are never part of it. */
export type FooterFrame = Readonly<{
	/** Warm-up tick, negative while it waits for the footer boot to reach EXT. */
	tatsuWarm?: number;
	tatsuCheck?: number;
	tatsuBeacon?: number;
	tatsuLatches?: Readonly<Partial<Record<TatsuComponent["component"], number>>>;
	boot: number;
	bootSeed: number;
	cal: number;
	wipe?: { from: Tone; cells: number };
	tagFlash: boolean;
	flash70: boolean;
	flash90: boolean;
	numeral?: { from: NumeralGrid; progress: number; seed: number };
	glitch?: { level: number; seed: number };
	ghosts?: { k: number; items: readonly MotionItem[] };
	strike?: { k: number; items: readonly MotionItem[] };
	pulse: number | null;
	/** Only current mode-letter foregrounds; never plate geometry or semantic text. */
	ponytailMask?: number;
	/** Only USG square inks; lit counts, glyph positions and text always come from the snapshot. */
	usage?: Readonly<Record<string, UsageEffect>>;
	/** Ticks since the USG row booted, which place its draw-in front; absent once settled. */
	usageBoot?: number;
	/** Per provider: ticks since its fill-in started; absent once settled. Style only. */
	usageFill?: Readonly<Partial<Record<UsageProviderId, number>>>;
}>;
export const SETTLED_FRAME: FooterFrame = Object.freeze({ boot: Infinity, bootSeed: 0, cal: 0, tagFlash: false, flash70: false, flash90: false, pulse: null });

const ticksSince = (at: number, now: number) => Math.floor((now - at) / TICK);
const calAt = (tick: number) => (tick >= 0 ? CAL[tick % CAL_PERIOD] ?? 0 : 0);
const numKey = (percent: number | undefined) => `${percent === undefined ? "?" : percent.toFixed(1)}${NUM[toneOf(percent)]}`;
const booting = (s: MotionState, now: number) => s.boot !== undefined && ticksSince(s.boot.at, now) <= BOOT_TICKS;
const settledNumeral = (s: MotionState, now: number) => !s.numeral || now - s.numeral.at >= s.numeral.dur;

function displayedNumeral(s: MotionState, now: number): NumeralGrid {
	const target = numeralGrid(s.percent) ?? emptyGrid(13), tr = s.numeral;
	if (!tr || settledNumeral(s, now)) return target;
	return numeralAt(target, tr.from, Math.max(0, ticksSince(tr.at, now) / (tr.dur / TICK)), tr.seed);
}

// Decoration memory of the displayed samples; only real successful samples carry a stamp.
function usageMemory(snapshot: FooterSnapshot): Record<string, UsageMemory> {
	const memory: Record<string, UsageMemory> = {};
	for (const provider of snapshot.usage?.providers ?? []) {
		if (!provider.data) continue;
		for (const key of USAGE_WINDOWS) {
			const window = provider.data.windows[key], remaining = window ? remainingOf(window) : null;
			memory[`${provider.provider}/${key}`] = remaining === null ? { stamp: provider.data.fetchedAt } : { stamp: provider.data.fetchedAt, lit: litOf(remaining), period: edgePeriod(remaining) };
		}
	}
	return memory;
}
const sameUsage = (a: Readonly<Record<string, UsageMemory>>, b: Readonly<Record<string, UsageMemory>>) => {
	const keys = Object.keys(a);
	return keys.length === Object.keys(b).length && keys.every((key) => b[key] && a[key].stamp === b[key].stamp && a[key].lit === b[key].lit && a[key].period === b[key].period);
};
const providerOf = (key: string) => key.split("/")[0] as UsageProviderId;
// Providers the USG row renders, in display order; none means no row.
const usageRow = (snapshot: FooterSnapshot) => (snapshot.usage?.providers ?? []).filter((provider) => USAGE[provider.provider]);
const sameFill = (a: Readonly<Partial<Record<UsageProviderId, number>>>, b: Readonly<Partial<Record<UsageProviderId, number>>>) => {
	const keys = Object.keys(a) as UsageProviderId[];
	return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};

/** Starts decoration memory. `boot` plays the install sequence; false resumes settled (motion turned back on). */
export function startMotion(snapshot: FooterSnapshot, now: number, seed: number, boot: boolean, ponytailGuardUntil = 0): MotionState {
	const r = random(seed), { percent, windowText } = contextOf(snapshot), level = levelOf(percent);
	const ghostDelay = boot ? BOOT_GHOST_DELAY : RESUME_GHOST_DELAY;
	const quiet = boot ? now + (BOOT_TICKS + 1) * TICK : now, row = usageRow(snapshot);
	const state: MotionState = {
		cursor: 0, epoch: now, windowText, percent, crossed: {},
		tatsu: activeTatsu(snapshot), tatsuCompleted: activeTatsu(snapshot)?.phase === "completed" ? snapshot.tatsu : undefined, tatsuLatches: {},
		// Present at the footer boot (a reload), Tatsu warms up as the boot reaches EXT; resuming replays nothing.
		tatsuWarm: boot && activeTatsu(snapshot) ? now + BOOT_AT.ext * TICK : undefined,
		ponytail: snapshot.ponytail, ponytailKnown: confirmedPonytail(snapshot.ponytail), ponytailGuardUntil,
		boot: boot ? { at: now, seed: seedFrom(r) } : undefined,
		numeral: boot ? { from: emptyGrid(13), at: now + NUM_BOOT_T0 * TICK, dur: NUM_MS, seed: seedFrom(r) } : undefined,
		glitchAt: level ? quiet + between(r, GLITCH[level].wait) * 0.5 : Infinity,
		ghostAt: now + ghostDelay,
		strikeAt: now + Math.max(ghostDelay, between(r, STRIKE_WAIT) * 0.5),
		working: snapshot.activity?.working === true,
		units: knownCount(snapshot.activity?.units) ?? 0,
		ponytailActive: ponytailLit(snapshot),
		usage: usageMemory(snapshot), usageBurns: {},
		usageShown: row.length > 0, usageBoot: boot && row.length ? now : undefined, usageFill: {},
	};
	return { ...state, cursor: r.cursor };
}

/**
 * Records real changes (tone wipe, 70/90 crossings, numeral reconstruction, glitch level, activity) and starts
 * due glitch, ghost and re-strike events with plans drawn from the state's seed. Returns `state` when nothing changed.
 */
export function advanceMotion(state: MotionState, snapshot: FooterSnapshot, now: number): MotionState {
	const r = random(state.cursor), next: { -readonly [K in keyof MotionState]: MotionState[K] } = { ...state };
	let changed = false;
	const set = <K extends keyof MotionState>(key: K, value: MotionState[K]) => { if (next[key] !== value) { next[key] = value; changed = true; } };
	// Expire finished transients.
	if (next.boot && !booting(next, now)) set("boot", undefined);
	if (next.numeral && settledNumeral(next, now)) set("numeral", undefined);
	if (next.wipe && ticksSince(next.wipe.at, now) >= WIPE_TICKS) set("wipe", undefined);
	for (const mark of [70, 90] as const) {
		const at = next.crossed[mark];
		if (at !== undefined && ticksSince(at, now) >= FLASH_TICKS) set("crossed", { ...next.crossed, [mark]: undefined });
	}
	if (next.glitch && ticksSince(next.glitch.at, now) >= next.glitch.frames) set("glitch", undefined);
	if (next.ghost && ticksSince(next.ghost.at, now) >= next.ghost.dur) set("ghost", undefined);
	if (next.strike && ticksSince(next.strike.at, now) >= next.strike.dur) set("strike", undefined);

	// Two random nonempty subsets, drawn once. No sweep, boot treatment or idle loop.
	// Reserve 1.8s from start AND 1.1s from every observed burst frame/recovery.
	// This also protects a late wake recovering a black frame held on screen.
	if (next.ponytailBurst) {
		set("ponytailGuardUntil", Math.max(next.ponytailGuardUntil, now + 1100));
		if (now - next.ponytailBurst.at >= 450) set("ponytailBurst", undefined);
	}
	if (snapshot.ponytail !== state.ponytail) {
		set("ponytailBurst", undefined); // interruption settles latest; never queues a replay
		const known = confirmedPonytail(snapshot.ponytail);
		if (known !== undefined) {
			if (state.ponytailKnown !== undefined && known !== state.ponytailKnown && known !== "off" && now >= next.ponytailGuardUntil) {
				const first = between(r, [1, 7]);
				const second = (first + between(r, [1, 6]) - 1) % 7 + 1;
				set("ponytailBurst", { at: now, masks: [first, second] });
				set("ponytailGuardUntil", now + 1800);
			}
			set("ponytailKnown", known);
		}
		set("ponytail", snapshot.ponytail);
	}

	// Tatsu is push-driven data; this memory owns decoration only. Checking retains the last completed baseline.
	const tatsu = activeTatsu(snapshot);
	if (next.tatsuWarm !== undefined && ticksSince(next.tatsuWarm, now) >= TATSU_WARM_TICKS) set("tatsuWarm", undefined);
	const latches: Partial<Record<TatsuComponent["component"], number>> = {};
	for (const [component, at] of Object.entries(next.tatsuLatches) as [TatsuComponent["component"], number][]) if (ticksSince(at, now) < TATSU_LATCH_TICKS) latches[component] = at;
	if (!tatsu) { set("tatsuWarm", undefined); set("tatsuCompleted", undefined); }
	else {
		// Appearing during the footer boot waits for the boot to reach EXT, like a reload.
		if (!state.tatsu) set("tatsuWarm", booting(next, now) ? Math.max(now, next.boot!.at + BOOT_AT.ext * TICK) : now);
		if (tatsu.phase === "completed") {
			for (const c of tatsu.components) {
				const previous = state.tatsuCompleted?.components.find((p) => p.component === c.component);
				if (previous && tatsuKey(previous) !== tatsuKey(c)) {
					delete latches[c.component];
					if (c.state !== "inactive" && previous.state !== "inactive" && !booting(next, now) && next.tatsuWarm === undefined) latches[c.component] = now;
				}
			}
			set("tatsuCompleted", tatsu);
		}
	}
	if (!tatsu || tatsu.phase !== "completed") for (const key of Object.keys(latches) as TatsuComponent["component"][]) delete latches[key];
	if (["tatsu-cli", "agent-workspace"].some((key) => latches[key as TatsuComponent["component"]] !== next.tatsuLatches[key as TatsuComponent["component"]])) set("tatsuLatches", latches);
	set("tatsu", tatsu);

	// Observe the real context value.
	const { percent, windowText } = contextOf(snapshot);
	set("windowText", windowText);
	if (percent !== state.percent) {
		const previous = state.percent, from = displayedNumeral(next, now);
		if (numKey(percent) !== numKey(previous)) set("numeral", { from, at: now, dur: next.numeral ? NUM_RETARGET_MS : NUM_MS, seed: seedFrom(r) });
		if (toneOf(percent) !== toneOf(previous)) set("wipe", { from: toneOf(previous), at: now });
		if (percent !== undefined && previous !== undefined) {
			for (const mark of [70, 90] as const) if ((previous > mark) !== (percent > mark)) set("crossed", { ...next.crossed, [mark]: now });
		}
		const level = levelOf(percent), before = levelOf(previous);
		if (!level) { set("glitch", undefined); set("glitchAt", Infinity); }
		else if (level > before) set("glitchAt", Math.min(next.glitchAt, now + between(r, GLITCH[level].wait) * (before ? 1 : 0.5)));
		set("percent", percent);
	}
	set("working", snapshot.activity?.working === true);
	set("units", knownCount(snapshot.activity?.units) ?? 0);
	set("ponytailActive", ponytailLit(snapshot));

	// USG row boot (its draw-in) whenever the row appears, including again after it was hidden. Afterwards a provider
	// that gains data (from pending or a failure without data) fills in from now; during a row boot it is simply drawn
	// current when the front reaches it. A newer sample never restarts a fill-in.
	const row = usageRow(snapshot);
	let fill: Partial<Record<UsageProviderId, number>> = {};
	for (const [provider, at] of Object.entries(next.usageFill) as [UsageProviderId, number][]) if (ticksSince(at, now) < USAGE_FILL_TICKS) fill[provider] = at;
	if (next.usageBoot !== undefined && ticksSince(next.usageBoot, now) >= USAGE_BOOT_TICKS) set("usageBoot", undefined);
	if (!row.length) { set("usageBoot", undefined); fill = {}; }
	else if (!state.usageShown) { set("usageBoot", now); fill = {}; }
	else if (next.usageBoot === undefined) {
		const had = new Set(Object.keys(state.usage).map(providerOf));
		for (const provider of row) if (provider.data && !had.has(provider.provider)) fill[provider.provider] = now;
	}
	set("usageShown", row.length > 0);
	if (!sameFill(fill, next.usageFill)) set("usageFill", fill);

	// USG burn-out: a newer successful sample that lights fewer squares. First discovery, increases (resets) and
	// unknown transitions settle; newer data interrupts a running burn and settles to the latest. A window whose row
	// boot or fill-in is running shows its current values instead.
	const usage = usageMemory(snapshot), burns = { ...next.usageBurns };
	let burned = false;
	for (const key of Object.keys(burns)) if (now - burns[key].at >= BURN_STEPS[3] || !usage[key]) { delete burns[key]; burned = true; }
	for (const [key, memory] of Object.entries(usage)) {
		const previous = state.usage[key];
		if (!previous || previous.stamp === memory.stamp) continue;
		if (burns[key]) { delete burns[key]; burned = true; }
		if (previous.lit !== undefined && memory.lit !== undefined && memory.lit < previous.lit && next.usageBoot === undefined && fill[providerOf(key)] === undefined) { burns[key] = { at: now, from: previous.lit, to: memory.lit }; burned = true; }
	}
	if (!sameUsage(state.usage, usage)) set("usage", usage);
	if (burned) set("usageBurns", burns);

	// Start due events; none run during boot. A late timer keeps the planned start when within one tick.
	if (!booting(next, now)) {
		const startAt = (due: number) => (now - due < TICK ? due : now);
		const level = levelOf(next.percent);
		if (!next.glitch && level && now >= next.glitchAt) {
			const at = startAt(next.glitchAt), frames = between(r, GLITCH[level].frames);
			set("glitch", { at, level, seed: seedFrom(r), frames });
			set("glitchAt", at + frames * TICK + between(r, GLITCH[level].wait));
		}
		if (!next.ghost && now >= next.ghostAt) {
			const at = startAt(next.ghostAt), items = planGhosts(random(seedFrom(r)));
			const dur = Math.max(...items.map((item) => item.start + item.frames.length));
			set("ghost", { at, dur, items });
			set("ghostAt", at + dur * TICK + between(r, GHOST_WAIT));
		}
		if (!next.strike && now >= next.strikeAt) {
			const at = startAt(next.strikeAt), items = planRestrike(random(seedFrom(r)), next);
			set("strike", { at, dur: Math.max(...items.map((item) => item.start + item.frames.length)), items });
			set("strikeAt", at + between(r, STRIKE_WAIT));
		}
	}
	if (!changed) return state;
	next.cursor = r.cursor;
	return next;
}

export function motionFrame(state: MotionState, now: number): FooterFrame {
	const frame: { -readonly [K in keyof FooterFrame]: FooterFrame[K] } = {
		boot: Infinity, bootSeed: state.boot?.seed ?? 0, cal: calAt(ticksSince(state.epoch, now)), tagFlash: false, flash70: false, flash90: false,
		pulse: Math.max(0, ticksSince(state.epoch, now)),
	};
	if (state.ponytailBurst) {
		const elapsed = now - state.ponytailBurst.at;
		frame.ponytailMask = elapsed >= 100 && elapsed < 200 ? state.ponytailBurst.masks[0]
			: elapsed >= 350 && elapsed < 450 ? state.ponytailBurst.masks[1] : 0;
	}
	if (state.boot && booting(state, now)) frame.boot = Math.max(0, ticksSince(state.boot.at, now));
	if (state.wipe) {
		const k = ticksSince(state.wipe.at, now);
		if (k >= 0 && k < WIPE_TICKS) frame.wipe = { from: state.wipe.from, cells: k };
		if (k >= 0 && k < TAG_TICKS) frame.tagFlash = (TAG_TICKS - k) % 4 >= 2;
	}
	for (const mark of [70, 90] as const) {
		const at = state.crossed[mark], k = at === undefined ? -1 : ticksSince(at, now);
		if (k >= 0 && k < FLASH_TICKS) frame[mark === 70 ? "flash70" : "flash90"] = (FLASH_TICKS - k) % 2 === 1;
	}
	if (state.numeral && !settledNumeral(state, now)) {
		const tr = state.numeral;
		frame.numeral = { from: tr.from, progress: Math.max(0, ticksSince(tr.at, now) / (tr.dur / TICK)), seed: tr.seed };
	}
	if (state.glitch) {
		const k = ticksSince(state.glitch.at, now);
		if (k >= 0 && k < state.glitch.frames) frame.glitch = { level: state.glitch.level, seed: state.glitch.seed + k * 7919 };
	}
	for (const [key, event] of [["ghosts", state.ghost], ["strike", state.strike]] as const) {
		const k = event ? ticksSince(event.at, now) : -1;
		if (event && k >= 0 && k < event.dur) frame[key] = { k, items: event.items };
	}
	if (state.tatsuWarm !== undefined) {
		const k = ticksSince(state.tatsuWarm, now);
		if (k < TATSU_WARM_TICKS) frame.tatsuWarm = k;
	}
	const tatsuLatches: Partial<Record<TatsuComponent["component"], number>> = {};
	for (const [component, at] of Object.entries(state.tatsuLatches) as [TatsuComponent["component"], number][]) {
		const k = ticksSince(at, now);
		if (k >= 0 && k < TATSU_LATCH_TICKS) tatsuLatches[component] = k;
	}
	if (Object.keys(tatsuLatches).length) frame.tatsuLatches = tatsuLatches;
	frame.tatsuCheck = Math.floor(Math.max(0, now - state.epoch) / TATSU_CHECK_STEP_MS);
	const beaconAt = Math.max(0, now - state.epoch) % TATSU_BEACON_PERIOD_MS - (TATSU_BEACON_PERIOD_MS - TATSU_BEACON_MS);
	if (beaconAt >= 0) frame.tatsuBeacon = Math.floor(beaconAt / TATSU_BEACON_STEP_MS);
	if (state.usageBoot !== undefined) {
		const k = ticksSince(state.usageBoot, now);
		if (k >= 0 && k < USAGE_BOOT_TICKS) frame.usageBoot = k;
	}
	const fill: Partial<Record<UsageProviderId, number>> = {};
	for (const [provider, at] of Object.entries(state.usageFill) as [UsageProviderId, number][]) {
		const k = ticksSince(at, now);
		if (k < USAGE_FILL_TICKS) fill[provider] = k;
	}
	if (Object.keys(fill).length) frame.usageFill = fill;
	// A running row boot or fill-in suppresses its windows' edge pulse and burn-out; a burn-out suppresses its window's pulse.
	const held = (key: string) => frame.usageBoot !== undefined || fill[providerOf(key)] !== undefined;
	const usage: Record<string, UsageEffect> = {};
	for (const [key, burn] of Object.entries(state.usageBurns)) {
		const elapsed = now - burn.at;
		if (elapsed >= 0 && elapsed < BURN_STEPS[3] && !held(key)) usage[key] = { burn: { from: burn.from, to: burn.to, elapsed } };
	}
	for (const [key, memory] of Object.entries(state.usage)) {
		const edge = memory.period === undefined || held(key) || usage[key] ? undefined : edgeStep(memory.period, now - state.epoch);
		if (edge !== undefined) usage[key] = { edge };
	}
	if (Object.keys(usage).length) frame.usage = usage;
	return frame;
}

// The lamp blinks 500 ms acid / 300 ms dim; each visible unit mark shuttles on its own period.
const lampOn = (pulse: number) => pulse % 16 < 10;
// Ponytail's light toggles every 50 ms decoration tick: 10 blinks a second, the fastest the tick allows. One character
// cell is well below WCAG's flash-area threshold, so this exceeds the three-a-second budget kept for the mode letters by choice.
const lightOn = (pulse: number) => pulse % 2 === 0;
const markSide = (pulse: number, q: number) => Math.floor((pulse + q * 3) / (4 + ((q * 2) % 5))) % 2;
// A USG edge square pulses for the last EDGE_PULSE_MS of each period, so a fresh start never opens on a pulse.
function edgeStep(period: number, elapsed: number): number | undefined {
	const at = elapsed < 0 ? -1 : elapsed % period - (period - EDGE_PULSE_MS);
	if (at < 0) return undefined;
	const step = EDGE_PULSE.findIndex((s) => at < s.until);
	return step < 0 ? undefined : step;
}

/** Milliseconds until the decoration can next change or an event is due. Call only while motion is on. */
export function nextMotionDelay(state: MotionState, now: number): number {
	let due = Infinity;
	const tickOf = (at: number, length: number) => {
		const k = ticksSince(at, now);
		if (k < length) due = Math.min(due, k < 0 ? at : at + (k + 1) * TICK);
	};
	const inBoot = booting(state, now);
	if (inBoot) tickOf(state.boot!.at, BOOT_TICKS + 1);
	if (state.ponytailBurst) tickOf(state.ponytailBurst.at, 9);
	if (state.numeral) tickOf(state.numeral.at, Math.ceil(state.numeral.dur / TICK));
	if (state.wipe) tickOf(state.wipe.at, WIPE_TICKS);
	for (const at of [state.crossed[70], state.crossed[90]]) if (at !== undefined) tickOf(at, FLASH_TICKS);
	if (state.glitch) tickOf(state.glitch.at, state.glitch.frames);
	if (state.ghost) tickOf(state.ghost.at, state.ghost.dur);
	if (state.strike) tickOf(state.strike.at, state.strike.dur);
	const tick = Math.max(0, ticksSince(state.epoch, now));
	for (let k = tick + 1; k <= tick + CAL_PERIOD; k++) {
		if (calAt(k) !== calAt(k - 1)) { due = Math.min(due, state.epoch + k * TICK); break; }
	}
	const marks = Math.min(PULSE_CAP, state.units);
	if (state.working || marks || state.ponytailActive) {
		for (let k = tick + 1; k <= tick + 32; k++) {
			let moved = (state.working && lampOn(k) !== lampOn(k - 1)) || (state.ponytailActive && lightOn(k) !== lightOn(k - 1));
			for (let q = 0; q < marks && !moved; q++) moved = markSide(k, q) !== markSide(k - 1, q);
			if (moved) { due = Math.min(due, state.epoch + k * TICK); break; }
		}
	}
	// USG edge pulses and burn-out steps use exact millisecond boundaries rather than ticks.
	const elapsed = now - state.epoch;
	for (const memory of Object.values(state.usage)) {
		if (memory.period === undefined) continue;
		const phase = elapsed < 0 ? -1 : elapsed % memory.period, start = memory.period - EDGE_PULSE_MS;
		const next = [start, ...EDGE_PULSE.map((s) => start + s.until)].find((at) => at > phase) ?? memory.period;
		due = Math.min(due, phase < 0 ? state.epoch : now + next - phase);
	}
	for (const burn of Object.values(state.usageBurns)) {
		const step = BURN_STEPS.find((at) => at > now - burn.at);
		if (step !== undefined) due = Math.min(due, burn.at + step);
	}
	if (state.tatsuWarm !== undefined) tickOf(state.tatsuWarm, TATSU_WARM_TICKS);
	for (const at of Object.values(state.tatsuLatches)) if (at !== undefined) tickOf(at, TATSU_LATCH_TICKS);
	if (state.tatsu?.components.some((c) => c.state === "checking")) due = Math.min(due, state.epoch + (Math.floor((now - state.epoch) / TATSU_CHECK_STEP_MS) + 1) * TATSU_CHECK_STEP_MS);
	if (state.tatsu?.components.some((c) => c.state === "behind" || c.state === "repair")) {
		const phase = Math.max(0, now - state.epoch) % TATSU_BEACON_PERIOD_MS, start = TATSU_BEACON_PERIOD_MS - TATSU_BEACON_MS;
		const at = [start, start + TATSU_BEACON_STEP_MS, start + 2 * TATSU_BEACON_STEP_MS, TATSU_BEACON_PERIOD_MS].find((at) => at > phase)!;
		due = Math.min(due, now + at - phase);
	}
	// USG row-boot front and fill-in latch on 50 ms ticks.
	if (state.usageBoot !== undefined) tickOf(state.usageBoot, USAGE_BOOT_TICKS);
	for (const at of Object.values(state.usageFill)) if (at !== undefined) tickOf(at, USAGE_FILL_TICKS);
	// Due glitch, ghost and re-strike starts; none start during boot.
	if (!inBoot) due = Math.min(due, levelOf(state.percent) ? state.glitchAt : Infinity, state.ghostAt, state.strikeAt);
	return Math.max(1, Math.ceil(due - now));
}

/* ---------- ambient plans (A+B): registration ghosts and fresh re-strike patches ---------- */

function planGhosts(r: Random): MotionItem[] {
	// A ghost appears one cell off (brighter on its first tick); a frame anchor briefly lifts, then everything snaps back.
	type Spot = Pick<GhostAt, "row" | "fromEnd" | "col" | "colFrom">;
	const ghost = (at: Spot, ch: string, fg: Hue): Omit<Extract<MotionItem, { fam: "ghost" }>, "start"> =>
		({ fam: "ghost", at, frames: [{ ch, fg: fg === "graphic" ? "secondary" : "graphic" }, { ch, fg }, { ch, fg }] });
	const lift = (at: Spot): Omit<Extract<MotionItem, { fam: "ghost" }>, "start"> => ({ fam: "ghost", at, frames: [null, { hide: true }] });
	const top = (col: number, colFrom?: "right"): Spot => ({ row: 0, col, colFrom });
	const bottom = (row: number, col: number, colFrom?: "right"): Spot => ({ row, fromEnd: true, col, colFrom });
	const groups = [
		() => {
			const [anchor, near, ch] = pick(r, [
				[top(0), { row: 1, col: 1 }, "┏"], [top(0, "right"), { row: 1, col: 1, colFrom: "right" }, "┓"],
				[bottom(0, 0), bottom(1, 1), "┗"], [bottom(0, 0, "right"), bottom(1, 1, "right"), "┛"],
			] as [Spot, Spot, string][]);
			return [ghost(near, ch, "graphic"), lift(anchor)];
		},
		() => [ghost(pick(r, [{ row: 2, col: 0 }, { row: 2, col: 0, colFrom: "right" }, bottom(2, 0), bottom(2, 0, "right")] as Spot[]), "┃", "graphic")],
		() => {
			// Corner bracket slip: the two-cell corner doubles one cell inward while its corner lifts.
			const [anchor, cells] = pick(r, [
				[top(0, "right"), [[top(2, "right"), "━"], [top(1, "right"), "┓"]]],
				[bottom(0, 0, "right"), [[bottom(0, 2, "right"), "━"], [bottom(0, 1, "right"), "┛"]]],
				[top(0), [[{ row: 1, col: 0 }, "┏"], [{ row: 1, col: 1 }, "━"]]],
				[bottom(0, 0), [[bottom(1, 0), "┗"], [bottom(1, 1), "━"]]],
			] as [Spot, [Spot, string][]][]);
			return [...cells.map(([at, ch]) => ghost(at, ch, "graphic")), lift(anchor)];
		},
		() => [ghost({ row: 1, col: 1, colFrom: "mid" }, "┼", "graphic")],
		() => {
			const key = pick(r, ["act", "ctx", "mdl", "ext"] as const);
			const out: Omit<Extract<MotionItem, { fam: "ghost" }>, "start">[] = [{ fam: "ghost", at: { row: key, col: 0, colFrom: "plate" }, frames: [{ ch: "▌", fg: "@edge" }, { ch: "▌", fg: "@edge" }] }];
			if ((key === "act" || key === "ctx") && r() < 0.5) out.push({ fam: "ghost", at: { row: key, col: 1 }, frames: [null, { ch: "▐", fg: "@edgeL" }, { ch: "▐", fg: "@edgeL" }] });
			return out;
		},
	];
	const items: MotionItem[] = [];
	let start = 0;
	for (const group of shuffle(r, groups).slice(0, 2)) {
		for (const item of group()) items.push({ ...item, start });
		start += 2 + Math.floor(r() * 4);
	}
	return items;
}

const STRIKE = { hard: ["heavy", "void", "flash", "heavy", "mid"], soft: ["light", "worn", "mid", "light"] } as const;
// 2–5 steps: an opening hit, an optional pause, then lighter wear before the surface stamps back.
function strikeProgramme(r: Random, hard: boolean): (StrikeKind | null)[] {
	const length = 2 + Math.floor(r() * 4), out: (StrikeKind | null)[] = [];
	for (let k = 0; k < length; k++) {
		if (k > 0 && r() < 0.18) { out.push(null); continue; }
		out.push(pick(r, k === 0 ? (hard ? STRIKE.hard : STRIKE.soft) : r() < 0.35 ? STRIKE.hard : STRIKE.soft));
	}
	return out;
}
type StrikeTarget = { k: number; keep?: boolean; place: (start: number, frames: (StrikeKind | null)[]) => MotionItem };
// One patch: a shared programme, a cell order through the patch, per-cell recovery tails and dropped cells.
function strikePatch(r: Random, targets: StrikeTarget[], at: number, items: MotionItem[]) {
	const hard = r() < 0.55, base = strikeProgramme(r, hard);
	const span = Math.max(...targets.map((target) => target.k)) + 1;
	const order = pick(r, ["ltr", "rtl", "mid", "scatter"] as const);
	const rank = (k: number) => (order === "ltr" ? k : order === "rtl" ? span - 1 - k : order === "mid" ? Math.abs(k - (span - 1) / 2) : Math.floor(r() * 3));
	const step = r() < 0.5 ? 0 : 1;
	for (const target of targets) {
		if (!target.keep && targets.length > 2 && r() < 0.15) continue; // a panel keeps its occupied anchor; other cells stay ragged
		let frames = base.slice(0, Math.max(1, base.length - Math.floor(r() * 2)));
		if (r() < 0.25) frames = [...frames, null, pick(r, STRIKE.soft)];
		if (r() < 0.3) frames = frames.map((kind) => (kind && r() < 0.4 ? pick(r, hard ? STRIKE.hard : STRIKE.soft) : kind));
		items.push(target.place(at + Math.round(rank(target.k) * step), frames));
	}
}
// Panel targets are relative to the digit or caption block and anchored on real ink, so width changes never spill.
function panelPatches(r: Random, at: number, items: MotionItem[], state: MotionState) {
	const grid = numeralGrid(state.percent) ?? emptyGrid(13), labels = panelLabels(state.percent, state.windowText);
	const patches = 1 + Math.floor(r() * 3);
	for (let q = 0; q < patches; q++) {
		const zone = r() < 0.65 ? "digits" : "labels", limit = zone === "digits" ? grid.w : 7, occupied: { row: number; x: number }[] = [];
		for (let row = 0; row < 3; row++) for (let x = 0; x < limit; x++) {
			if (zone === "digits" ? grid.g[2 * row][x] || grid.g[2 * row + 1][x] : labels[row][x] && labels[row][x] !== " ") occupied.push({ row, x });
		}
		if (!occupied.length) continue;
		const anchor = pick(r, occupied), width = Math.min(limit, 2 + Math.floor(r() * (zone === "digits" ? 6 : 4)));
		const x0 = Math.max(0, Math.min(limit - width, anchor.x - Math.floor(r() * width)));
		const height = anchor.row < 2 && r() < 0.45 ? 2 : 1, targets: StrikeTarget[] = [];
		for (let row = anchor.row; row < anchor.row + height; row++) for (let k = 0; k < width; k++) {
			targets.push({ k, keep: row === anchor.row && x0 + k === anchor.x, place: (start, frames) => ({ fam: "restrike", zone, row, x: x0 + k, start, frames }) });
		}
		strikePatch(r, targets, at + Math.floor(r() * 3), items);
	}
}
// Re-strike plan: plates, the large context panel and Thread Rail's ROOT/count badge, in one shuffled order.
function planRestrike(r: Random, state: MotionState): MotionItem[] {
	const plates = shuffle(r, (["act", "ctx", "mdl", "ext"] as const).filter((key) => !(key === "ctx" && state.wipe)));
	const panel = r() < 0.5;
	const header = (["root", "badge"] as const).filter(() => r() < 0.5);
	const units = shuffle<PlateKey | "panel" | "root" | "badge">(r, [...plates.slice(0, 1 + Math.floor(r() * (panel ? 2 : 3))), ...(panel ? ["panel" as const] : []), ...header]);
	const items: MotionItem[] = [];
	let start = 0;
	for (const unit of units) {
		if (unit === "panel") panelPatches(r, start, items, state);
		else if (unit === "root" || unit === "badge") {
			const limit = unit === "root" ? 6 : unitBadge(state.units).length, patches = r() < 0.6 ? 1 : 2;
			for (let q = 0; q < patches; q++) {
				const width = 1 + Math.floor(r() * limit), x0 = Math.floor(r() * (limit - width + 1));
				strikePatch(r, Array.from({ length: width }, (_, k) => ({ k, place: (s: number, frames: (StrikeKind | null)[]) => ({ fam: "restrike" as const, zone: unit, x: x0 + k, start: s, frames }) })), start + Math.floor(r() * 3), items);
			}
		} else {
			const patches = r() < 0.45 ? 1 : r() < 0.75 ? 2 : 3;
			for (let q = 0; q < patches; q++) {
				const width = 1 + Math.floor(r() * (r() < 0.3 ? 8 : 4)), x0 = Math.floor(r() * (8 - Math.min(width, 8) + 1));
				// Retain one anchor so random drops cannot erase the entire selected plate patch.
				const targets = Array.from({ length: Math.min(width, 8 - x0) }, (_, k) => ({ k, keep: k === 0, place: (s: number, frames: (StrikeKind | null)[]) => ({ fam: "restrike" as const, zone: "plate" as const, key: unit, x: x0 + k, start: s, frames }) }));
				strikePatch(r, targets, start + Math.floor(r() * 3), items);
			}
		}
		start += Math.floor(r() * 5);
	}
	return items;
}

// Current-color styling for one re-strike step: characters stay; plate and dim-surface lettering keeps ≥4.5:1 contrast.
function strikeCell(cur: Cell, kind: StrikeKind, col: number): Cell {
	const bg = cur.bg ?? "field", ink: Hue = bg === "plate" || bg === "surface" ? "secondary" : bg, texture: Hue = bg === "surface" ? "graphic" : bg;
	const wornBg: Hue = bg === "surface" ? "plate" : "surface", flashBg: Hue = bg === "text" ? "secondary" : "text";
	const fadedBg: Hue = bg === "plate" ? "graphic" : "secondary", fadedFg: Hue = bg === "plate" ? "text" : "field";
	if (cur.ch === " ") {
		if (kind === "heavy") return { ch: "▓", fg: texture, bg: "field" };
		if (kind === "mid") return { ch: "▚▞"[col % 2], fg: texture, bg: "field" };
		if (kind === "light") return { ch: "░", fg: texture, bg: "field" };
		if (kind === "void") return { ch: " ", bg: "field" };
		if (kind === "flash") return { ch: " ", bg: flashBg };
		return { ch: " ", bg: wornBg };
	}
	if (kind === "heavy" || kind === "void") return { ch: cur.ch, fg: ink, bg: "field", bold: true };
	if (kind === "mid" || kind === "worn") return { ch: cur.ch, fg: ink, bg: wornBg, bold: true };
	if (kind === "flash") return { ch: cur.ch, fg: "field", bg: flashBg, bold: true };
	return { ch: cur.ch, fg: fadedFg, bg: fadedBg, bold: true };
}
// Panel re-strike: ink-only. Digit blocks keep glyph and occupancy on the field; captions keep their characters.
function panelStrikeCell(cur: Cell, kind: StrikeKind): Cell {
	const ink = cur.fg ?? "text";
	if (cur.ch === "█" || cur.ch === "▀" || cur.ch === "▄") {
		const fg: Hue = kind === "heavy" || kind === "void" ? "plate" : kind === "mid" ? (ink === "graphic" ? "secondary" : "graphic")
			: kind === "flash" ? (ink === "text" ? "primary" : "text") : ink === "secondary" ? "text" : "secondary";
		return { ch: cur.ch, fg, bg: "field", bold: cur.bold };
	}
	if (kind === "heavy" || kind === "void") return { ch: cur.ch, fg: "field", bg: ink, bold: true };
	if (kind === "mid" || kind === "worn") return { ch: cur.ch, fg: ink, bg: "surface", bold: cur.bold };
	if (kind === "flash") return { ch: cur.ch, fg: "field", bg: "text", bold: true };
	return { ch: cur.ch, fg: "text", bg: "plate", bold: cur.bold };
}

/* ---------- rendering ---------- */

// Parent/current display; Home is "~". Stored and looked-up paths stay absolute.
function displayPath(path: string, homePath: string): string {
	if (!isAbsolute(path) || !basename(path)) return safeText(path);
	if (isAbsolute(homePath)) {
		const suffix = relative(homePath, path);
		if (!suffix) return "~";
		if (!isAbsolute(suffix) && suffix !== ".." && !suffix.includes(sep)) return safeText(`~${sep}${suffix}`);
	}
	const parent = dirname(path), elided = dirname(parent);
	return safeText(dirname(elided) === elided ? path : `${basename(parent)}${sep}${basename(path)}`);
}

// After an extension status resets color, restore the footer's base instead of the terminal default.
function restoreBase(status: string, fg: string, bg: string): string {
	return status.replace(/\x1b\[([0-9;:]*)m/g, (sgr, params: string) => {
		let fgReset = false, bgReset = false;
		const list = params.split(";");
		for (let i = 0; i < list.length; i++) {
			const code = Number(list[i].split(":")[0] || 0);
			if (code === 0) fgReset = bgReset = true;
			else if (code === 39) fgReset = true;
			else if (code === 49) bgReset = true;
			else if ((code >= 30 && code <= 38) || (code >= 90 && code <= 97)) fgReset = false;
			else if ((code >= 40 && code <= 48) || (code >= 100 && code <= 107)) bgReset = false;
			if ((code === 38 || code === 48) && !list[i].includes(":")) i += list[i + 1] === "5" ? 2 : list[i + 1] === "2" ? 4 : 0;
		}
		return sgr + (fgReset ? fg : "") + (bgReset ? bg : "");
	});
}

// Gauge cells cover 0..100; a cell lights when any of its slice is used, so only true zero is empty.
const fillCount = (percent: number, n: number) => Math.min(n, Math.max(0, Math.ceil((percent * n) / 100 - 1e-9)));
const tickAt = (value: number, n: number) => Math.min(n - 1, Math.max(0, Math.floor((value * n) / 100 + 1e-9)));
const zoneOf = (i: number, n: number): Tone => (i >= tickAt(90, n) ? "high" : i >= tickAt(70, n) ? "warn" : "ok");

const cell = (ch: string, fg: Hue = "text", bg: Hue = "field", bold = false): Cell => ({ ch, fg, bg, bold });
const blanks = (n: number, bg: Hue = "field", ghost = false): Cell[] => {
	const out = new Array<Cell>(Math.max(0, Math.floor(n)));
	for (let i = 0; i < out.length; i++) out[i] = { ch: " ", bg, ghost };
	return out;
};
const letters = (text: string, style: Style, zone?: Zone): Cell[] => [...text].map((ch) => ({ ch, ...style, zone }));
const widthOf = (parts: Part[]) => parts.reduce((sum, part) => sum + (isRun(part) ? part.width : 1), 0);
const PENDING: Style = { fg: "secondary", bg: "surface" }, LOCKED: Style = { fg: "field", bg: "primary", bold: true };

/** Pure display: the caller supplies snapshots, live host values and the decoration frame. */
export function renderFooter(snapshot: FooterSnapshot, width: number, theme: FooterTheme, frame: FooterFrame = SETTLED_FRAME): string[] {
	if (!Number.isFinite(width) || width < 1) return [];
	const W = Math.floor(width);
	const style = (s: Style) => ({ fg: C[s.fg ?? "text"], bg: C[s.bg ?? "field"], bold: s.bold, underline: s.underline });
	const paint = (text: string, s: Style = {}) => (text ? theme.style(text, style(s)) : "");
	// A chip's trailing pad can wrap alone; blank wrapped rows carry no information.
	const wrap = (text: string, w: number) => {
		const lines = wrapTextWithAnsi(text, Math.max(1, w)).filter((line) => stripTerminalSequences(line).trim());
		return lines.length ? lines : [""];
	};
	const measureRun = (run: string): Run => {
		// Character widths reuse the host cache across differently styled frames.
		const plain = stripTerminalSequences(run), width = visibleWidth(plain);
		// The host truncator segments each SGR-separated fragment independently.
		// A style inserted inside an emoji/cluster can therefore cost more than its
		// visible width. Preserve that clipping behavior, including at serialization.
		// ASCII and these fixed glyphs cannot form a cluster across a style boundary.
		const scanWidth = /^[\x20-\x7e⑂■⌑•□·▪]*$/u.test(plain) ? width
			: run.split(/\x1b\[[0-9;:]*m/g).reduce((sum, fragment) => sum + visibleWidth(fragment), 0);
		return { run, width, scanWidth };
	};
	const runOf = (line: string, w: number): Run => {
		const measured = measureRun(line);
		if (w > 0 && measured.width <= w && measured.scanWidth <= w) return measured;
		return measureRun(truncateToWidth(line, Math.max(0, w), ""));
	};
	const runPad = (line: string, w: number, bg: Hue = "field", ghost = true): Part[] => {
		const run = runOf(line, w);
		return [run, ...blanks(w - run.width, bg, ghost)];
	};
	let scanRows: Set<Part[]> | undefined;
	const serialize = (parts: Part[]) => {
		let out = "", text = "", current: Cell | undefined, columns = 0, scanColumns = 0;
		const flush = () => { if (current && text) out += paint(text, current); text = ""; current = undefined; };
		for (const part of parts) {
			if (isRun(part)) { columns += part.width; scanColumns += part.scanWidth; flush(); if (part.run) out += part.run + RESET; continue; }
			columns++; scanColumns++;
			if (current && (current.fg ?? "text") === (part.fg ?? "text") && (current.bg ?? "field") === (part.bg ?? "field") && !!current.bold === !!part.bold && !!current.underline === !!part.underline) text += part.ch;
			else { flush(); current = part; text = part.ch; }
		}
		flush();
		// Owned glyphs are single-column cells; runs carry their host-measured width.
		// Check the layout budget before skipping the expensive ANSI/grapheme scan.
		return columns <= W && scanColumns <= W && !scanRows?.has(parts) ? out : truncateToWidth(out, W, "");
	};

	/* ---------- boot treatments: the current values, restyled; characters never change ---------- */
	const k = frame.boot, inBoot = k !== Infinity;
	// Semantic path lock: each piece waits on a grey band, then latches acid for one tick (current directory first).
	const pathPaint = (text: string, base: Style, at: number) => {
		if (!inBoot) return paint(text, base);
		const pieces = text.split(sep), n = pieces.length;
		return pieces.map((piece, i) => {
			const lock = at + (n - 1 - i) * 2;
			return (i ? paint(sep, k < at + (n - 1) * 2 ? PENDING : base) : "")
				+ paint(piece, k < lock ? PENDING : k === lock ? LOCKED : base);
		}).join("");
	};
	const settleStyle = (base: Style, at: number) => (inBoot && k < at ? PENDING : base);
	// Polarity latch: a chip shows inverted, then flips solid / inverted / solid.
	const chip = (text: string, s: Style, at?: number) => {
		const inverted = inBoot && at !== undefined && (k - at < 1 || k - at === 2);
		return paint(` ${text} `, inverted ? (s.bg === "field" || !s.bg ? { fg: "field", bg: s.fg, bold: true } : { fg: s.bg, bg: "field", bold: true }) : s);
	};
	const gap = (bg: Hue = "field") => paint(" ", { bg });

	/* ---------- field values ---------- */
	const checkout = (info: CheckoutInfo, branchAt: number, gitAt: number) => {
		const branch = info.branch ?? `detached${info.revision ? ` @${info.revision}` : ""}`;
		// Colored text, not a plate: a plate would merge with the acid gauge fill directly below.
		const [label, ink]: [string, Hue] = info.dirty === null ? ["status unavailable", "text"] : info.dirty ? ["modified", "warn"] : ["clean", "primary"];
		const status = paint(label, settleStyle({ fg: ink, bold: true }, gitAt));
		return paint("⑂", settleStyle({ fg: "secondary" }, branchAt)) + gap() + pathPaint(safeText(branch), { fg: "secondary" }, branchAt) + gap() + status + (info.error ? paint(` (${safeText(info.error)})`, { fg: "warn" }) : "");
	};
	const git = snapshot.workspace?.git, github = snapshot.workspace?.github;
	// A branch identifies its checkout within a repository: Git keeps one branch out of two worktrees and Active
	// is a checkout root. The title names the repository, so the path is replaced only when both are known.
	const branchOnly = git?.kind === "repository" && git.active.branch !== null && github?.kind === "repository";
	const active = branchOnly ? checkout(git.active, BOOT_AT.active, BOOT_AT.git) : pathPaint(displayPath(snapshot.activePath, snapshot.homePath), { bold: true }, BOOT_AT.active);
	// Otherwise directory first: wrap the complete Active path before its unnumbered Git details.
	let gitDetails: string | undefined;
	if (git?.kind === "repository" && !branchOnly) gitDetails = checkout(git.active, BOOT_AT.branch, BOOT_AT.git);
	else if (git?.kind === "unknown") gitDetails = paint(`Git unavailable (${safeText(git.reason)})`, { fg: "warn" });
	else if (!git) gitDetails = paint("Git pending", { fg: "secondary" });
	// Pi's working directory never follows Active; name it only when they differ (exact stored paths).
	const cwd = snapshot.launchPath === snapshot.activePath ? undefined
		: paint("cwd ", settleStyle({ fg: "secondary" }, BOOT_AT.launch)) + pathPaint(displayPath(snapshot.launchPath, snapshot.homePath), { fg: "secondary" }, BOOT_AT.launch);
	// A square marks every GitHub title: acid for a known repository, otherwise the state text's own color.
	let title: string | undefined;
	if (github?.kind === "repository") {
		const pr = snapshot.pullRequest, name = safeText(github.name), settle = BOOT_AT.github + (name.split(sep).length - 1) * 2;
		title = paint("■", settleStyle({ fg: "primary" }, BOOT_AT.github)) + gap() + pathPaint(name, { bold: true }, BOOT_AT.github);
		if (pr.kind === "open") title += paint(" · ", settleStyle({ fg: "secondary" }, settle)) + paint(`PR #${pr.number}`, settleStyle({ bold: true }, settle));
		else if (pr.kind === "unavailable") title += paint(" · ", { fg: "secondary" }) + paint(`PR unavailable (${safeText(pr.reason)})`, { fg: "warn" });
	} else if (github?.kind === "unknown") title = paint(`■ GitHub unavailable (${safeText(github.reason)})`, { fg: "warn" });
	else if (!github) title = paint("■ GitHub pending", { fg: "secondary" });
	// Word emphasis travels word by word; the thinking level latches acid last.
	const word = (text: string, base: Style, w: number) => {
		if (!inBoot) return paint(text, base);
		const at = BOOT_AT.model, hit = at + Math.max(0, w) * 2;
		if (w < 0) return paint(text, k < at + 6 ? PENDING : base);
		return paint(text, k < hit ? PENDING : k < hit + 2 ? (w === 3 ? LOCKED : { fg: "text", bg: "plate", bold: true }) : base);
	};
	const band: Hue = "surface";
	const model = (snapshot.model ? word(safeText(snapshot.model.provider), { bold: true, bg: band }, 0) + word("/", { bold: true, bg: band }, -1) + word(safeText(snapshot.model.id), { bold: true, bg: band }, 1) : word("no-model", { bold: true, bg: band }, 0))
		+ word(" · ", { fg: "secondary", bg: band }, -1) + word("thinking ", { fg: "secondary", bg: band }, 2) + word(safeText(snapshot.thinking), { fg: "primary", bold: true, bg: band }, 3);
	// Pre-styled run: never eligible for ambient ghosts/re-strikes or boot restyling.
	const ponytail = snapshot.ponytail && PONYTAIL[snapshot.ponytail];
	// While Ponytail reports activity the icon alternates with a small pink light (the CMP pink); motion off holds it lit.
	const lit = ponytailLit(snapshot) && (frame.pulse === null || lightOn(frame.pulse));
	const ponytailPlate = ponytail ? gap() + paint(" ", { fg: "field", bg: "text", bold: true })
		+ paint(lit ? "•" : "⌑", { fg: lit ? "pink" : "field", bg: "text", bold: true }) + paint(" PNYTL // ", { fg: "field", bg: "text", bold: true })
		+ [...ponytail.code].map((ch, i) => paint(ch, { fg: confirmedPonytail(snapshot.ponytail) && snapshot.ponytail !== "off" && ((frame.ponytailMask ?? 0) & (1 << i)) ? "field" : ponytail.ink, bg: "text", bold: true })).join("")
		+ paint(" ", { fg: "field", bg: "text", bold: true }) + gap() : "";
	// The same for pre-styled single-width text (single-width characters only) whose first cell is at x: its settled part, the
	// front repainted from its characters, and nothing past the front; callers pad with blank field.
	const drawInText = (text: string, x: number, front: number) => {
		if (front === Infinity) return text;
		const settled = Math.max(0, front - USAGE_SWEEP_CELLS_PER_TICK - x);
		return truncateToWidth(text, settled, "") + paint([...stripTerminalSequences(text)].slice(settled, Math.max(0, front - x)).join(""), LOCKED);
	};
	// Tatsu components break only between components, so one never splits while it fits a line; one wider than its line
	// wraps like any other status. The first line holds `first` cells after any `lead` (the minimal layout's label).
	const tatsuLines = (parts: string[], first: number, rest: number, lead: boolean) => {
		const lines = [""];
		let used = 0, cap = first;
		for (const part of parts) {
			const w = visibleWidth(part), gapWidth = used ? TATSU_GAP : 0;
			if (used + gapWidth + w > cap && (used || lead)) { lines.push(""); used = 0; cap = rest; lead = false; }
			if (w > cap) { const pieces = wrap(part, cap); lines[lines.length - 1] = pieces[0]; lines.push(...pieces.slice(1)); used = cap; continue; }
			lines[lines.length - 1] += (used ? paint(" ".repeat(TATSU_GAP)) : "") + part;
			used += (used ? TATSU_GAP : 0) + w;
		}
		return lines;
	};
	const mode = theme.getColorMode();
	// Keep every status and its own colors; sorting keeps row order stable. Boot settles statuses one after another.
	const tatsu = activeTatsu(snapshot), statusMap = new Map(snapshot.statuses);
	if (tatsu) statusMap.set("tatsu-status", "");
	const entries = [...statusMap].sort(([a], [b]) => a.localeCompare(b));
	const statuses = entries.map(([key, status], g) => {
		const at = BOOT_AT.ext + g * 3, value = at + 3;
		const base: Style = !inBoot || k > value + 1 ? {} : k < at ? { fg: "secondary" } : k < at + 2 ? { bold: true } : k === value ? { fg: "primary", bold: true } : k === value + 1 ? { bold: true } : {};
		const fg = foregroundAnsi(C[base.fg ?? "text"], mode) + (base.bold ? "\x1b[1m" : ""), bg = backgroundAnsi(C.field, mode);
		if (key === "tatsu-status" && tatsu) {
			const warm = frame.tatsuWarm, held = inBoot || warm !== undefined;
			const parts = tatsu.components.map((c, p) => {
				const look = tatsuLook(c), latch = held ? undefined : frame.tatsuLatches?.[c.component], checking = c.state === "checking" && !held;
				// Checking fades only the code's colour; the label and grey shape stay put.
				const ink: Style = latch === 0 ? LOCKED : latch === 1 || latch === 2 ? { fg: "field", bg: look.ink, bold: true } : { fg: look.ink, bold: true };
				const codeInk: Style = checking && latch === undefined && frame.tatsuCheck !== undefined ? { ...ink, fg: TATSU_CHECK_FADE_INKS[frame.tatsuCheck % TATSU_CHECK_FADE_INKS.length] } : ink;
				const beacon = held || latch !== undefined ? undefined : frame.tatsuBeacon;
				const attention = c.state === "behind" || c.state === "repair";
				const shape = checking ? TATSU_CHECK_GLYPHS[(frame.tatsuCheck ?? 0) % TATSU_CHECK_GLYPHS.length] : attention && beacon !== undefined && beacon < 2 ? "▴" : look.shape;
				const shapeInk = attention && beacon !== undefined && beacon > 0 ? { ...ink, fg: "warnDim" as const } : ink;
				// The dim label leaves the coloured state to carry the reading. The warm-up replaces EXT's boot treatment.
				const tone = (style: Style, role: keyof typeof TATSU_WARM_ROLE): Style => warm === undefined ? style : { ...style, fg: tatsuWarmInk(style.fg ?? "text", warm, p, role) };
				return paint(c.component === "tatsu-cli" ? "TCLI" : "AWKS", tone({ fg: "graphic" }, "label")) + paint(" ") + paint(shape, tone(shapeInk, "shape")) + paint(" ", ink) + paint(look.code, tone(codeInk, "code"));
			});
			return { parts, text: "" };
		}
		return { parts: undefined, text: fg + bg + restoreBase(safeText(status, true), fg, bg) };
	});

	/* ---------- USG: one fixed column per provider, squares over countdowns; motion restyles, never moves ---------- */
	// Text under a part may spill past its right edge into the following blank; parts never overlap.
	type UsagePart = { top: string; bottom: string; width: number; bottomWidth: number };
	type UsageGroup = UsagePart & { parts: UsagePart[]; reserve: number; alone?: boolean };
	const joinParts = (parts: UsagePart[], space: number): UsagePart => {
		let top = "", bottom = "", x = 0, end = 0;
		parts.forEach((part, i) => {
			if (i) { top += paint(" ".repeat(space)); x += space; }
			top += part.top;
			if (part.bottomWidth) { bottom += paint(" ".repeat(Math.max(0, x - end))) + part.bottom; end = Math.max(x, end) + part.bottomWidth; }
			x += part.width;
		});
		return { top, bottom, width: x, bottomWidth: end };
	};
	const usagePart = (top: string, topWidth: number, width: number, bottom = "", bottomWidth = 0): UsagePart =>
		({ top: top + paint(" ".repeat(Math.max(0, width - topWidth))), bottom, width, bottomWidth });
	// A column's room on a line includes the spill its state word could need, so wrap points never depend on state.
	const footprint = (group: UsageGroup) => Math.max(group.width + group.reserve, group.bottomWidth);
	const usageNow = finite(snapshot.usage?.now), lastLatch = USAGE_FILL_TICKS - 1;
	const usageGroups = usageRow(snapshot).map((provider): UsageGroup => {
		const look = USAGE[provider.provider], age = staleAge(provider, usageNow), data = provider.data, fill = frame.usageFill?.[provider.provider];
		// Fill-in: each cell shows its current glyph in graphic grey, white on its tick, then its settled ink.
		const cells = (glyphs: string, settled: (j: number) => Style) =>
			[...glyphs].map((ch, j) => paint(ch, fill === undefined || fill > j ? settled(j) : fill === j ? { fg: "text" } : { fg: "graphic" })).join("");
		// Text waits in graphic grey until the last cell above it latches.
		const ink = (s: Style): Style => (fill !== undefined && fill < lastLatch ? { fg: "graphic" } : s);
		const grey = () => ({ fg: "graphic" }) as Style;
		const declared = look.windows.length, width = usageColumn(declared);
		// Stale dims the tag to the unknown grey: CLD's and KMI's 50% mixes are under 3:1 on black, too faint for text,
		// so every stale tag uses the one grey.
		const tagStyle: Style = age === undefined ? { fg: look.lit, bold: true } : { fg: "graphic" };
		const parts = [usagePart(paint(look.tag, tagStyle), 3, 3, age ? paint(age, ink({ fg: "warn" })) : "", age?.length ?? 0)];
		if (!data) {
			// One grey cell group per declared slot; the state word sits under the first.
			const word = provider.failure ?? "pending", glyphs = (provider.failure ? "?" : "·").repeat(USAGE_SQUARES);
			for (let n = 0; n < declared; n++) {
				parts.push(n ? usagePart(cells(glyphs, grey), USAGE_SQUARES, USAGE_SQUARES)
					: usagePart(cells(glyphs, grey), USAGE_SQUARES, USAGE_SQUARES, paint(word, ink({ fg: provider.failure ? "warn" : "secondary" })), word.length));
			}
		} else if (!USAGE_WINDOWS.some((key) => data.windows[key])) parts.push(usagePart(cells("none", () => ({ fg: "secondary" })), 4, width - 4));
		else for (const key of usageSlots(provider.provider, data.windows)) {
			const window = data.windows[key];
			if (!window) { parts.push(usagePart("", 0, USAGE_SQUARES)); continue; } // a declared window the sample lacks stays blank
			const remaining = remainingOf(window), effect = frame.usage?.[`${provider.provider}/${key}`];
			if (remaining === null) { parts.push(usagePart(cells("?".repeat(USAGE_SQUARES), grey), USAGE_SQUARES, USAGE_SQUARES, paint("?", ink({ fg: "secondary" })), 1)); continue; }
			const lit = litOf(remaining), burn = effect?.burn, pulse = effect?.edge === undefined ? undefined : EDGE_PULSE[effect.edge];
			const text = countdown(window.resetsAt, usageNow);
			// Every square is `■`; lit and lost differ by style, and a settled lost square is the shared ghost grey. The pulse
			// only resizes and dims the lit edge square; a burn only restyles the lost squares until it settles.
			const glyphs = Array.from({ length: USAGE_SQUARES }, (_, i) => (pulse && i === lit - 1 ? pulse.glyph : "■")).join("");
			const squares = cells(glyphs, (i): Style => {
				if (i < lit) return { fg: pulse?.dim && i === lit - 1 ? look.used : look.lit };
				if (!burn || i >= burn.from) return { fg: "usageGhost" };
				const e = burn.elapsed;
				return { fg: e < BURN_STEPS[0] ? "text" : e < BURN_STEPS[1] ? look.lit : e < BURN_STEPS[2] ? look.mid : look.used };
			});
			// Countdowns fit their slot; only a pathological one (beyond 9999999d) widens it rather than overlap.
			parts.push(usagePart(squares, USAGE_SQUARES, Math.max(USAGE_SQUARES, text.length), paint(text, ink({ fg: "secondary" })), text.length));
		}
		return { ...joinParts(parts, 1), parts, reserve: Math.min(USAGE_SPILL, Math.max(0, 4 + USAGE_WORD - width)) };
	});
	// Below 40 columns a group wider than the line splits between its tag and window slots, and a slot wider still
	// wraps on its own rows: values are never clipped. Split pieces never share a line with another provider.
	const splitGroup = (group: UsageGroup, w: number): UsageGroup[] => {
		if (footprint(group) <= w) return [group];
		const out: UsageGroup[] = [];
		let run: UsagePart[] = [];
		const extent = (parts: UsagePart[]) => { const joined = joinParts(parts, 1); return Math.max(joined.width, joined.bottomWidth); };
		const push = () => { if (run.length) out.push({ ...joinParts(run, 1), parts: run, reserve: 0, alone: true }); run = []; };
		for (const part of group.parts) {
			if (run.length && extent([...run, part]) > w) push();
			if (extent([part]) <= w) { run.push(part); continue; }
			push();
			for (const text of [part.top, part.bottom]) for (const piece of wrap(text, w)) {
				if (stripTerminalSequences(piece).trim()) out.push({ top: piece, bottom: "", width: visibleWidth(piece), bottomWidth: 0, parts: [], reserve: 0, alone: true });
			}
		}
		push();
		return out;
	};
	// Whole provider columns wrap together with their text row; `first` is the room left on the first line.
	const usageLines = (groups: UsageGroup[], first: number, rest: number) => {
		const lines: { top: string; bottom?: string }[] = [];
		let line: UsageGroup[] = [];
		const flush = () => {
			if (!line.length) return;
			const joined = joinParts(line, USAGE_GAP);
			lines.push({ top: joined.top, bottom: joined.bottomWidth ? joined.bottom : undefined });
			line = [];
		};
		for (const group of groups) {
			const used = line.reduce((sum, g) => sum + g.width + USAGE_GAP, 0);
			if (line.length && (group.alone || line[0].alone || used + footprint(group) > (lines.length ? rest : first))) flush();
			line.push(group);
		}
		flush();
		return lines;
	};
	// Row boot: a draw-in front sweeps each USG line from its left edge (the plate's, on the first line), the text row
	// one tick behind. Cells it has not reached are blank, like the header corners drawing in; the front latches for
	// one tick, like the path lock; cells behind it are settled. Every drawn cell shows its current character.
	const sweep = USAGE_SWEEP_CELLS_PER_TICK, usageTick = frame.usageBoot;
	const topFront = usageTick === undefined ? Infinity : (usageTick + 1) * sweep, textFront = usageTick === undefined ? Infinity : usageTick * sweep;
	const drawIn = (x: number, c: Cell, front: number): Cell => (x >= front ? { ch: " ", bg: "field" } : x >= front - sweep ? { ch: c.ch, ...LOCKED } : c);
	// The USG plate is the Marathon pink (the CMP 3–4 plate pair), black bold lettering at 6.1:1.
	const usgPlate = letters(` ${LABEL.usg}`.padEnd(8), USG_PLATE);

	const { percent, tone, windowText, tokensText } = contextOf(snapshot);
	const readoutText = `${tokensText}${windowText ? `/${windowText}` : ""}`;
	const tagText = TAG[tone];
	const tagStyle: Style = frame.tagFlash ? { fg: "field", bg: tone === "unknown" ? "text" : FILL[tone], bold: true } : { fg: tone === "unknown" ? "secondary" : FILL[tone], bold: true };
	const tag = tagText ? chip(tagText, tagStyle, BOOT_AT.tag) : "";

	/* ---------- activity: lamp, ROOT and the exact AU count ---------- */
	const activity = snapshot.activity, units = knownCount(activity?.units), pulse = frame.pulse;
	// CMP is always shown. Boot swaps the approved pair for two ticks, which keeps its contrast.
	const compactions = knownCount(snapshot.compactions), cmpText = cmpPlate(compactions), cmpBase = cmpStyle(compactions);
	const cmp = inBoot && k < 2 ? { ...cmpBase, fg: cmpBase.bg, bg: cmpBase.fg } : cmpBase;
	const lamp: Cell = !activity ? cell("╱", "graphic", "surface")
		: cell(" ", "text", activity.working && (pulse === null || lampOn(pulse)) ? "primary" : "surface");
	const badgeStyle: Style = units === undefined ? GREY_PLATE : units === 0 ? { fg: "secondary", bg: "surface" } : { fg: "field", bg: "text", bold: true };
	const badge = letters(unitBadge(units), badgeStyle, "badge");
	const root = letters(" ROOT ", { fg: "field", bg: "primary", bold: true }, "root");
	const rail: Cell[] = [];
	for (let q = 0; q < PULSE_CAP; q++) {
		if (q >= Math.min(PULSE_CAP, units ?? 0)) { rail.push(cell("·", "graphic"), cell("·", "graphic")); continue; }
		const side = pulse === null ? 0 : markSide(pulse, q);
		rail.push(side ? cell("·", "graphic") : cell("█", "primary"), side ? cell("█", "primary") : cell("·", "graphic"));
	}

	/* ---------- minimal fallback where the frame and plates cannot fit ---------- */
	if (W < 40) {
		const lines: string[] = [];
		const add = (label: string, s: Style, value: string) => {
			for (const line of wrap(paint(` ${label} `, s) + gap() + value, W)) lines.push(serialize(runPad(line, W)));
		};
		for (const line of wrap(paint(cmpText, cmp) + (title ? gap() + title : ""), W)) lines.push(serialize(runPad(line, W)));
		// The lamp is a solid glyph here so wrapping never drops it as blank.
		const lampText = paint(lamp.ch === " " ? "█" : lamp.ch, lamp.ch === " " ? { fg: lamp.bg, bg: lamp.bg } : lamp);
		for (const line of wrap(lampText + gap() + paint(" ROOT ", root[0]) + gap() + paint(badge.map((c) => c.ch).join(""), badgeStyle), W)) lines.push(serialize(runPad(line, W)));
		if (cwd) for (const line of wrap(cwd, W)) lines.push(serialize(runPad(line, W)));
		add(LABEL.act, PLATE.ok, active);
		if (gitDetails) for (const line of wrap(gitDetails, W)) lines.push(serialize(runPad(line, W)));
		add(LABEL.ctx, PLATE[tone], chip(readoutText, READOUT_CHIP[tone]) + (tag ? gap() + tag : ""));
		add(LABEL.mdl, { fg: "field", bg: "text", bold: true }, model);
		if (ponytailPlate) for (const line of wrap(ponytailPlate, W)) lines.push(serialize(runPad(line, W)));
		if (usageGroups.length) {
			// Inline label, then the first group beside it when it fits; text rows stay under their squares.
			const fitted = usageGroups.flatMap((group) => splitGroup(group, W));
			const label = paint(` ${LABEL.usg} `, USG_PLATE) + gap(), inline = footprint(fitted[0]) <= W - 9;
			if (!inline) lines.push(serialize(runPad(drawInText(label, 0, topFront), W)));
			// The row boot sweeps every line from its own left edge; the blank label column stays blank.
			usageLines(fitted, inline ? W - 9 : W, W).forEach((line, i) => {
				const lead = inline && i === 0;
				lines.push(serialize(runPad(drawInText((lead ? label : "") + line.top, 0, topFront), W)));
				if (line.bottom) lines.push(serialize(runPad((lead ? paint(" ".repeat(9)) : "") + drawInText(line.bottom, lead ? 9 : 0, textFront), W)));
			});
		}
		statuses.forEach((status, i) => {
			let label = i === 0 ? paint(` ${LABEL.ext} `, GREY_PLATE) + gap() : "";
			// At sub-plate widths the label cannot share a line with the first Tatsu part.
			if (status.parts && label && W < 9) {
				for (const line of wrap(label, W)) lines.push(serialize(runPad(line, W)));
				label = "";
			}
			const statusLines = status.parts ? tatsuLines(status.parts, label ? W - 9 : W, W, !!label).map((line, j) => (j === 0 ? label + line : line)) : wrap(label + status.text, W);
			for (const line of statusLines) lines.push(serialize(runPad(line, W)));
		});
		return lines;
	}

	/* ---------- framed plate layout ---------- */
	const G = W >= 60 ? 2 : 1, P = 8, M = W - 2 * G, FW = M - P - 1, MID = Math.floor(W / 2);
	const bootWipe = (order: number) => Math.max(0, Math.min(P, (k - order * 2) * 3));
	const plate = (key: PlateKey, s: Style, wipe: number, previous?: Style): Cell[] => {
		const outline: Style = { fg: s.bg === "plate" ? "secondary" : s.bg, bold: true };
		return [...` ${LABEL[key]}`.padEnd(P)].map((ch, x) => ({ ch, ...(x < wipe ? s : previous ?? outline), bold: true, zone: "plate" }));
	};
	const plateRows = new Map<PlateKey, number>();
	// Continuation rows leave the plate column as plain field: no tabs below plates.
	const fieldRows = (plateCells: Cell[] | undefined, value: string, w: number, bg: Hue = "field"): Part[][] =>
		wrap(value, w).map((line, i) => [...(i === 0 && plateCells ? plateCells : blanks(P)), ...blanks(1, bg, true), ...runPad(line, w, bg)]);

	// Large numeral beside the context block when it fits with a full gauge.
	const target = numeralGrid(percent);
	const grid = target && (frame.numeral ? numeralAt(target, frame.numeral.from, frame.numeral.progress, frame.numeral.seed) : target);
	const labels = panelLabels(percent, windowText), labelWidth = Math.max(7, ...labels.map((text) => text.length));
	let side = 0, BW = FW;
	if (W >= 100 && grid) {
		side = grid.w + labelWidth + 6;
		if (FW - side - 12 >= Math.max(12, readoutText.length + 2)) BW = FW - side;
		else side = 0;
	}
	const numeral = side > 0 ? grid : undefined;
	const sideStart = G + P + 1 + BW;

	const block: Part[][] = [];
	const actRows = fieldRows(plate("act", PLATE.ok, bootWipe(0)), active, BW);
	plateRows.set("act", block.length); block.push(...actRows);
	if (gitDetails) block.push(...fieldRows(undefined, gitDetails, BW));
	{
		let n = Math.min(60, BW - 12), inline = n >= 12 && readoutText.length + 2 <= tickAt(70, n);
		if (!inline) n = Math.min(60, BW);
		const lit = percent === undefined ? 0 : fillCount(percent, n), m70 = tickAt(70, n), m90 = tickAt(90, n);
		const span = inline ? readoutText.length + 2 : 0;
		const gauge: Cell[] = [];
		for (let i = 0; i < n; i++) {
			const z = zoneOf(i, n), mark = i === m70 || i === m90, flash = (i === m70 && frame.flash70) || (i === m90 && frame.flash90);
			let c: Cell;
			if (i < span) {
				const j = i - 1, ch = j < 0 || j >= readoutText.length ? " " : readoutText[j];
				c = i < lit ? cell(ch, "field", FILL[z], true) : cell(ch, "text", percent === undefined ? "surface" : TRACK[z], true);
				if (inBoot && ch !== " " && k < BOOT_AT.readout + Math.floor(j / 2)) c = { ...c, bold: false, underline: true };
				gauge.push(c);
				continue;
			}
			if (percent === undefined) c = cell("╱", "graphic", "surface");
			else if (i < lit) c = cell("█", flash ? "text" : FILL[z], flash ? "text" : FILL[z]);
			else if (flash) c = cell("┃", "field", "text", true);
			else if (mark) c = cell("┃", i === m90 ? "high" : "warn", TRACK[z], true);
			else c = cell(" ", "text", TRACK[z]);
			// Texture acquisition at the true extent: lit cells show ░ → ▒ → solid; the track powers up behind.
			if (inBoot) {
				const start = BOOT_AT.gauge + Math.floor(hash(i + 1, 3, frame.bootSeed) * 9);
				if (k < start + (i < lit ? 2 : 0)) {
					if (i < lit) c = { ...c, ch: k < start ? "░" : "▒", fg: c.fg === "text" ? c.bg : c.fg, bg: TRACK[z] };
					else c = { ...c, bg: "field" };
				}
			}
			gauge.push(c);
		}
		// Fill-only bar glitch: lit cells outside the padded readout, never the fill-edge cell.
		if (frame.glitch && lit > 0) {
			const eligible: number[] = [];
			for (let i = span; i < lit; i++) if (lit === 1 || i !== lit - 1) eligible.push(i);
			const level = Math.min(frame.glitch.level, levelOf(percent)), cfg = GLITCH[level], r = random(frame.glitch.seed);
			if (cfg && eligible.length) {
				const runs = between(r, cfg.runs);
				for (let q = 0; q < runs; q++) {
					const length = between(r, cfg.len), start = Math.floor(r() * eligible.length);
					for (let j = 0; j < length && start + j < eligible.length; j++) {
						const i = eligible[start + j], z = zoneOf(i, n), ch = lit === 1 ? "▓" : cfg.glyphs[Math.floor(r() * cfg.glyphs.length)];
						gauge[i] = cell(ch, level === 3 && r() < 0.12 ? "text" : FILL[z], TRACK[z]);
					}
				}
			}
		}
		const ctxValue = chip(readoutText, READOUT_CHIP[tone]) + (tag ? gap() + tag : "");
		const ctxPlate = plate("ctx", PLATE[tone], Math.min(frame.wipe?.cells ?? P, bootWipe(1)), frame.wipe ? PLATE[frame.wipe.from] : undefined);
		const after: Part[] = inline && tag ? [cell(" "), runOf(tag, BW - n - 1)] : [];
		plateRows.set("ctx", block.length);
		block.push([...ctxPlate, ...blanks(1, "field", true), ...gauge, ...after, ...blanks(BW - n - widthOf(after))]);
		if (!inline) for (const line of wrap(ctxValue, BW)) block.push([...blanks(P), cell(" "), ...runPad(line, BW, "field", false)]);
		// Calibration scale under the gauge, as width permits; 0/100/70/90/50 win label collisions; no tick glyphs.
		const limit = Math.min(n + 3, BW), scale = blanks(limit), used = new Array<boolean>(limit).fill(false);
		for (const value of n >= 50 ? [0, 100, 70, 90, 50, 10, 20, 30, 40, 60, 80] : [0, 100, 70, 90, 50]) {
			const text = String(value), start = tickAt(value, n), end = start + text.length, at = SCALE_T0 + value / 10;
			if (end > limit || used.slice(Math.max(0, start - 1), end + 1).some(Boolean)) continue;
			[...text].forEach((ch, j) => {
				used[start + j] = true;
				scale[start + j] = k < at ? cell(" ") : k === at ? cell(ch, "primary", "field", true)
					: cell(ch, value === 70 ? "warn" : value === 90 ? "high" : "secondary", "field", value === 70 || value === 90);
			});
		}
		block.push([...blanks(P), cell(" "), ...scale, ...blanks(BW - limit)]);
	}

	// The numeral sits beside the last three block rows, ending at the gauge scale.
	const spine: Hue = frame.tagFlash ? "text" : FILL[tone];
	const numeralRow0 = block.length - 3;
	const sideCells = (ri: number): Cell[] => {
		if (!numeral) return [];
		if (ri < 0 || ri > 2) return blanks(side);
		const big: Cell[] = Array.from({ length: numeral.w }, (_, x) => {
			const top = numeral.g[2 * ri][x], bottom = numeral.g[2 * ri + 1][x];
			const c = !top && !bottom ? cell(" ") : top && !bottom ? cell("▀", top) : !top ? cell("▄", bottom!) : top === bottom ? cell("█", top) : cell("▀", top, bottom!);
			return { ...c, zone: "digits" };
		});
		const caption = letters(labels[ri].padEnd(labelWidth), ri === 0 ? { fg: tone === "unknown" ? "secondary" : FILL[tone], bold: true } : { fg: "secondary" }, "labels");
		return [...blanks(2), cell("▐", spine), cell(" "), ...big, cell(" "), ...caption, cell(" ")];
	};

	/* ---------- header: CMP plate, GitHub title, corners, standalone ┼ and the activity group ---------- */
	const drawn = inBoot ? k * 8 : W;
	const titleNatural = title ? visibleWidth(title) : 0;
	type Placement = { x: number; cells: Cell[] };
	const group = (withRail: boolean, x?: number, badgeAt?: number): Placement => {
		const head = [lamp, cell(" "), ...root];
		if (x === undefined || badgeAt === undefined) {
			const cells = [...head, cell(" "), ...(withRail ? [...rail, cell(" ")] : []), ...badge];
			return { x: W - G - 1 - cells.length, cells };
		}
		const fill = badgeAt - (x + head.length) - (withRail ? 1 + rail.length : 0);
		return { x, cells: [...head, ...(withRail ? [cell(" "), ...rail] : []), ...blanks(fill), ...badge] };
	};
	let place: Placement, ownRow = false;
	// The CMP plate sits at G; title text starts on the content column of the rows below.
	const titleStart = G + P + 1;
	const fits = (p: Placement) => p.x >= G + 1 && p.x - 1 >= (title ? titleStart + titleNatural : G + P);
	if (numeral) {
		// ROOT's right edge meets the context divider; the badge's left background edge meets the captions.
		const rootEnd = sideStart + 3, lab0 = sideStart + 5 + numeral.w, x = rootEnd - 8;
		const badgeAt = lab0 + badge.length <= W - G - 1 ? lab0 : W - G - 1 - badge.length;
		place = badgeAt > rootEnd ? group(rootEnd + 1 + rail.length + 1 <= badgeAt, x, badgeAt) : group(false);
		ownRow = !fits(place);
	} else {
		const candidates = [group(true), group(false)];
		place = candidates.find(fits) ?? (ownRow = true, candidates.find((p) => p.x >= G + 1) ?? candidates[1]);
	}
	const titleWidth = Math.max(1, (ownRow ? W - G - 1 : place.x - 1) - titleStart);
	const titleLines = title ? wrap(title, titleWidth) : [];
	// Absolute placement on one row; untouched columns are ghostable field.
	const placeRow = (items: { x: number; parts: Part[] }[]): Part[] => {
		const row: Part[] = [];
		let col = 0;
		for (const item of items.sort((a, b) => a.x - b.x)) {
			if (item.x < col) continue;
			row.push(...blanks(item.x - col, "field", true), ...item.parts);
			col = item.x + widthOf(item.parts);
		}
		return [...row, ...blanks(W - col, "field", true)];
	};
	const shown = (x: number, c: Cell): Cell => (x < drawn ? c : { ch: " ", bg: "field" });
	const activityItem = (p: Placement) => ({ x: p.x - 1, parts: [{ ch: " ", bg: "field" as Hue }, ...p.cells, { ch: " ", bg: "field" as Hue }] });
	const header: Part[][] = [];
	{
		const items: { x: number; parts: Part[] }[] = [];
		const corner = (x: number, ch: string): Cell => ({ ...shown(x, cell(ch, "graphic")), ghost: true, frame: x < drawn });
		items.push({ x: 0, parts: [...(G === 2 ? "┏━" : "┏")].map((ch, i) => corner(i, ch)) });
		items.push({ x: W - G, parts: [...(G === 2 ? "━┓" : "┓")].map((ch, i) => corner(W - G + i, ch)) });
		items.push({ x: G, parts: letters(cmpText, cmp) });
		let titleEnd = G + P;
		if (titleLines.length) {
			const run = runOf(titleLines[0], titleWidth);
			items.push({ x: titleStart, parts: [run] });
			titleEnd = titleStart + run.width;
		}
		const groupStart = ownRow ? W - G - 1 : place.x - 1;
		if (MID - 2 > titleEnd && MID + 2 < groupStart) {
			const mid = MID + frame.cal;
			items.push({ x: MID - 2, parts: Array.from({ length: 5 }, (_, i) => MID - 2 + i === mid ? shown(mid, frame.cal ? cell("┼", "primary", "field", true) : cell("┼", "graphic")) : { ch: " ", bg: "field" as Hue }) });
		}
		if (!ownRow) items.push(activityItem(place));
		header.push(placeRow(items));
		for (const line of titleLines.slice(1)) header.push([...blanks(P + 1, "field", true), ...runPad(line, M - P - 1)]);
		if (ownRow) header.push(placeRow([activityItem(place)]).slice(G, W - G));
	}
	const actRow = ownRow ? header.length - 1 : 0;

	// One framed row separates the header from the numbered rows: blank, or Pi's cwd when it differs from Active,
	// so the numbered plates stay together and the footer height does not change when the agent switches.
	const body: Part[][] = cwd ? fieldRows(undefined, cwd, FW) : [blanks(M, "field", true)];
	const blockStart = header.length + body.length;
	for (const key of ["act", "ctx"] as const) if (plateRows.has(key)) plateRows.set(key, plateRows.get(key)! + blockStart);
	block.forEach((row, i) => body.push([...row, ...sideCells(i - numeralRow0)]));
	plateRows.set("mdl", header.length + body.length);
	const modelPlate = plate("mdl", { fg: "field", bg: "text", bold: true }, bootWipe(3));
	// Content column of PNYTL's left gap. Beside the numeral the white body starts on the digits' first column and
	// the band continues after its right gap; otherwise the plate right-aligns.
	const plateAt = numeral ? BW + 3 : Math.max(0, FW - 18);
	const bandTail = paint(" ".repeat(Math.max(0, FW - plateAt - 18)), { bg: band });
	if (ponytailPlate && visibleWidth(model) <= plateAt) {
		body.push(...fieldRows(modelPlate, model + paint(" ".repeat(plateAt - visibleWidth(model)), { bg: band }) + ponytailPlate + bandTail, FW, band));
	} else {
		body.push(...fieldRows(modelPlate, model, FW, band));
		if (ponytailPlate) body.push(...fieldRows(undefined, paint(" ".repeat(plateAt), { bg: band }) + ponytailPlate + bandTail, FW, band));
	}
	// USG content is pre-styled runs and its plate has no zone, so the footer boot, ghosts and re-strikes never reach
	// it; only its own row boot and fill-in restyle it. Wrapped lines draw in from their own left edge, the plate
	// column's, whose blank cells stay blank.
	usageLines(usageGroups, FW, FW).forEach((line, i) => {
		const lead = i === 0 ? [...usgPlate, ...blanks(1)].map((c, x) => drawIn(x, c, topFront)) : blanks(P + 1);
		body.push([...lead, ...runPad(drawInText(line.top, P + 1, topFront), FW, "field", false)]);
		if (line.bottom) body.push([...blanks(P + 1), ...runPad(drawInText(line.bottom, P + 1, textFront), FW, "field", false)]);
	});
	statuses.forEach((status, i) => {
		if (i === 0) plateRows.set("ext", header.length + body.length);
		if (!status.parts) { body.push(...fieldRows(i === 0 ? plate("ext", GREY_PLATE, bootWipe(4)) : undefined, status.text, FW)); return; }
		tatsuLines(status.parts, FW, FW, false).forEach((line, j) => {
			body.push([...(i === 0 && j === 0 ? plate("ext", GREY_PLATE, bootWipe(4)) : blanks(P)), ...blanks(1), ...runPad(line, FW, "field", false)]);
		});
	});

	const rows: Part[][] = [header[0]];
	const inner = [...header.slice(1), ...body], last = inner.length;
	inner.forEach((row, j) => {
		const i = j + 1, edge = i === 1 || i === last - 1;
		const frameCells = (text: string): Cell[] => [...text].map((ch) => (ch === " " ? { ch, bg: "field", ghost: true } : { ...cell(ch, "graphic"), ghost: true, frame: true }));
		const left = i === last ? (G === 2 ? "┗━" : "┗") : edge ? "┃".padEnd(G) : " ".repeat(G);
		const right = i === last ? (G === 2 ? "━┛" : "┛") : edge ? "┃".padStart(G) : " ".repeat(G);
		rows.push([...frameCells(left), ...row, ...frameCells(right)]);
	});

	/* ---------- ambient overlay: renderer-owned cells only, resolved against this layout ---------- */
	if (frame.ghosts || frame.strike) {
		const slots = rows.map((row) => {
			const at: number[] = [];
			let col = 0;
			row.forEach((part, index) => { if (isRun(part)) col += part.width; else at[col++] = index; });
			return at;
		});
		const base = rows.map((row) => row.slice());
		const cellAt = (r: number, c: number) => {
			const index = slots[r]?.[c];
			return index === undefined ? undefined : (base[r][index] as Cell);
		};
		const write = (r: number, c: number, next: Cell) => { rows[r][slots[r][c]] = next; };
		const ghostRow = (at: GhostAt) => (typeof at.row === "string" ? plateRows.get(at.row) : at.fromEnd ? last - at.row : at.row);
		const ghostCol = (at: GhostAt) => (at.colFrom === "right" ? W - 1 - at.col : at.colFrom === "mid" ? MID + at.col : at.colFrom === "plate" ? G + P + at.col : at.col);
		const numeralSettled = !frame.numeral;
		const lab0 = sideStart + 5 + (numeral?.w ?? 0);
		const zoneStart = { root: place.x + 2, badge: place.x + place.cells.length - badge.length };
		for (const event of [frame.ghosts, frame.strike]) {
			if (!event) continue;
			for (const item of event.items) {
				const fi = event.k - item.start, spec = item.frames[fi];
				if (fi < 0 || !spec) continue;
				if (item.fam === "ghost") {
					const r = ghostRow(item.at), c = ghostCol(item.at);
					if (r === undefined || r < 0 || r > last) continue;
					const cur = cellAt(r, c), s = spec as GhostSpec;
					if (!cur?.ghost || ("hide" in s ? !cur.frame : cur.ch !== " " && !cur.frame)) continue;
					if ("hide" in s) { write(r, c, { ch: " ", bg: cur.bg }); continue; }
					const fg = s.fg === "@edge" ? cellAt(r, G + P - 1)?.bg : s.fg === "@edgeL" ? cellAt(r, G)?.bg : s.fg;
					if (!fg || fg === "field") continue;
					// Motion plans use these single-column glyphs. A hand-built frame may
					// supply anything else; keep the host's width scan for that row.
					if (s.ch.length !== 1 || !"┏┓┗┛┃━┼▌▐".includes(s.ch)) (scanRows ??= new Set()).add(rows[r]);
					write(r, c, { ch: s.ch, fg, bg: cur.bg });
					continue;
				}
				const kind = spec as StrikeKind;
				let r: number | undefined, c: number;
				if (item.zone === "plate") { r = plateRows.get(item.key); c = G + item.x; }
				else if (item.zone === "root" || item.zone === "badge") { r = actRow; c = zoneStart[item.zone] + item.x; }
				else { if (!numeral || !numeralSettled) continue; r = blockStart + numeralRow0 + item.row; c = (item.zone === "digits" ? sideStart + 4 : lab0) + item.x; }
				if (r === undefined) continue;
				const cur = cellAt(r, c);
				if (!cur || cur.zone !== item.zone) continue;
				if (item.zone === "digits") { if ("█▀▄".includes(cur.ch) && cur.bg === "field") write(r, c, panelStrikeCell(cur, kind)); }
				else if (item.zone === "labels") { if (cur.ch !== " ") write(r, c, panelStrikeCell(cur, kind)); }
				else if (cur.bg !== "field") write(r, c, strikeCell(cur, kind, c));
			}
		}
	}
	return rows.map(serialize);
}
