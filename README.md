# Pi Status Bar

A Pi extension that replaces the default footer with an explicit view of which project and branch the agent says is active, and of where Pi actually runs tools when that differs.

It shows, in a framed Marathon-inspired “Acid / Black” instrument panel with numbered plates:

- a **CMP** plate that always leads the frame title with the selected session branch's successful compaction count (`CMP×00`–`CMP×99`, `CMP×99+` above 99, `CMP×??` when unknown), followed by an acid `■` and the GitHub `owner/repository` with open-pull-request state when available;
- the agent-reported **Active** project: in a GitHub repository on a branch, just a grey `⑂` and branch name followed by bold colored `clean`, `modified` or `status unavailable` text; otherwise its parent/current directory, for example `Projects/pi-status-bar`, with any Git details (including detached checkouts) on an unnumbered row below;
- a plain grey `cwd` line above Active naming Pi's working directory, where tools run and project instructions were loaded from, only when it differs from Active;
- a graduated context gauge with 70%/90% thresholds, an inline context-token readout such as `84k/184k` and, at 100+ columns, a large percentage numeral. All of them measure against the auto-compaction budget, the context window minus Pi's `compaction.reserveTokens` (a `compaction.modelOverrides` entry for the current model wins; the default is 16384), so a full gauge means Pi is about to compact. With `compaction.enabled: false` they measure the full window;
- the model and thinking level, a white **⌑ PNYTL //** mode plate, plus statuses from other extensions (recognized Ponytail text is represented once by its plate, and active Tatsu v1 snapshots become `TCLI`/`AWKS` text in EXT, such as `TCLI • OK   AWKS • OK`);
- a **ROOT** working lamp and an independent **AU (Active Units)** badge from the optional public pi-subagents fleet API;
- a **USG** row with remaining subscription quota from the optional [CodexBar](https://github.com/steipete/CodexBar) CLI: for Codex (`GPT`), Claude (`CLD`) and Kimi (`KMI`), eight `■` squares per 5-hour and weekly window (each lit square is 12.5% left; used-up squares stay as grey ghosts) with the time to reset below, for example `CLD ■■■■■■■■ ■■■■■■■■` (seven lit and one grey, then eight lit) over `1h15m    5d15h`. Each provider has a fixed column, so nothing moves while data arrives.

Full PR URLs and primary-checkout rows are omitted from the footer; validated PR URLs and primary-checkout inspection data are unchanged. Cumulative token totals, cache metrics, and cost are intentionally omitted; USG shows only remaining quota. Active is display-only: selecting it does not change Pi's cwd, tools, instructions, or loaded resources. The footer uses a fixed palette rather than your Pi theme; Pi converts it for truecolor or 256-color terminals.

The native v9 frame has corners and a standalone calibration cross, without a continuous top rule or ruler ticks. Plates, context squares and ROOT/AU panels animate decoratively; readouts, counts and current digit shapes stay truthful. Run `/footer-motion off` to settle the animation for the current session, `/footer-motion on` to resume it, or `/footer-motion` to toggle. The choice is not saved.

## Quick start

Prerequisites are Node.js 22.19 or newer and an installed Pi host. Git, the `gh` CLI and the `codexbar` CLI are optional; missing or unavailable Git/GitHub integrations are shown explicitly, and without `codexbar` on PATH the USG row is simply absent.

From this repository, load the package for one Pi invocation without installing it:

```sh
pi -e .
```

The extension gives the agent a `set_active_project({ path })` tool. It should call the tool before deliberately moving work to another project or worktree and call it again when switching back. Incidental reads should not change Active.

## Limitations

Active is an agent declaration, not automatic cwd tracking, so the footer can be stale if the agent forgets to signal a switch. Paths show only their parent/current directories, so checkouts whose last two directory names match look alike; the `set_active_project` result reports the full Active path. GitHub repository detection is local; PR lookup requires a recognizable public GitHub remote plus a working, authenticated `gh` command. It checks the selected remote repository, not outbound PRs from a fork to an upstream repository. Failures are reported as unavailable rather than as clean or no-PR states.

AU is native active work, **not an exact running-agent count**: pi-subagents includes queued/pending work and counts an active workflow container as one. Known counts show at least two digits (`00 AU`, `03 AU`, `123 AU`); up to six rail marks accompany the exact uncapped total. Without a compatible owner, or on malformed/error/timeout replies, the badge shows `? AU`, never a fabricated zero. The integration was verified against Pi 1.0.2 and pi-subagents 0.76.0; it uses public in-process events, not an imported dependency or status-text parsing. Samples refresh independently of decoration, normally five seconds after the prior collection finishes, with coalesced turn/tool/ready updates. Motion off does not stop collection. ROOT comes from Pi's `isIdle()` independently of AU, including the post-`agent_end` retry/continuation period.

USG requires the CodexBar CLI (`codexbar`, verified against 0.60.3) on PATH with the providers already signed in; it runs only the read-only `codexbar usage --provider <id> --format json --json-only` and never prompts. Codex and Claude fetches take about 20 seconds each, so those providers show `pending` after startup; all three refresh five minutes after each round completes. A failed fetch keeps the last good squares, grey-tagged with their age (`16m`, `5h`, `2d`, `99+`); data older than 15 minutes is marked the same way, and a failure without earlier data shows `????????` with `timeout` or `failed`, never CodexBar's raw message. A provider that reports no 5-hour or weekly window shows `none`. Only 5-hour and weekly windows are shown; other windows are ignored. The row draws in left to right from its plate when it first appears, each provider's squares fill in when its data first arrives after that, the edge square of each draining window briefly shrinks to `▪` and dims, and lost squares burn out when quota drops. `/footer-motion off` holds them all steady; countdowns keep updating every minute either way. `■`/`▪` are ambiguous-width characters: terminals set to render ambiguous characters wide will misalign the row, and live-terminal rendering has not been verified.

CMP counts successful compactions persisted on the currently selected session branch, including ones inherited from earlier on that branch; abandoned sibling branches, branch summaries and failed or cancelled compaction attempts are not counted. It is not a context-usage reading. Unknown is `CMP×??`, never a fabricated zero, and counts above 99 deliberately show `CMP×99+` to keep the plate eight cells wide.

## Tatsu status compatibility

The optional pi-tatsu-status-bar public v1 event API supplies an **EXT** entry of plain text, one part per component, in the same status-key order as its built-in text, for example `TCLI ▲ UP×1   AWKS • OK`. The label is a dim grey `TCLI` or `AWKS`; the state is a bold shape and short code in the state's colour: acid `• OK`, amber `▲ UP×N`/`▲ FIX`/`◆ EDIT`, red `✕ MISS` (not installed)/`✕ NRUN` (not runnable)/`✕ UNAV` (unavailable), and grey `· CHK` (checking)/`· OFF` (inactive). Unknown counts omit `×N`; UP/FIX can also carry `◆ EDIT` for local edits. Three spaces separate the parts, and a narrow line breaks between them rather than inside one.

Both load orders work. A valid checking/completed snapshot is displayed even when the provider hides its built-in text; absent, incompatible, invalid and inactive data preserve whatever raw `tatsu-status` text the provider leaves. No formatter is registered, no provider package is imported, and this consumer runs no checks or polling. The entry draws in on appearance, checking shapes cycle while the grey `CHK` code gently fades, a changed completed result latches its state once, and UP/FIX triangles briefly shrink and dim every four seconds. `/footer-motion off` settles them; resume replays nothing. The new glyphs are one cell with installed Pi TUI, but ambiguous-wide terminal settings/font choices can affect alignment and apparent size, as with USG's squares. Live-terminal and live-provider validation remain unverified. The provider re-checks every five minutes and briefly reports both components as checking each time; once a completed result has been shown, a refresh keeps that last completed result on screen, so the text only changes when a new result differs. `CHK` appears only before the first completed result (session start, or after inactive, invalid or absent data cleared it).

## Ponytail activation and compatibility

PNYTL uses **Ponytail 4.13.0's existing status text** on key `ponytail`, tested with Pi 1.0.4. It shows `LTE`, `FUL`, `ULT`, legacy restored `REV`, or `OFF` after observing an explicit clear. `CHK` is the short initialization turn; missing, hidden or incompatible output becomes `UNK`, never an inferred OFF/default.

For reliable startup/restoration, when separately enabling this integration:

1. Enable Ponytail's status emission: set `"hideStatus": false` in its configuration (`~/.config/ponytail/config.json`, or the configured XDG/platform location). `PONYTAIL_HIDE_STATUS=0` overrides a hidden setting. This package does **not** edit that configuration.
2. Load **pi-status-bar before Ponytail**. With both in Pi's `packages` array, place pi-status-bar's entry earlier; other CLI/project extension sources can affect effective order. Start/reload Pi only when ready to activate the change.
3. Check idle `/ponytail lite`, `/ponytail ultra`, and `/ponytail off`: the dedicated plate updates, without a duplicate raw Ponytail status. `/ponytail default ...` changes the default, **not the current mode**. REVIEW is a legacy restored state, not an accepted review mode command.

**Order matters for initial OFF.** Ponytail expresses OFF by deleting its status key. If Ponytail runs first, the footer can recover known labels from Pi's current map but cannot recover an earlier clear; it truthfully shows UNK until a later explicit emission, such as `/ponytail off`. It never treats an absent key as OFF. Runtime UI replacement must rebind the footer before a clear (normal session startup/reload does this with the order above).

Recognized Ponytail status is represented by the plate instead of duplicated in EXT. Host status data is untouched, every **other key** remains intact, and unrecognized Ponytail warnings/text remain sanitized in EXT alongside UNK. There is no Ponytail RPC, runtime import, polling, prompt/session/default inference or producer patch. A narrow reversible observer of public `ctx.ui.setStatus` distinguishes clear from absence; this relies on tested Pi 1.0.4 shared-UI behavior, not a documented subscription API. See [architecture](docs/architecture.md#ponytail-status-integration).

The white plate and black title/slashes stay static. While Ponytail reports the agent is running a turn (its own `●` dot), the `⌑` icon alternates with a small pink `•` light (the CMP pink), 50 ms each (10 blinks a second); `/footer-motion off` holds the light on instead. On a mode change, only the three current mode letters can flash two seeded random subsets black, then recover; no sweep or scrambling. First discovery, OFF/CHK/UNK and motion off settle immediately. Activity-dot changes drive only the light and do not restart mode flashes; resuming motion does not replay off-time changes.

No live interactive-terminal/motion, live CodexBar or live fleet-owner smoke test is claimed; automated tests use the installed Pi loader and public bus with offline replies and a fake `codexbar`.

## Project guides

- [Mission](docs/mission.md)
- [Design](docs/design.md)
- [Architecture](docs/architecture.md)
- [Contributing](CONTRIBUTING.md)
