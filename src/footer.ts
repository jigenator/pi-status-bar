import type { ContextUsage, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { CheckoutInfo, PullRequestInfo, WorkspaceInfo } from "./workspace.ts";

export type FooterSnapshot = {
	launchPath: string;
	activePath: string;
	workspace?: WorkspaceInfo;
	pullRequest: PullRequestInfo;
	contextUsage?: ContextUsage;
	model?: { id: string; provider: string; contextWindow: number };
	thinking: string;
	statuses: ReadonlyMap<string, string>;
};

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

function checkout(info: CheckoutInfo, theme: Theme): string {
	const branch = info.branch ?? `detached${info.revision ? ` @${info.revision}` : ""}`;
	const status = info.dirty === null ? "status unavailable" : info.dirty ? "modified" : "clean";
	const color = info.dirty === null ? "warning" : info.dirty ? "warning" : "success";
	return `${safeText(branch)} · ${theme.fg(color, status)}${info.error ? ` (${safeText(info.error)})` : ""}`;
}

function compact(count: number): string {
	return count >= 1_000_000 ? `${(count / 1_000_000).toFixed(1)}M` : count >= 1_000 ? `${(count / 1_000).toFixed(0)}k` : `${count}`;
}

/** Pure display: the caller supplies snapshots and reads live statuses each frame. */
export function renderFooter(snapshot: FooterSnapshot, width: number, theme: Theme): string[] {
	if (!Number.isFinite(width) || width < 1) return [];
	width = Math.floor(width);
	const lines: string[] = [];
	const add = (text: string) => {
		// Guard even against a single wide grapheme at width 1.
		for (const line of wrapTextWithAnsi(text, width)) lines.push(truncateToWidth(line, width, ""));
	};
	const label = (name: string) => theme.fg("dim", `${name}: `);
	add(label("Launch") + safeText(snapshot.launchPath));
	let active = label("Active") + safeText(snapshot.activePath);
	const git = snapshot.workspace?.git;
	if (git?.kind === "repository") active += ` · ${checkout(git.active, theme)}`;
	else active += theme.fg("dim", git?.kind === "none" ? " · Not a Git repository" : git?.kind === "unknown" ? ` · Git unavailable (${safeText(git.reason)})` : " · Git pending");
	add(active);
	if (git?.kind === "repository") {
		if (git.main && git.main.path !== git.active.path) add(label("Main") + safeText(git.main.path) + ` · ${checkout(git.main, theme)}`);
		else if (git.mainUnavailableReason) add(label("Main") + theme.fg("warning", `unavailable (${safeText(git.mainUnavailableReason)})`));
	}
	const github = snapshot.workspace?.github;
	if (github?.kind === "repository") {
		const pr = snapshot.pullRequest;
		const prText = pr.kind === "open" ? `PR #${pr.number} ${safeText(pr.url)}` : pr.kind === "none" ? "No open PR" : pr.kind === "unavailable" ? `PR unavailable (${safeText(pr.reason)})` : "PR not applicable";
		add(label("GitHub") + `${safeText(github.name)} ${safeText(github.url)} · ${prText}`);
	} else if (github?.kind === "none") add(theme.fg("dim", "No GitHub remote"));
	else add(theme.fg("warning", github?.kind === "unknown" ? `GitHub unavailable (${safeText(github.reason)})` : "GitHub pending"));
	const usage = snapshot.contextUsage;
	const window = usage?.contextWindow ?? snapshot.model?.contextWindow;
	const percent = usage?.percent;
	const context = `Context: ${percent == null ? "?" : `${percent.toFixed(1)}%`}${window ? `/${compact(window)}` : ""}`;
	const left = theme.fg(percent != null && percent > 90 ? "error" : percent != null && percent > 70 ? "warning" : "dim", context);
	const right = theme.fg("dim", `${snapshot.model ? `${safeText(snapshot.model.provider)}/${safeText(snapshot.model.id)}` : "no-model"} · thinking ${safeText(snapshot.thinking)}`);
	if (visibleWidth(left) + 2 + visibleWidth(right) <= width) add(left + " ".repeat(width - visibleWidth(left) - visibleWidth(right)) + right);
	else { add(left); add(right); }
	// Keep every status, including colors, rather than truncating the joined tail.
	for (const [, status] of [...snapshot.statuses].sort(([a], [b]) => a.localeCompare(b))) {
		add(safeText(status, true) + "\x1b[0m");
	}
	return lines;
}
