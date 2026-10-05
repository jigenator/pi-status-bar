import { randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { advanceMotion, motionFrame, nextMotionDelay, renderFooter, safeText, startMotion } from "./footer.ts";
import type { FooterSnapshot, MotionState } from "./footer.ts";
import { inspectPullRequest, inspectWorkspace, resolveActivePath } from "./workspace.ts";
import type { PullRequestInfo, WorkspaceInfo } from "./workspace.ts";

const LOCAL_REFRESH_MS = 15_000;
const PR_TTL_MS = 60_000;
const ACTIVITY_REFRESH_MS = 5_000;
const ACTIVITY_MIN_MS = 1_000;
const RPC_TIMEOUT_MS = 2_000;
const RPC_REQUEST = "subagents:rpc:v1:request";
const RPC_READY = "subagents:rpc:v1:ready";
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const motionSeed = () => randomBytes(4).readInt32LE();
type Selection = { version: 1; path: string };
// Decoration only: owned by one installed TUI footer and never triggers inspection.
type Animation = { state: MotionState; timer?: ReturnType<typeof setTimeout>; due?: number; schedule(now: number): void; resume(): void };
type ActivityCollector = { refresh(): void; dispose(): void };
type SessionState = {
	ctx: ExtensionContext;
	id: string;
	disposed: boolean;
	units: number | null;
	activity?: ActivityCollector;
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
	const current = (s: SessionState) => session === s && !s.disposed;
	const stopWork = (s: SessionState) => {
		s.disposed = true;
		s.activity?.dispose();
		s.activity = undefined;
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

	// Public process-local RPC only. The optional owner is not a Node dependency.
	// Pi emit() does not await async handlers: subscribe and arm timeout BEFORE emit.
	function collectActivity(s: SessionState): ActivityCollector {
		let live = true, busy = false, pending = false, lastStart = -Infinity;
		let timer: ReturnType<typeof setTimeout> | undefined, due = Infinity;
		let cancelReply: (() => void) | undefined;
		const owned = () => live && current(s) && s.ctx.sessionManager.getSessionId() === s.id;
		const publish = (units: number | null) => {
			if (owned() && s.units !== units) { s.units = units; s.requestRender?.(); }
		};
		const schedule = (delay: number) => {
			if (!owned()) return;
			const now = performance.now(), next = Math.max(now + delay, lastStart + ACTIVITY_MIN_MS);
			if (timer && due <= next) return;
			if (timer) clearTimeout(timer);
			due = next;
			timer = setTimeout(() => { timer = undefined; due = Infinity; poll(); }, next - now);
			timer.unref();
		};
		const request = (method: "ping" | "status", receive: (data: Record<string, unknown> | null) => void) => {
			const requestId = randomUUID();
			let done = false;
			const finish = (data: Record<string, unknown> | null) => {
				if (done) return;
				done = true; unsubscribe(); clearTimeout(timeout); cancelReply = undefined;
				if (owned()) receive(data);
			};
			const unsubscribe = pi.events.on(`subagents:rpc:v1:reply:${requestId}`, (reply) => {
				finish(record(reply) && reply.version === 1 && reply.requestId === requestId
					&& (reply.method === undefined || reply.method === method) && reply.success === true
					&& record(reply.data) && reply.data.isError !== true ? reply.data : null);
			});
			const timeout = setTimeout(() => finish(null), RPC_TIMEOUT_MS); timeout.unref();
			cancelReply = () => { done = true; unsubscribe(); clearTimeout(timeout); };
			try { pi.events.emit(RPC_REQUEST, { version: 1, requestId, method, source: { extension: "pi-status-bar" } }); }
			catch { finish(null); }
		};
		const finishPoll = (units: number | null) => {
			busy = false; publish(units);
			const delay = pending ? 250 : ACTIVITY_REFRESH_MS;
			pending = false; schedule(delay);
		};
		function poll() {
			if (!owned() || busy) return;
			busy = true; lastStart = performance.now();
			request("ping", (data) => {
				if (!data || data.version !== 1 || !record(data.session) || data.session.sessionId !== s.id
					|| !record(data.capabilities) || !record(data.capabilities.fleetStatus) || data.capabilities.fleetStatus.version !== 1) {
					finishPoll(null); return;
				}
				request("status", (status) => {
					const fleet = status?.fleet;
					finishPoll(record(fleet) && fleet.version === 1 && count(fleet.totalActive)
						&& Array.isArray(fleet.entries) && count(fleet.omitted)
						&& fleet.omitted === fleet.totalActive - fleet.entries.length ? fleet.totalActive : null);
				});
			});
		}
		const refresh = () => { if (busy) pending = true; else schedule(250); };
		const unsubscribeReady = pi.events.on(RPC_READY, (data) => {
			if (!owned() || !record(data) || data.version !== 1 || !record(data.session) || data.session.sessionId !== s.id) return;
			// A replacement owner invalidates its predecessor's in-flight response.
			cancelReply?.(); cancelReply = undefined; busy = pending = false;
			publish(null); refresh();
		});
		schedule(250); // let all session_start handlers finish restoring their owner
		return { refresh, dispose() {
			live = false;
			if (timer) clearTimeout(timer);
			cancelReply?.(); unsubscribeReady();
		} };
	}

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
		const s: SessionState = { ctx, id, disposed: false, units: null, launch, active, selection: 0, pr: { kind: "unavailable", reason: "lookup pending" }, prCache, refreshPending: false, motion };
		session = s;
		if (ctx.mode === "tui") {
			ctx.ui.setFooter((tui, theme, footerData) => {
				if (session !== s) return { render: () => [], invalidate() {} };
				stopWork(s); s.disposed = false;
				const render = () => tui.requestRender();
				s.requestRender = render;
				const snapshot = (): FooterSnapshot => ({
					homePath, launchPath: s.launch, activePath: s.active, workspace: s.workspace, pullRequest: s.pr,
					contextUsage: s.ctx.getContextUsage(), model: s.ctx.model, thinking: pi.getThinkingLevel(),
					statuses: footerData.getExtensionStatuses(), activity: { working: !s.ctx.isIdle(), units: s.units },
				});
				s.units = null;
				let latest = snapshot();
				const animation: Animation = {
					state: startMotion(latest, performance.now(), motionSeed(), true),
					resume() {
						stopAnimation(s);
						latest = snapshot();
						const now = performance.now();
						animation.state = startMotion(latest, now, motionSeed(), false);
						animation.schedule(now);
					},
					// One unref'd decoration timeout; no telemetry collection in this path.
					schedule(now) {
						if (!s.motion || !current(s) || s.animation !== animation) return;
						const due = now + nextMotionDelay(animation.state, now);
						if (animation.timer && animation.due! <= due) return;
						if (animation.timer) clearTimeout(animation.timer);
						animation.due = due;
						animation.timer = setTimeout(() => {
							animation.timer = animation.due = undefined;
							if (!s.motion || !current(s) || s.animation !== animation) return;
							const time = performance.now();
							animation.state = advanceMotion(animation.state, latest, time);
							render();
							animation.schedule(time);
						}, due - now);
						animation.timer.unref();
					},
				};
				s.animation = animation;
				animation.schedule(performance.now());
				s.activity = collectActivity(s);
				s.timer = setInterval(() => { void refreshLocal(s); }, LOCAL_REFRESH_MS);
				s.timer.unref();
				void refreshLocal(s);
				return {
					invalidate() {},
					render(width) {
						if (!current(s) || s.animation !== animation) return [];
						latest = snapshot();
						const now = performance.now();
						if (s.motion) {
							animation.state = advanceMotion(animation.state, latest, now);
							animation.schedule(now);
						}
						return renderFooter(latest, width, theme, s.motion ? motionFrame(animation.state, now) : undefined);
					},
					dispose() { if (s.animation === animation) stopWork(s); },
				};
			});
		}
		if (ctx.mode !== "tui") void refreshLocal(s);
	}

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		if (session) stopWork(session);
		session = undefined;
		if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
	});
	pi.on("tool_execution_end", () => { if (session) { void refreshLocal(session); session.activity?.refresh(); } });
	// agent_end precedes retries/continuations; only isIdle(), not the event name,
	// determines ROOT. Pi clears run-active before delivering agent_settled.
	for (const event of ["agent_start", "agent_end", "agent_settled"] as const) {
		pi.on(event, (_event, ctx) => {
			if (!session || !current(session) || ctx.sessionManager.getSessionId() !== session.id) return;
			session.ctx = ctx;
			session.requestRender?.();
			session.activity?.refresh();
		});
	}

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
			if (s.motion) s.animation?.resume();
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
			if (session !== s || s.selection !== selection || signal?.aborted) throw new Error("Workspace selection cancelled or session changed");
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
