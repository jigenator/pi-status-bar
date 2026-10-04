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
const { renderFooter, safeText } = await jiti.import(resolve("src/footer.ts"));
const { visibleWidth } = await import(pathToFileURL(require.resolve("@earendil-works/pi-tui")).href);
const plainTheme = { fg: (_color: string, text: string) => text };
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

test("wide snapshot includes only the active repository's main checkout and all statuses", () => {
	assert.deepEqual(renderFooter(fixture(), 100, plainTheme), [
		"Launch: /launch unrelated",
		"Active: /repo/worktree · feature/ui · modified",
		"Main: /repo · release · clean",
		"GitHub: owner/repo · PR #42 https://github.com/owner/repo/pull/42",
		"Context: 25.0%/128k" + " ".repeat(100 - 19 - 30) + "provider/model · thinking high",
		"Other status\x1b[0m", "Ponytail: ready\x1b[0m",
	]);
});

test("home abbreviation applies to all directory rows, not similar prefixes or stored values", () => {
	const f = fixture();
	f.launchPath = f.homePath;
	f.activePath = `${f.homePath}/worktrees/feature`;
	if (f.workspace?.git.kind !== "repository") throw new Error("fixture");
	f.workspace.path = f.activePath;
	f.workspace.git.active.path = f.activePath;
	f.workspace.git.main!.path = `${f.homePath}/Projects/repo`;
	f.pullRequest = { kind: "none" };
	const before = structuredClone(f);
	const lines = renderFooter(f, 160, plainTheme);
	assert.equal(lines[0], "Launch: ~");
	assert.equal(lines[1], "Active: ~/worktrees/feature · feature/ui · modified");
	assert.equal(lines[2], "Main: ~/Projects/repo · release · clean");
	assert.equal(lines[3], "GitHub: owner/repo");
	assert.deepEqual(f, before, "display shortening must not change stored paths or URLs");
	for (const path of ["/home/example-other/repo", "/home", "/elsewhere/repo"]) {
		f.launchPath = path;
		assert.equal(renderFooter(f, 160, plainTheme)[0], `Launch: ${path}`);
	}
	f.homePath = "/"; f.launchPath = "/project";
	assert.equal(renderFooter(f, 160, plainTheme)[0], "Launch: ~/project");
});

test("truthful none, unknown, unborn/detached, missing main and PR states", () => {
	let f = fixture();
	f.workspace = { path: f.activePath, git: { kind: "none" }, github: { kind: "none", reason: "not a repository" } };
	let output = renderFooter(f, 200, plainTheme).join("\n");
	assert.equal(output.split("\n")[1], `Active: ${f.activePath}`);
	assert.ok(output.split("\n")[2].startsWith("Context:"), "absent GitHub must not leave an empty row");
	assert.doesNotMatch(output, /Git|Main:|PR #/);
	f = fixture();
	f.workspace!.github = { kind: "none", reason: "No GitHub remote" };
	output = renderFooter(f, 200, plainTheme).join("\n");
	assert.match(output, /Active: \/repo\/worktree · feature\/ui · modified/);
	assert.match(output, /Main: \/repo · release · clean/);
	assert.doesNotMatch(output, /GitHub|PR #/);
	f.workspace = { path: f.activePath, git: { kind: "unknown", reason: "timeout" }, github: { kind: "unknown", reason: "ambiguous" } };
	output = renderFooter(f, 200, plainTheme).join("\n");
	assert.match(output, /Git unavailable \(timeout\)/); assert.match(output, /GitHub unavailable \(ambiguous\)/); assert.doesNotMatch(output, /clean|No open PR/);
	f = fixture();
	assert.equal(f.workspace?.git.kind, "repository");
	if (f.workspace?.git.kind !== "repository") throw new Error("fixture");
	f.workspace.git.active = { path: f.activePath, branch: null, revision: null, dirty: null, error: "timeout" };
	f.workspace.git.main = null; f.workspace.git.mainUnavailableReason = "pruned";
	for (const [pr, expected] of [
		[{ kind: "none" }, "GitHub: owner/repo"], [{ kind: "unavailable", reason: "auth missing" }, "GitHub: owner/repo · PR unavailable (auth missing)"], [{ kind: "not-applicable" }, "GitHub: owner/repo"],
	] as const) {
		f.pullRequest = pr;
		output = renderFooter(f, 200, plainTheme).join("\n");
		assert.ok(output.split("\n").includes(expected)); assert.doesNotMatch(output, /No open PR|PR not applicable/);
		assert.match(output, /detached · status unavailable \(timeout\)/); assert.match(output, /Main: unavailable \(pruned\)/);
	}
	f.workspace.git.active.branch = "main"; f.workspace.git.active.revision = null;
	f.workspace.git.main = f.workspace.git.active; delete f.workspace.git.mainUnavailableReason;
	assert.doesNotMatch(renderFooter(f, 200, plainTheme).join("\n"), /Main:/);
});

test("every line fits widths 1..160 with Unicode, long paths and colored statuses", () => {
	const f = fixture();
	f.activePath = "/项目/e\u0301/👩‍💻/" + "long".repeat(30);
	f.statuses = new Map([["color", "\x1b[38;2;255;10;20m彩色 status " + "verylong".repeat(10) + "\x1b[0m"]]);
	for (let width = 1; width <= 160; width++) {
		const lines = renderFooter(f, width, { fg: (_: string, text: string) => `\x1b[36m${text}\x1b[0m` });
		for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)}`);
	}
	assert.deepEqual(renderFooter(f, 0, plainTheme), []);
});

test("sanitizes terminal control payloads, preserving only statuses' SGR colors", () => {
	const hostile = "before\x1b[2J\x1b]8;;https://evil\x07link\x1b]8;;\x1b\\\x1bPpayload\x1b\\\x9b2J\x00\n\r\t\u202eafter";
	assert.equal(safeText(hostile), "beforelink    after");
	assert.equal(safeText("\x1b[31mred\x1b[0m"), "red");
	assert.equal(safeText("\x1b[31mred\x1b[0m", true), "\x1b[31mred\x1b[0m");
	assert.equal(safeText("safe\x1b]unfinished"), "safe");
	const f = fixture(); f.activePath = hostile;
	f.statuses = new Map([["colored", "\x1b[31mred\x1b[0m\x1b[2J\nnext\x07"]]);
	const lines = renderFooter(f, 200, plainTheme);
	assert.ok(lines.some((line: string) => line.includes("\x1b[31mred\x1b[0m next")));
	assert.doesNotMatch(lines.join(""), /\x1b\[2J|\x1b\]|\x07|\x00|\u202e/);
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
		f.statuses = new Map([["colored", `\x1b[${input}mABCDEFGHIJ\x1b[0m`]]);
		const lines = renderFooter(f, 5, plainTheme).slice(-2);
		assert.equal(lines.length, 2);
		for (const line of lines) assert.ok(line.includes(`\x1b[${expected}m`), `${input}: ${JSON.stringify(line)}`);
		assert.equal(safeText(lines.join("")), "ABCDEFGHIJ");
	}
	assert.equal(safeText("\x1b[1;38:2::255:0:0;48:5:21mred\x1b[0m", true), "\x1b[1;38;2;255;0;0;48;5;21mred\x1b[0m");
});

test("context unknown after compaction, current model/thinking, live statuses and theme", () => {
	const f = fixture(); f.contextUsage = { tokens: null, percent: null, contextWindow: 128_000 };
	assert.match(renderFooter(f, 80, plainTheme).join("\n"), /Context: \?\/128k/);
	const statuses = new Map([["first", "first"]]); f.statuses = statuses;
	assert.match(renderFooter(f, 80, plainTheme).join("\n"), /first/);
	statuses.set("later", "later"); f.thinking = "off"; f.model!.id = "new-model";
	const colors: string[] = [];
	const lines = renderFooter(f, 80, { fg: (color: string, text: string) => { colors.push(color); return text; } });
	assert.match(lines.join("\n"), /later/); assert.match(lines.join("\n"), /new-model · thinking off/);
	assert.ok(colors.includes("warning") && colors.includes("success") && colors.includes("dim"));
	assert.doesNotMatch(lines.join("\n"), /\$|cache|↑|↓/);
});
