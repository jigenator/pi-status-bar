# Design

## Experience

The footer is for people supervising a Pi session that may cross repositories or worktrees. It should answer “where did this session launch, what project does the agent say it is working in, and what is that checkout's state?” without implying that the display controls execution.

The desired tone is factual and compact. Unknowns and failures are named; the interface never reassures with “clean” or “no open PR” when a lookup failed. The anti-goal is a dashboard with controls or cumulative usage/cost detail.

The visual language is the selected Marathon-inspired “01 — Acid / Black” footer from Terminal Lab: a framed instrument panel with solid numbered label plates, a graduated context gauge, a wide-only context numeral, a model band, and decorative frame motion. Its source composition is <https://artifacts.tatsu.systems/p46a7imypz3p/v1>; <https://artifacts.tatsu.systems/q8450ndbquez/v2> supplies the palette and two approved refinements (parent/current paths and no tabs below plates).

## Interaction and visual language

`set_active_project({ path })` is the agent's interaction. The agent calls it before deliberately moving work and when switching back. Relative paths resolve from Launch; valid Git paths normalize to checkout roots. Invalid or cancelled selections leave the previous Active value unchanged.

`/footer-motion [on|off]` is the only user control. An empty argument toggles. It settles or resumes decoration for the current session only, is not persisted, and never freezes live values.

The frame's top rule carries GitHub: `GITHUB owner/repository`, then any open PR number and URL or a PR unavailable reason. GitHub pending/unavailable states are named there. When no GitHub remote exists, the rule has no title rather than a GitHub status. Rows then appear in this order:

1. `01 LAUNCH` path.
2. `02 ACTIVE` path, with branch and clean/modified/unavailable chips, Git pending, or Git unavailable; no Git suffix for a plain directory.
3. `02.1 MAIN` only when the repository's primary checkout is distinct, or when it is unavailable.
4. `03 CTX USED` graduated gauge, readout, and WARN/HIGH/UNKNOWN tag; at 100+ columns a calibration scale and three-row numeral sit beside the Active/Main/context block.
5. `04 MODEL` provider/model and thinking level on the model band.
6. `05 EXT` plus one or more rows for every other extension status, verbatim and sorted by status key.

Launch, Active, and Main show only the immediate parent and current directory, for example `Projects/pi-status-bar`. Home itself is `~` and a direct child of home is `~/name`. Root, a single component, and two-component paths are shown in full because nothing would be elided; relative values are shown as given. GitHub shows only `owner/repository`, without repeating its repository URL. PR numbers/URLs appear when an open PR is found; confirmed absence and not-applicable states have no PR suffix. These are display transformations only; stored paths and lookup URLs stay absolute/full. Distinct paths can share the same parent/current display; that ancestry loss is the approved trade-off.

Layouts respond to width: 100+ columns is wide (numeral and scale), 60–99 compact (`0▕…▏100` gauge ends), and 40–59 narrow (unnumbered 8-column plates; the readout moves under the gauge when needed). Below 40 columns the frame cannot fit, so a minimal fallback keeps every field as inline plate labels with wrapped values. Values wrap rather than truncate. Continuation rows leave the plate column as plain field: there are no colored tabs or stubs below plates. Frame corners remain on the header and final row, with side stubs on the first and penultimate rows.

## Palette and context semantics

The palette is fixed, not taken from the host theme: field `#000000`, primary `#c0fe04`, text `#ffffff`, secondary text `#cfcfcf`, plates `#555555`, surface/band/track `#1c1c1c`, warning `#d79e52`, high/error `#f24723`, and graphic grey `#717171`. The only mixed colors are the warning and high gauge zones, 20% of each over black (`#2b2010`, `#300e07`). Pi's `theme.style` converts these colors for truecolor or 256-color terminals; the host theme and settings are not changed.

Context is read from the host on every render. Gauge cells cover 0–100%, and a cell lights when any of its slice is used, so only true 0% is empty. Above 70% is warning and above 90% is high; exactly 70 or 90 stays in the lower tone. Unknown, missing, or non-finite usage is a hatched track with `?`, never 0%. Values over 100% or below 0% are shown as-is in the readout and numeral; only the gauge's graphical extent clamps. A missing or invalid context window omits the `/window` suffix.

## Motion

Motion is decoration only. At a 50 ms tick, the header rule draws in and plates wipe in after the footer is installed; the rule's comb drifts every 400 ms and the center `┼` calibration mark nudges once every 6 s. When the real context tone changes, the context plate wipes from the previous tone and the tag flashes; when the real value crosses 70 or 90, that mark flashes. Readouts, fills, tags, and numerals always show the current value in every frame: the gallery's synthetic ratchet and dither transitions are not used.

The extension repaints only when the next frame differs. With motion on, a settled footer repaints about three times per second; transients repaint at up to 20 frames per second for at most 1.5 s. `/footer-motion off` settles the decoration immediately.

## Accessibility and platform behavior

The footer is text-first and keyboard interaction remains Pi's responsibility; this extension adds no focusable controls. Every state has text: chips say clean/modified/status unavailable, the context tag says WARN/HIGH/UNKNOWN, and failures say unavailable with a reason, so color is never the sole signal. Every emitted line is bounded to terminal width, including widths narrower than a single wide glyph. There is no host reduced-motion signal, so the session command is the pause/reduced-motion control.

Paths, branches, URLs, errors, and status content are treated as untrusted terminal text. Control characters, bidi controls, OSC links, and non-style escapes are removed. Other extensions' SGR color sequences are preserved, not recolored. Their resets restore the footer field instead of the terminal default, and each status row is reset before footer padding and frame glyphs. Supported colon-form RGB/indexed foreground and background colors are normalized to Pi's semicolon form so their styling also survives wrapping.

## UI states

| State | Display behavior |
| --- | --- |
| Initial/local refresh | Active remains visible with Git pending and GitHub pending until a snapshot arrives |
| Plain directory | Paths only; omit Git absence text and the GitHub title |
| Git repository without GitHub | Branch plus clean/modified/unavailable chip; untitled frame rule |
| Linked worktree | Active checkout and distinct `02.1 MAIN` primary checkout each show their own branch/status |
| Detached or unborn checkout | Detached revision when available, or branch with no revision; never fabricate a branch |
| Open PR | Repository and validated PR number/URL in the frame title |
| No open PR or PR not applicable | Repository name only; omit the PR field and separator |
| Integration failure | Explicit Git/GitHub/PR unavailable reason; no success-shaped fallback |
| Context 0 / warning / high / unknown | Empty gauge / amber plate and `▲ WARN` / red plate and `▲ HIGH` / grey plate, hatch and `? UNKNOWN` |
| Motion off | Settled frame; live values continue to update |
| Non-TUI mode | Tool, state, and motion command continue; no footer component or animation timer is installed |

## Verification and open questions

Automated checks cover the selected palette and layouts, snapshots at 100/72/48/30 columns, semantic states, context thresholds and invalid values, Unicode widths 1–160 in every state and motion frame, field preservation, absent continuation tabs, terminal-control sanitization, live host values/statuses, motion frames and scheduling, the motion command, timer disposal, real package loading, selection failure, session tree/reload/resume/fork behavior, polling/TTL, cancellation, and disposal.

Not yet verified: subjective rendering and motion in a live interactive terminal, 256-color fidelity on real terminals, Windows behavior, and a real authenticated GitHub response. There is no open design proposal to automate Active; revisit only if explicit signaling proves unreliable and a trustworthy non-incidental signal becomes available.
