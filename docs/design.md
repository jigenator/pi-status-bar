# Design

## Experience

The footer is for people supervising a Pi session that may cross repositories or worktrees. It should answer “where did this session launch, what project does the agent say it is working in, and what is that checkout's state?” without implying that the display controls execution.

The desired tone is factual and compact. Unknowns and failures are named; the interface never reassures with “clean” or “no open PR” when a lookup failed. The anti-goal is a dashboard with controls or cumulative usage/cost detail.

The visual language is the selected Marathon-inspired “01 — Acid / Black” footer from Terminal Lab: a framed instrument panel with solid numbered label plates, a graduated context gauge, a wide-only context numeral, a model band, and decorative frame motion. Native v9 retains the selected Acid / Black palette and parent/current paths, with padded numbered plates, a tick-free scale and Thread Rail activity. The browser prototype is a visual reference, not production telemetry or a fixed-size terminal layout.

## Interaction and visual language

`set_active_project({ path })` is the agent's interaction. The agent calls it before deliberately moving work and when switching back. Relative paths resolve from Launch; valid Git paths normalize to checkout roots. Invalid or cancelled selections leave the previous Active value unchanged.

`/footer-motion [on|off]` is the only user control. An empty argument toggles. It settles or resumes decoration for the current session only, is not persisted, and never freezes live values.

The header always opens with an eight-cell **CMP** plate: the number of successful compactions persisted on the selected session branch, as ` CMP×00 `…` CMP×99 `, ` CMP×99+` above 99 (the `+` takes the trailing pad cell) or ` CMP×?? ` when unknown; `×` is the multiplication sign. CMP shows in plain folders and repositories without GitHub too. Beside it, on the content column of the rows below, the header carries `owner/repository`, then any open PR number or a PR unavailable reason. Repository-less lookups say `GitHub pending` or `GitHub unavailable (reason)` so they cannot be read as a CMP state. When no GitHub remote exists, the plate stands alone without repository text. Rows then appear in this order:

1. ` 01 LDR ` path.
2. ` 02 ACT ` path. Immediately below the complete path (after any wrapping), an unnumbered Git-details continuation shows a small grey `⑂` (U+2442) plate, the existing white plate with dark branch text, and the colored clean/modified/status-unavailable plate. Git pending or Git unavailable messages occupy this same continuation; a plain directory has no Git line. Primary-checkout paths, state and unavailable messages are not rendered.
3. ` 03 CTX ` gauge with protected inline readout and WARN/HIGH/UNKNOWN tag; at 100+ columns, when content fits, a tick-free number scale and three-row numeral sit beside the Git-details/context block.
4. ` 04 MDL ` provider/model and thinking level on the model band.
5. ` 05 EXT ` plus one or more rows for every other extension status, verbatim and sorted by status key.

Launch and Active show only the immediate parent and current directory, for example `Projects/pi-status-bar`. Home itself is `~` and a direct child of home is `~/name`. Root, a single component, and two-component paths are shown in full because nothing would be elided; relative values are shown as given. GitHub shows only `owner/repository`, without repeating its repository URL. Only PR numbers appear when an open PR is found; full PR URLs are omitted at every width. Confirmed absence and not-applicable states have no PR suffix. These are display transformations only; stored paths and lookup URLs stay absolute/full. Distinct paths can share the same parent/current display; that ancestry loss is the approved trade-off.

Layouts respond to width: wrapped repository/PR lines stay on the same content column as the first line; 100+ columns may show the large context numeral; 40–99 columns keep the padded eight-cell numbered plates and use a compact gauge. The track's inline readout has one real blank cell on each side, including Unknown. The number scale retains as many labels (`0 10 … 70 … 90 100`) as fit without ruler ticks. Below 40 columns a minimal fallback keeps every field with wrapped inline labels, starting with the CMP plate. Values wrap rather than truncate. Continuation rows leave the plate column plain, without colored tabs. Corners and side stubs remain; there is no continuous top rule.

The header's Thread Rail has a full-cell root lamp, blank separator, bright `ROOT` panel, up to six unit marks and an exact **AU (Active Units)** badge. ROOT's right edge aligns with the wide context divider and the badge's left background edge with context captions when anchors fit; otherwise activity right-aligns with corner clearance or wraps to its own row. Known counts are zero-padded to two digits and Unknown keeps a bare `?`, so 0–99/Unknown use a seven-cell badge (` 00 AU `, ` 03 AU `, ` 12 AU `, `  ? AU `); 100+ widens it with the exact value. Rail marks yield first at tight widths, then activity moves to its own row. Neither title nor total is clipped to preserve decoration.

ROOT reflects the root session's public `isIdle()` state, independently of AU. AU is the optional pi-subagents native active-work total, including queued/pending items and a workflow container as one; it is not a count of exactly running agents. Unknown data is `? AU`, distinct from confirmed `00 AU`. Native adapter snapshots always supply root state; a renderer used without activity has a static hatched unknown lamp. ROOT stays bright even while Idle.

## Palette and context semantics

The palette is fixed, not taken from the host theme: field `#000000`, primary `#c0fe04`, text `#ffffff`, secondary text `#cfcfcf`, plates `#555555`, surface/band/track `#1c1c1c`, warning `#d79e52`, high/error `#f24723`, and graphic grey `#717171`. CMP uses an approved Marathon-reference count palette (background / text, with truecolor contrast): 0 and Unknown plate `#555555` / `#ffffff` (7.46:1), 1–2 violet `#5200ff` / `#ffffff` (7.49:1), 3–4 pink `#ff15bd` / `#000000` (6.09:1), 5+ high `#f24723` / `#000000` (5.70:1). It is a product-specific choice, not an official brand specification. The only mixed colors are the warning and high gauge zones, 20% of each over black (`#2b2010`, `#300e07`). Pi's `theme.style` converts these colors for truecolor or 256-color terminals; the host theme and settings are not changed.

Context is read from the host on every render. Gauge cells cover 0–100%, and a cell lights when any of its slice is used, so only true 0% is empty. Above 70% is warning and above 90% is high; exactly 70 or 90 stays in the lower tone. Unknown, missing, or non-finite usage is a hatched track with `?`, never 0%. Values over 100% or below 0% are shown as-is in the readout and numeral; only the gauge's graphical extent clamps. A missing or invalid context window omits the `/window` suffix.

## Motion

Motion is decoration only. A supplied-time/seed plan provides varied boot treatments across actual paths, title, chips, model, statuses and context readout. Corners draw in and the standalone center `┼` makes a small calibration nudge once every six seconds. Boot never masks ROOT/AU. The CMP plate shows its current count from the first frame; for the first two boot ticks it swaps its approved background and text colors, keeping their contrast, then settles. CMP is not a re-strike or ghost target. Current large context digits reconstruct square by square from grey/current color; old-only pixels clear immediately and target geometry updates immediately (**new shape only**, not the browser's old-to-new retained-pixel morph). The exact small readout and graphical fill are immediate, even through rapid retargeting or Unknown transitions.

Fresh re-strike plans start every 4–6 seconds start-to-start. Whole-plan shuffling lets ROOT or AU lead or follow other plates/numeral/caption patches; each panel is selected independently about half the time. Re-strikes affect backgrounds, lettering colors and padding without changing characters/current digit occupancy. Ghosts have a separate A+B duration plus 2.2–4.2 second wait; fill glitches affect only the currently filled track. Readout including padding, unfilled/Unknown gauge, all activity cells during ghosts, other extensions' styled content, lamp/separators/unit marks/gaps during re-strikes remain protected. Plans resolve against current geometry and eventually recover fully.

Working lamp cadence is 500 ms acid / 300 ms dim; Idle is static dim. Ambient plans run in both Working and Idle, without focus gating. The adapter owns one bounded, unref'd decoration timeout, with 50 ms transient granularity and renderer-selected sleeps, never a free-running interval or data collector. `/footer-motion off` settles all motion immediately but preserves live ROOT/AU, CMP, context/model/statuses and Git/PR updates. Resuming starts fresh without catch-up. No v9 render-cost or full-host repaint-performance measurement is claimed.

## Accessibility and platform behavior

The footer is text-first and keyboard interaction remains Pi's responsibility; this extension adds no focusable controls. Every state has text: chips say clean/modified/status unavailable, the context tag says WARN/HIGH/UNKNOWN, and failures say unavailable with a reason, so color is never the sole signal. Every emitted line is bounded to terminal width, including widths narrower than a single wide glyph. There is no host reduced-motion signal, so the session command is the pause/reduced-motion control.

Paths, branches, URLs, errors, and status content are treated as untrusted terminal text. Control characters, bidi controls, OSC links, and non-style escapes are removed. Other extensions' SGR color sequences are preserved, not recolored. Their resets restore the footer field instead of the terminal default, and each status row is reset before footer padding and frame glyphs. Supported colon-form RGB/indexed foreground and background colors are normalized to Pi's semicolon form so their styling also survives wrapping.

## UI states

| State | Display behavior |
| --- | --- |
| Initial/local refresh | Active remains visible with Git pending below its path and `GitHub pending` beside the CMP plate until a snapshot arrives |
| Plain directory | Paths and the CMP plate; omit Git absence text and repository text |
| Git repository without GitHub | Branch plus clean/modified/unavailable chip; CMP plate without repository text |
| Compaction count 0 / 1–2 / 3–4 / 5–99 / 100+ / unknown | ` CMP×00 ` grey / violet / pink / red-orange plate; ` CMP×99+`; grey ` CMP×?? `, never zero |
| Linked worktree | Active path followed by its Git details; primary-checkout information remains in workspace inspection data only |
| Detached or unborn checkout | Detached revision when available, or branch with no revision; never fabricate a branch |
| Open PR | Repository and validated PR number in the frame title, without the URL |
| No open PR or PR not applicable | Repository name only; omit the PR field and separator |
| Integration failure | Explicit Git/GitHub/PR unavailable reason; no success-shaped fallback |
| Context 0 / warning / high / unknown | Empty gauge / amber plate and `▲ WARN` / red plate and `▲ HIGH` / grey plate, hatch and `? UNKNOWN` |
| Motion off | Settled frame; live values continue to update |
| Non-TUI mode | Tool, state, and motion command continue; no footer, decoration timer or fleet collector is installed |

## Verification and open questions

Automated checks cover the selected palette and layouts, CMP formatting/color pairs/boot polarity/visibility/alignment and zero-padded AU, snapshots at 100/72/48/30 columns, semantic states, context thresholds and invalid values, Unicode widths 1–160 in every state and motion frame, field preservation, absent continuation tabs, terminal-control sanitization, live host values/statuses, motion frames and scheduling, the motion command, timer disposal, real package loading, selection failure, session tree/reload/resume/fork behavior, polling/TTL, cancellation, and disposal.

Not yet verified: `⑂` font fidelity in a live terminal, subjective rendering and motion in a live interactive terminal, 256-color fidelity on real terminals, Windows behavior, live fleet-owner activity, and a real authenticated GitHub response. Lifecycle tests use the real installed Pi loader/bus with offline, asynchronous fleet replies and errors/timeouts. There is no open design proposal to automate Active; revisit only if explicit signaling proves unreliable and a trustworthy non-incidental signal becomes available.
