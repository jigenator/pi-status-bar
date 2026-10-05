import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { motionFrame, nextMotionDelay, observeContext, renderFooter, safeText, startMotion } from "./footer.ts";
import type { FooterFrame, MotionState } from "./footer.ts";
import { inspectPullRequest, inspectWorkspace, resolveActivePath } from "./workspace.ts";
import type { PullRequestInfo, WorkspaceInfo } from "./workspace.ts";

const LOCAL_REFRESH_MS = 15_000;
const PR_TTL_MS = 60_000;
type Selection = { version: 1; path: string };
// Decoration only: owned by one installed TUI footer and never triggers inspection.
type Animation = { state: MotionState; timer?: ReturnType<typeof setTimeout>; due?: number; shown?: string; schedule(now: number): void };
type SessionState = {
	ctx: ExtensionContext;
	id: string;
	launch: string;
	active: string;
	selection: number;
	workspace?: WorkspaceInfo;
	pr: PullRequestInfo;
	prKey?: string;
	prCache: Map<string, { at: number; value: PullRequestInfo }>;
	localAbort?: AbortController;
	prAbort?: AbortController;
	refreshPending: boolean;
	timer?: ReturnType<typeof setInterval>;
	requestRender?: () => void;
	motion: boolean;
	animation?: Animation;
};

export default function (pi: ExtensionAPI) {
	const homePath = homedir();
	let session: SessionState | undefined;
	const current = (s: SessionState) => session === s;
	const stopWork = (s: SessionState) => {
		if (s.timer) clearInterval(s.timer);
		s.timer = undefined;
		s.localAbort?.abort();
		s.prAbort?.abort();
		s.localAbort = s.prAbort = undefined;
		s.refreshPending = false;
		s.requestRender = undefined;
		stopAnimation(s);
		s.animation = undefined;
	};
	const stopAnimation = (s: SessionState) => {
		if (s.animation?.timer) clearTimeout(s.animation.timer);
		if (s.animation) s.animation.timer = s.animation.due = undefined;
	};

	async function refreshPR(s: SessionState, workspace: WorkspaceInfo) {
		if (!current(s)) return;
		if (workspace.github.kind !== "repository" || workspace.git.kind !== "repository") {
			s.prAbort?.abort(); s.prAbort = undefined; s.prKey = undefined;
			s.pr = workspace.git.kind === "unknown"
				? { kind: "unavailable", reason: workspace.git.reason }
				: { kind: "not-applicable" };
			return;
		}
		const repository = workspace.github;
		const branch = workspace.git.active.branch;
		const key = JSON.stringify([repository.name, repository.url, branch]);
		if (s.prKey !== key) {
			s.prAbort?.abort(); s.prAbort = undefined;
			s.prKey = key;
			s.pr = { kind: "unavailable", reason: "lookup pending" };
		}
		const cached = s.prCache.get(key);
		if (cached && Date.now() - cached.at < PR_TTL_MS) { s.pr = cached.value; return; }
		if (s.prAbort) return;
		const controller = new AbortController();
		s.prAbort = controller;
		try {
			let value: PullRequestInfo;
			try { value = await inspectPullRequest(repository, branch, { signal: controller.signal }); }
			catch (error) { value = { kind: "unavailable", reason: error instanceof Error ? error.message : "lookup failed" }; }
			if (!current(s) || controller.signal.aborted || s.prAbort !== controller || s.prKey !== key) return;
			s.prCache.set(key, { at: Date.now(), value });
			s.pr = value;
			s.requestRender?.();
		} finally {
			if (s.prAbort === controller) s.prAbort = undefined;
		}
	}

	async function refreshLocal(s: SessionState): Promise<void> {
		if (!current(s)) return;
		if (s.localAbort) { s.refreshPending = true; return; }
		const controller = new AbortController();
		s.localAbort = controller;
		const path = s.active;
		try {
			let workspace: WorkspaceInfo;
			try { workspace = await inspectWorkspace(path, { signal: controller.signal }); }
			catch (error) {
				const reason = error instanceof Error ? error.message : "inspection failed";
				workspace = { path, git: { kind: "unknown", reason }, github: { kind: "unknown", reason } };
			}
			if (!current(s) || controller.signal.aborted || s.localAbort !== controller || s.active !== path) return;
			s.workspace = workspace;
			void refreshPR(s, workspace);
			s.requestRender?.();
		} finally {
			if (s.localAbort === controller) {
				s.localAbort = undefined;
				if (s.refreshPending && current(s)) { s.refreshPending = false; void refreshLocal(s); }
			}
		}
	}

	function restore(ctx: ExtensionContext) {
		const id = ctx.sessionManager.getSessionId();
		const prCache = session?.id === id ? session.prCache : new Map<string, { at: number; value: PullRequestInfo }>();
		const motion = session?.id === id ? session.motion : true;
		if (session) stopWork(session);
		const launch = ctx.sessionManager.getHeader()?.cwd ?? ctx.sessionManager.getCwd();
		let active = launch;
		// Tool details follow the selected branch; scanning all entries leaks
		// abandoned choices into tree navigation and forks.
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "set_active_project" || entry.message.isError) continue;
			const data = entry.message.details as Partial<Selection> | undefined;
			if (data?.version === 1 && typeof data.path === "string" && isAbsolute(data.path)) active = data.path;
		}
		const s: SessionState = { ctx, id, launch, active, selection: 0, pr: { kind: "unavailable", reason: "lookup pending" }, prCache, refreshPending: false, motion };
		session = s;
		if (ctx.mode === "tui") {
			ctx.ui.setFooter((tui, theme, footerData) => {
				const render = () => tui.requestRender();
				s.requestRender = render;
				const frameKey = (frame: FooterFrame | undefined) => JSON.stringify(frame ?? null);
				const animation: Animation = {
					state: startMotion(Date.now()),
					// One unref'd timeout at a time, due at the next visible decoration step.
					schedule(now) {
						if (!s.motion || !current(s) || s.animation !== animation) return;
						const due = now + nextMotionDelay(animation.state, now);
						if (animation.timer && animation.due! <= due) return;
						if (animation.timer) clearTimeout(animation.timer);
						animation.due = due;
						animation.timer = setTimeout(() => {
							animation.timer = animation.due = undefined;
							if (!s.motion || !current(s) || s.animation !== animation) return;
							const time = Date.now();
							if (frameKey(motionFrame(animation.state, time)) !== animation.shown) render();
							animation.schedule(time);
						}, due - now);
						animation.timer.unref();
					},
				};
				s.animation = animation;
				animation.schedule(Date.now());
				return {
					invalidate() {},
					render(width) {
						if (!current(s)) return [];
						const now = Date.now(), contextUsage = s.ctx.getContextUsage();
						// Values are always current; only plate wipes and boundary flashes remember changes.
						const previous = animation.state;
						animation.state = observeContext(previous, contextUsage?.percent, now);
						const frame = s.motion ? motionFrame(animation.state, now) : undefined;
						animation.shown = frameKey(frame);
						if (animation.state !== previous) animation.schedule(now);
						return renderFooter({ homePath, launchPath: s.launch, activePath: s.active, workspace: s.workspace, pullRequest: s.pr, contextUsage, model: s.ctx.model, thinking: pi.getThinkingLevel(), statuses: footerData.getExtensionStatuses() }, width, theme, frame);
					},
					dispose() { if (s.requestRender === render) stopWork(s); },
				};
			});
			s.timer = setInterval(() => { void refreshLocal(s); }, LOCAL_REFRESH_MS);
			s.timer.unref();
		}
		void refreshLocal(s);
	}

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		if (session) stopWork(session);
		session = undefined;
		if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
	});
	pi.on("tool_execution_end", () => { if (session) void refreshLocal(session); });

	pi.registerCommand("footer-motion", {
		description: "Footer decoration motion for this session: on, off, or toggle when empty. Live values keep updating.",
		getArgumentCompletions: (prefix) => ["on", "off"].filter((value) => value.startsWith(prefix.trim())).map((value) => ({ value, label: value })),
		async handler(args, ctx) {
			const s = session, choice = args.trim().toLowerCase();
			if (choice && choice !== "on" && choice !== "off") {
				if (ctx.hasUI) ctx.ui.notify("Usage: /footer-motion [on|off]", "warning");
				return;
			}
			if (!s) return;
			s.motion = choice ? choice === "on" : !s.motion;
			if (s.motion) s.animation?.schedule(Date.now());
			else stopAnimation(s);
			s.requestRender?.();
			if (ctx.hasUI) ctx.ui.notify(`Footer motion ${s.motion ? "on" : "off"} for this session`, "info");
		},
	});

	pi.registerTool({
		name: "set_active_project",
		label: "Set active project",
		description: "Declare the project or worktree shown in the footer. Display only: does not change cwd, tool behavior, instructions, or loaded resources. Relative paths resolve from Launch. The display is agent-reported, not automatic tracking.",
		promptSnippet: "Declare the workspace displayed in the status footer",
		promptGuidelines: ["Before deliberately starting work in a different project or worktree (including an unrelated repository), call set_active_project with its path; call it again when switching back. Do not switch for incidental reads. This signal changes only the display; use explicit tool paths/cwd for actual work."],
		parameters: Type.Object({ path: Type.String({ minLength: 1, description: "Existing project/worktree directory; relative to the original session Launch directory" }) }),
		executionMode: "sequential",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		async execute(_id, params, signal, _update, _ctx) {
			const s = session;
			if (!s) throw new Error("No active session");
			const selection = ++s.selection;
			const path = await resolveActivePath(params.path, s.launch);
			if (!current(s) || s.selection !== selection || signal?.aborted) throw new Error("Workspace selection cancelled or session changed");
			s.localAbort?.abort(); s.prAbort?.abort();
			s.localAbort = s.prAbort = undefined;
			s.refreshPending = false;
			s.active = path; s.workspace = undefined; s.prKey = undefined;
			s.pr = { kind: "unavailable", reason: "lookup pending" };
			s.requestRender?.();
			void refreshLocal(s);
			return { content: [{ type: "text", text: `Active display: ${safeText(path)}. Cwd, tools, instructions and resources are unchanged.` }], details: { version: 1, path } satisfies Selection };
		},
	});
}
