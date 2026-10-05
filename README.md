# Pi Status Bar

A Pi extension that replaces the default footer with an explicit view of where the session launched and which project the agent says is active.

It shows, in a framed Marathon-inspired “Acid / Black” instrument panel with numbered plates:

- GitHub repository and open-pull-request state in the frame title when available;
- fixed **Launch** and agent-reported **Active** paths as their parent/current directories, for example `Projects/pi-status-bar`;
- active Git branch and clean/modified state;
- the repository's primary checkout (`2.1 MN`) when Active is a linked worktree;
- a graduated context gauge with 70%/90% thresholds and, at 100+ columns, a large percentage numeral;
- the model and thinking level, plus statuses from other extensions;
- a **ROOT** working lamp and an independent **AU (Active Units)** badge from the optional public pi-subagents fleet API.

Token totals, cache metrics, and cost are intentionally omitted. Active is display-only: selecting it does not change Pi's cwd, tools, instructions, or loaded resources. The footer uses a fixed palette rather than your Pi theme; Pi converts it for truecolor or 256-color terminals.

The native v9 frame has corners and a standalone calibration cross, without a continuous top rule or ruler ticks. Plates, context squares and ROOT/AU panels animate decoratively; readouts, counts and current digit shapes stay truthful. Run `/footer-motion off` to settle the animation for the current session, `/footer-motion on` to resume it, or `/footer-motion` to toggle. The choice is not saved.

## Quick start

Prerequisites are Node.js 22.19 or newer and an installed Pi host. Git and the `gh` CLI are optional; missing or unavailable integrations are shown explicitly.

From this repository, load the package for one Pi invocation without installing it:

```sh
pi -e .
```

The extension gives the agent a `set_active_project({ path })` tool. It should call the tool before deliberately moving work to another project or worktree and call it again when switching back. Incidental reads should not change Active.

## Limitations

Active is an agent declaration, not automatic cwd tracking, so the footer can be stale if the agent forgets to signal a switch. Paths show only their parent/current directories, so checkouts whose last two directory names match look alike; the `set_active_project` result reports the full Active path. GitHub repository detection is local; PR lookup requires a recognizable public GitHub remote plus a working, authenticated `gh` command. It checks the selected remote repository, not outbound PRs from a fork to an upstream repository. Failures are reported as unavailable rather than as clean or no-PR states.

AU is native active work, **not an exact running-agent count**: pi-subagents includes queued/pending work and counts an active workflow container as one. Up to six rail marks accompany the exact uncapped total. Without a compatible owner, or on malformed/error/timeout replies, the badge shows `? AU`, never a fabricated zero. The integration was verified against Pi 1.0.2 and pi-subagents 0.76.0; it uses public in-process events, not an imported dependency or status-text parsing. Samples refresh independently of decoration, normally five seconds after the prior collection finishes, with coalesced turn/tool/ready updates. Motion off does not stop collection. ROOT comes from Pi's `isIdle()` independently of AU, including the post-`agent_end` retry/continuation period.

No live interactive-terminal/motion or live fleet-owner smoke test is claimed; automated tests use the installed Pi loader and public bus with offline replies.

## Project guides

- [Mission](docs/mission.md)
- [Design](docs/design.md)
- [Architecture](docs/architecture.md)
- [Contributing](CONTRIBUTING.md)
