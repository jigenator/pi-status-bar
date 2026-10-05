import { basename, dirname, isAbsolute, relative, sep } from "node:path";
import type { ContextUsage, Theme } from "@earendil-works/pi-coding-agent";
import type { Color } from "@earendil-works/pi-tui";
import { backgroundAnsi, foregroundAnsi, rgbColor, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { CheckoutInfo, PullRequestInfo, WorkspaceInfo } from "./workspace.ts";

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

// Selected "01 — Acid / Black" palette. Fixed by design rather than taken from the host theme.
const C = {
	field: rgbColor(0x00, 0x00, 0x00),
	primary: rgbColor(0xc0, 0xfe, 0x04),
	text: rgbColor(0xff, 0xff, 0xff),
	secondary: rgbColor(0xcf, 0xcf, 0xcf),
	plate: rgbColor(0x55, 0x55, 0x55),
	surface: rgbColor(0x1c, 0x1c, 0x1c),
	warning: rgbColor(0xd7, 0x9e, 0x52),
	high: rgbColor(0xf2, 0x47, 0x23),
	graphic: rgbColor(0x71, 0x71, 0x71),
	warnZone: rgbColor(0x2b, 0x20, 0x10), // 20% warning over the field
	highZone: rgbColor(0x30, 0x0e, 0x07), // 20% high over the field
};
const RESET = "\x1b[0m";

export type Tone = "ok" | "warn" | "high" | "unknown";
type Paint = { fg?: Color; bg?: Color; bold?: boolean };
// One terminal column of a renderer-owned glyph; untrusted text is never split into cells.
type Cell = Paint & { ch: string };

const TONE_COLOR: Record<Tone, Color> = { ok: C.primary, warn: C.warning, high: C.high, unknown: C.graphic };
const TONE_PLATE: Record<Tone, Paint> = {
	ok: { fg: C.field, bg: C.primary, bold: true }, warn: { fg: C.field, bg: C.warning, bold: true },
	high: { fg: C.field, bg: C.high, bold: true }, unknown: { fg: C.text, bg: C.plate, bold: true },
};
const TONE_READOUT: Record<Tone, Paint> = { ...TONE_PLATE, ok: { fg: C.field, bg: C.text, bold: true } };
const TONE_TAG: Record<Tone, string> = { ok: "", warn: "▲ WARN", high: "▲ HIGH", unknown: "? UNKNOWN" };

const finitePercent = (percent: unknown) => typeof percent === "number" && Number.isFinite(percent) ? percent : undefined;
const toneOf = (percent: number | undefined): Tone => percent === undefined ? "unknown" : percent > 90 ? "high" : percent > 70 ? "warn" : "ok";

/* ---------- decorative motion: pure functions of supplied time ---------- */

export const MOTION_TICK_MS = 50;
const BOOT_TICKS = 30, COMB_TICKS = 8, CAL_PERIOD = 120, WIPE_TICKS = 15, TAG_TICKS = 8, FLASH_TICKS = 6;
const CAL = [1, 1, 0, -1, -1, 0]; // calibration nudge of the header's ┼ mark once per period

/** Decoration memory only. Context values shown are always read from the current snapshot. */
export type MotionState = { epoch: number; tone?: Tone; percent?: number; toneFrom?: Tone; toneAt?: number; crossedAt: { 70?: number; 90?: number } };
export type FooterFrame = { boot: number; comb: number; cal: number; wipe?: { from: Tone; cells: number }; tagFlash: boolean; flash70: boolean; flash90: boolean };
export const SETTLED_FRAME: FooterFrame = Object.freeze({ boot: Infinity, comb: 0, cal: 0, tagFlash: false, flash70: false, flash90: false });

export function startMotion(now: number): MotionState {
	return { epoch: now, crossedAt: {} };
}

/** Records tone changes and 70/90 crossings for plate wipes and boundary flashes. */
export function observeContext(state: MotionState, percent: number | null | undefined, now: number): MotionState {
	const value = finitePercent(percent), tone = toneOf(value);
	if (state.tone === undefined) return { ...state, tone, percent: value };
	if (tone === state.tone && value === state.percent) return state;
	const next: MotionState = { ...state, tone, percent: value, crossedAt: { ...state.crossedAt } };
	if (tone !== state.tone) { next.toneFrom = state.tone; next.toneAt = now; }
	if (value !== undefined && state.percent !== undefined) {
		for (const mark of [70, 90] as const) if ((state.percent > mark) !== (value > mark)) next.crossedAt[mark] = now;
	}
	return next;
}

const ticksSince = (at: number, now: number) => Math.floor((now - at) / MOTION_TICK_MS);
const calAt = (tick: number) => CAL[tick % CAL_PERIOD] ?? 0;

export function motionFrame(state: MotionState, now: number): FooterFrame {
	const tick = Math.max(0, ticksSince(state.epoch, now));
	const frame: FooterFrame = { boot: tick <= BOOT_TICKS ? tick : Infinity, comb: Math.floor(tick / COMB_TICKS) % 8, cal: calAt(tick), tagFlash: false, flash70: false, flash90: false };
	if (state.toneAt !== undefined && state.toneFrom !== undefined) {
		const k = ticksSince(state.toneAt, now);
		if (k >= 0 && k < WIPE_TICKS) frame.wipe = { from: state.toneFrom, cells: k };
		if (k >= 0 && k < TAG_TICKS) frame.tagFlash = (TAG_TICKS - k) % 4 >= 2;
	}
	for (const mark of [70, 90] as const) {
		const at = state.crossedAt[mark];
		const k = at === undefined ? -1 : ticksSince(at, now);
		if (k >= 0 && k < FLASH_TICKS) frame[mark === 70 ? "flash70" : "flash90"] = (FLASH_TICKS - k) % 2 === 1;
	}
	return frame;
}

/** Milliseconds until the decoration can next change: one tick during transients, else the next ambient step. */
export function nextMotionDelay(state: MotionState, now: number): number {
	const tick = Math.max(0, ticksSince(state.epoch, now));
	const nextTick = (at: number, k: number) => at + (k + 1) * MOTION_TICK_MS;
	let due = Infinity;
	for (let k = tick + 1; k <= tick + COMB_TICKS; k++) {
		if (k % COMB_TICKS === 0 || calAt(k) !== calAt(k - 1)) { due = state.epoch + k * MOTION_TICK_MS; break; }
	}
	if (tick <= BOOT_TICKS) due = Math.min(due, nextTick(state.epoch, tick));
	const transient = (at: number | undefined, length: number) => {
		if (at === undefined) return;
		const k = ticksSince(at, now);
		if (k < length) due = Math.min(due, k < 0 ? at : nextTick(at, k));
	};
	transient(state.toneFrom === undefined ? undefined : state.toneAt, WIPE_TICKS);
	transient(state.crossedAt[70], FLASH_TICKS);
	transient(state.crossedAt[90], FLASH_TICKS);
	return Math.max(1, due - now);
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

function compact(count: number): string {
	return count >= 1_000_000 ? `${(count / 1_000_000).toFixed(1)}M` : count >= 1_000 ? `${(count / 1_000).toFixed(0)}k` : `${count}`;
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

// 3×5 pixel digits packed into three half-block rows.
const FONT: Record<string, string[]> = {
	0: ["111", "101", "101", "101", "111"], 1: ["010", "110", "010", "010", "111"], 2: ["111", "001", "111", "100", "111"],
	3: ["111", "001", "111", "001", "111"], 4: ["101", "101", "111", "001", "001"], 5: ["111", "100", "111", "001", "111"],
	6: ["111", "100", "111", "101", "111"], 7: ["111", "001", "001", "001", "001"], 8: ["111", "101", "111", "101", "111"],
	9: ["111", "101", "111", "001", "111"], ".": ["0", "0", "0", "0", "1"], "-": ["000", "000", "111", "000", "000"],
	"?": ["111", "001", "011", "000", "010"],
};
function bigNumeral(text: string): string[] {
	const rows = ["", "", ""];
	[...text].forEach((ch, k) => {
		const px = FONT[ch];
		for (let r = 0; r < 3; r++) {
			if (k) rows[r] += " ";
			for (let x = 0; x < px[0].length; x++) {
				const top = px[2 * r][x] === "1", bottom = px[2 * r + 1]?.[x] === "1";
				rows[r] += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
			}
		}
	});
	return rows;
}

// Gauge cells cover 0..100; a cell lights when any of its slice is used, so only true zero is empty.
const fillCount = (percent: number, n: number) => Math.min(n, Math.max(0, Math.ceil((percent * n) / 100 - 1e-9)));
const tickAt = (value: number, n: number) => Math.min(n - 1, Math.max(0, Math.floor((value * n) / 100 + 1e-9)));

/** Pure display: the caller supplies snapshots, live host values and the decoration frame. */
export function renderFooter(snapshot: FooterSnapshot, width: number, theme: FooterTheme, frame: FooterFrame = SETTLED_FRAME): string[] {
	if (!Number.isFinite(width) || width < 1) return [];
	const W = Math.floor(width);
	const paint = (text: string, s: Paint = {}) => text ? theme.style(text, { fg: s.fg ?? C.text, bg: s.bg ?? C.field, bold: s.bold }) : "";
	const fill = (n: number, bg = C.field) => n > 0 ? paint(" ".repeat(n), { bg }) : "";
	const fit = (line: string, w: number, bg = C.field) => {
		const kept = truncateToWidth(line, w, "");
		return kept + RESET + fill(w - visibleWidth(kept), bg);
	};
	// A chip's trailing pad can wrap alone; blank wrapped rows carry no information.
	const wrap = (text: string, w: number) => {
		const lines = wrapTextWithAnsi(text, w).filter((line) => stripTerminalSequences(line).trim());
		return lines.length ? lines : [""];
	};
	const glyphs = (cells: Cell[]) => {
		let out = "", run = "", style: Paint | undefined;
		for (const cell of cells) {
			if (style && style.fg === cell.fg && style.bg === cell.bg && !!style.bold === !!cell.bold) run += cell.ch;
			else { if (style) out += paint(run, style); run = cell.ch; style = cell; }
		}
		return style ? out + paint(run, style) : out;
	};
	const chip = (text: string, s: Paint) => paint(` ${text} `, s);
	const gap = (bg = C.field) => paint(" ", { bg });

	/* ---------- field values ---------- */
	const checkout = (info: CheckoutInfo) => {
		const branch = info.branch ?? `detached${info.revision ? ` @${info.revision}` : ""}`;
		const status = info.dirty === null ? chip("status unavailable", TONE_PLATE.unknown) : info.dirty ? chip("modified", TONE_PLATE.warn) : chip("clean", TONE_PLATE.ok);
		return gap() + chip(safeText(branch), { fg: C.field, bg: C.text, bold: true }) + gap() + status + (info.error ? paint(` (${safeText(info.error)})`, { fg: C.warning }) : "");
	};
	const git = snapshot.workspace?.git;
	let active = paint(displayPath(snapshot.activePath, snapshot.homePath), { bold: true });
	if (git?.kind === "repository") active += checkout(git.active);
	else if (git?.kind === "unknown") active += gap() + paint(`Git unavailable (${safeText(git.reason)})`, { fg: C.warning });
	else if (!git) active += gap() + paint("Git pending", { fg: C.secondary });
	let main: string | undefined;
	if (git?.kind === "repository") {
		if (git.main && git.main.path !== git.active.path) main = paint(displayPath(git.main.path, snapshot.homePath)) + checkout(git.main);
		else if (git.mainUnavailableReason) main = paint(`unavailable (${safeText(git.mainUnavailableReason)})`, { fg: C.warning });
	}
	const github = snapshot.workspace?.github;
	let repository: string | undefined;
	if (github?.kind === "repository") {
		const pr = snapshot.pullRequest;
		repository = paint(safeText(github.name), { bold: true });
		if (pr.kind === "open") repository += paint(" · ", { fg: C.secondary }) + paint(`PR #${pr.number}`, { bold: true }) + gap() + paint(safeText(pr.url), { fg: C.secondary });
		else if (pr.kind === "unavailable") repository += paint(" · ", { fg: C.secondary }) + paint(`PR unavailable (${safeText(pr.reason)})`, { fg: C.warning });
	} else if (github?.kind === "unknown") repository = paint(`unavailable (${safeText(github.reason)})`, { fg: C.warning });
	else if (!github) repository = paint("pending", { fg: C.secondary });
	const band = C.surface;
	const model = paint(snapshot.model ? `${safeText(snapshot.model.provider)}/${safeText(snapshot.model.id)}` : "no-model", { bold: true, bg: band })
		+ paint(" · ", { fg: C.secondary, bg: band }) + paint("thinking ", { fg: C.secondary, bg: band }) + paint(safeText(snapshot.thinking), { fg: C.primary, bold: true, bg: band });
	const mode = theme.getColorMode(), baseFg = foregroundAnsi(C.text, mode), baseBg = backgroundAnsi(C.field, mode);
	// Keep every status and its own colors; sorting keeps row order stable.
	const statuses = [...snapshot.statuses].sort(([a], [b]) => a.localeCompare(b)).map(([, status]) => baseFg + baseBg + restoreBase(safeText(status, true), baseFg, baseBg));

	const usage = snapshot.contextUsage;
	const percent = finitePercent(usage?.percent);
	const tone = toneOf(percent);
	const windowSize = [usage?.contextWindow, snapshot.model?.contextWindow].find((value) => typeof value === "number" && Number.isFinite(value) && value > 0);
	const windowText = windowSize ? compact(windowSize) : "";
	const readoutText = (value: string) => `${value}${windowText ? `/${windowText}` : ""}`;
	const readout = chip(readoutText(percent === undefined ? "?" : `${percent.toFixed(1)}%`), TONE_READOUT[tone]);
	const tagText = TONE_TAG[tone];
	const tag = !tagText ? "" : frame.tagFlash
		? chip(tagText, { fg: C.field, bg: tone === "unknown" ? C.text : TONE_COLOR[tone], bold: true })
		: chip(tagText, { fg: tone === "unknown" ? C.secondary : TONE_COLOR[tone], bold: true });
	const ctxValue = readout + (tag ? gap() + tag : "");

	/* ---------- minimal fallback where the frame and plates cannot fit ---------- */
	if (W < 40) {
		const lines: string[] = [];
		const add = (label: string, style: Paint, value: string) => {
			for (const line of wrap(chip(label, style) + gap() + value, W)) lines.push(fit(line, W));
		};
		if (repository) add("GITHUB", { fg: C.secondary }, repository);
		add("LAUNCH", { fg: C.text, bg: C.plate, bold: true }, paint(displayPath(snapshot.launchPath, snapshot.homePath), { fg: C.secondary }));
		add("ACTIVE", TONE_PLATE.ok, active);
		if (main) add("MAIN", { fg: C.text, bg: C.plate, bold: true }, main);
		add("CTX", TONE_PLATE[tone], ctxValue);
		add("MODEL", { fg: C.field, bg: C.text, bold: true }, model);
		statuses.forEach((status, k) => {
			if (k === 0) add("EXT", { fg: C.text, bg: C.plate, bold: true }, status);
			else for (const line of wrap(status, W)) lines.push(fit(line, W));
		});
		return lines.map((line) => truncateToWidth(line, W, ""));
	}

	/* ---------- framed plate layout ---------- */
	const wide = W >= 100, narrow = W < 60;
	const G = narrow ? 1 : 2, P = narrow ? 8 : 12, M = W - 2 * G;
	const label = (index: string, text: string) => narrow ? text : `${index} ${text}`;
	const bootWipe = (order: number) => Math.max(0, Math.min(P, (frame.boot - order * 2) * 3));
	const outline = (s: Paint): Paint => ({ fg: s.bg === C.plate ? C.secondary : s.bg, bold: true });
	const plate = (text: string, style: Paint, wipe: number, previous?: Paint) =>
		glyphs([...(" " + text).padEnd(P).slice(0, P)].map((ch, i) => ({ ch, ...(i < wipe ? style : previous ?? outline(style)) })));
	// Continuation rows leave the plate column as plain field: no tabs below plates.
	const field = (plateText: string, value: string, w: number, bg = C.field) =>
		wrap(value, w).map((line, i) => (i === 0 ? plateText : fill(P)) + gap(bg) + fit(line, w, bg));

	// Gauge and wide-only numeral share one reserved width so states do not shift the layout.
	const ends = !wide;
	const endsWidth = ends ? 6 : 0;
	const fixed = endsWidth + 1 + Math.max(visibleWidth(readout), visibleWidth(chip(readoutText("100.0%"), {}))) + 1 + visibleWidth(chip(TONE_TAG.unknown, {}));
	let numeral: string[] | undefined, side = 0;
	const digits = percent === undefined ? "?" : percent.toFixed(1);
	// Exponent forms such as 1e+21 have no glyphs; the readout still shows them.
	if (wide && [...digits].every((ch) => FONT[ch])) {
		const big = bigNumeral(digits);
		const labels = percent === undefined ? ["", "UNKNOWN", windowText ? `of ${windowText}` : ""] : ["%", "USED", windowText ? `of ${windowText}` : ""];
		const bigWidth = Math.max(13, big[0].length), labelWidth = Math.max(7, ...labels.map((text) => text.length));
		side = bigWidth + labelWidth + 6;
		if (M - P - 1 - side - fixed >= 12) {
			const numberColor = percent === undefined ? C.graphic : tone === "ok" ? C.text : TONE_COLOR[tone];
			numeral = big.map((row, k) => fill(2) + paint("▐", { fg: frame.tagFlash ? C.text : TONE_COLOR[tone] }) + fill(1)
				+ paint(row.padEnd(bigWidth), { fg: numberColor, bold: true }) + fill(1)
				+ paint(labels[k].padEnd(labelWidth), k === 0 ? { fg: tone === "unknown" ? C.secondary : TONE_COLOR[tone], bold: true } : { fg: C.secondary }) + fill(1));
		} else side = 0;
	}
	const fieldWidth = M - P - 1, blockWidth = fieldWidth - side;
	let n = Math.min(60, blockWidth - fixed), readoutBelow = false;
	if (n < 12) { readoutBelow = true; n = Math.min(40, blockWidth - endsWidth); }
	n = Math.max(1, n);

	const header: string[] = [];
	{
		const titleWidth = M - 8 - 2;
		const values = repository ? wrap(repository, titleWidth) : [];
		const title = repository ? paint(" GITHUB ", { fg: C.secondary }) + values[0] + RESET + gap() : "";
		const from = G + visibleWidth(title), drawn = frame.boot * 8, mid = Math.floor(W / 2) + frame.cal;
		const rule = (x: number): Cell => {
			if (x >= drawn) return { ch: " " };
			if (x < G) return { ch: G === 2 ? "┏━"[x] : "┏", fg: C.graphic };
			if (x >= W - G) return { ch: G === 2 ? "━┓"[x - W + G] : "┓", fg: C.graphic };
			if (Math.abs(x - mid) <= 1) return { ch: x === mid ? "┼" : "─", ...(frame.cal ? { fg: C.primary, bold: true } : { fg: C.graphic }) };
			return { ch: x >= 3 && x < W - 3 && (x + frame.comb) % 8 === 0 ? "┬" : "─", fg: C.plate };
		};
		const cells = (start: number, end: number) => glyphs(Array.from({ length: Math.max(0, end - start) }, (_, i) => rule(start + i)));
		header.push(cells(0, G) + title + cells(from, W));
		for (const value of values.slice(1)) header.push(fill(8) + fit(value, M - 8));
	}

	const body: string[] = [];
	body.push(...field(plate(label("01", "LAUNCH"), { fg: C.text, bg: C.plate, bold: true }, bootWipe(0)), paint(displayPath(snapshot.launchPath, snapshot.homePath), { fg: C.secondary }), fieldWidth));
	const block: string[] = [];
	block.push(...field(plate(label("02", "ACTIVE"), TONE_PLATE.ok, bootWipe(1)), active, blockWidth));
	if (main) block.push(...field(plate(label("02.1", "MAIN"), { fg: C.text, bg: C.plate, bold: true }, bootWipe(1.5)), main, blockWidth));
	{
		const m70 = tickAt(70, n), m90 = tickAt(90, n), lit = percent === undefined ? 0 : fillCount(percent, n);
		const gauge: Cell[] = [];
		for (let i = 0; i < n; i++) {
			const zone: Tone = i >= m90 ? "high" : i >= m70 ? "warn" : "ok";
			const track = zone === "high" ? C.highZone : zone === "warn" ? C.warnZone : C.surface;
			const mark = i === m70 || i === m90, flash = (i === m70 && frame.flash70) || (i === m90 && frame.flash90);
			if (percent === undefined) gauge.push({ ch: "╱", fg: C.graphic, bg: C.surface });
			else if (i < lit) gauge.push({ ch: "█", fg: flash ? C.text : TONE_COLOR[zone], bg: flash ? C.text : TONE_COLOR[zone] });
			else if (flash) gauge.push({ ch: "┃", fg: C.field, bg: C.text, bold: true });
			else if (mark) gauge.push({ ch: "┃", fg: i === m90 ? C.high : C.warning, bg: track, bold: true });
			else gauge.push({ ch: " ", bg: track });
		}
		const bars = (left: boolean): Cell[] => !ends ? [] : left
			? [{ ch: "0", fg: C.secondary }, { ch: "▕", fg: C.graphic }]
			: [{ ch: "▏", fg: C.graphic }, ...[..."100"].map((ch) => ({ ch, fg: C.secondary }))];
		const meter = glyphs([...bars(true), ...gauge, ...bars(false)]);
		const ctxPlate = plate(narrow ? "CTX" : "03 CTX USED", TONE_PLATE[tone], Math.min(frame.wipe?.cells ?? P, bootWipe(2)), frame.wipe ? TONE_PLATE[frame.wipe.from] : undefined);
		block.push(ctxPlate + gap() + fit(readoutBelow ? meter : meter + gap() + ctxValue, blockWidth));
		if (readoutBelow) for (const line of wrap(ctxValue, blockWidth)) block.push(fill(P) + gap() + fit(line, blockWidth));
		if (wide) {
			// Calibration scale under the gauge; 0/100/70/90/50 win label collisions.
			const scale: Cell[] = Array.from({ length: n + 3 }, () => ({ ch: " " }));
			for (const value of [10, 20, 30, 40, 50, 60, 70, 80, 90]) scale[tickAt(value, n)] = { ch: "╵", fg: C.graphic };
			const used = new Array<boolean>(n + 3).fill(false);
			for (const value of n >= 50 ? [0, 100, 70, 90, 50, 10, 20, 30, 40, 60, 80] : [0, 100, 70, 90, 50]) {
				const text = String(value), start = tickAt(value, n), end = start + text.length;
				if (end > n + 3 || used.slice(Math.max(0, start - 1), end + 1).some(Boolean)) continue;
				[...text].forEach((ch, j) => {
					used[start + j] = true;
					scale[start + j] = { ch, fg: value === 70 ? C.warning : value === 90 ? C.high : C.secondary, bold: value === 70 || value === 90 };
				});
			}
			block.push(fill(P) + gap() + fit(glyphs(scale), blockWidth));
		}
	}
	// The numeral sits beside the last three block rows, ending at the gauge scale.
	block.forEach((row, i) => body.push(row + (numeral ? numeral[i - (block.length - 3)] ?? fill(side) : "")));
	body.push(...field(plate(label("04", "MODEL"), { fg: C.field, bg: C.text, bold: true }, bootWipe(4)), model, fieldWidth, band));
	statuses.forEach((status, k) => {
		const lines = field(k === 0 ? plate(label("05", "EXT"), { fg: C.text, bg: C.plate, bold: true }, bootWipe(5)) : fill(P), status, fieldWidth);
		body.push(...lines);
	});

	const rows = [...header, ...body], last = rows.length - 1;
	const frameCell = (ch: string) => glyphs([...ch].map((c) => c === " " ? { ch: c } : { ch: c, fg: C.graphic }));
	return rows.map((row, i) => {
		if (i === 0) return truncateToWidth(row, W, "");
		const edge = i === 1 || i === last - 1;
		const left = i === last ? (G === 2 ? "┗━" : "┗") : edge ? "┃".padEnd(G) : " ".repeat(G);
		const right = i === last ? (G === 2 ? "━┛" : "┛") : edge ? "┃".padStart(G) : " ".repeat(G);
		return truncateToWidth(frameCell(left) + row + frameCell(right), W, "");
	});
}
