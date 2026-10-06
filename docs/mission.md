# Mission

## Users and problem

Pi users may launch one session from a directory and later work in a different repository or linked worktree. The default footer does not make that distinction explicit, which can obscure where the session began and which checkout the agent considers current.

Pi Status Bar provides a compact, truthful footer that separates the fixed launch location from an explicit agent-reported active project while preserving context/model information and statuses from other extensions.

## Goals and non-goals

Goals:

- Keep Launch fixed for the session and show Active independently.
- Show active and repository-primary checkout Git state without confusing the launch directory for the primary checkout.
- Distinguish absence from unavailable/unknown Git and GitHub information.
- Preserve current context, model, thinking level, and extension status information. Recognized Ponytail status is represented once in its dedicated PNYTL plate; unknown warnings and every other status stay visible.
- Always show how many successful compactions are persisted on the selected session branch (CMP), keeping Unknown distinct from zero.
- Show root working state independently from optional native Active Units (AU), including queued work/workflow containers without claiming an exact running-agent count.
- Remain readable across terminal widths and safe for untrusted repository/path text.
- Refresh external changes without doing local or network I/O during rendering.
- Present this in the selected Acid / Black instrument-panel design, whose decorative motion never changes or delays displayed values and can be turned off per session.

Non-goals:

- Changing or enforcing Pi's cwd, tool behavior, instructions, or loaded resources.
- Automatically inferring project switches from reads or other incidental activity.
- Performing Git writes, opening pull requests, or configuring/authenticating GitHub.
- Showing cumulative token totals, cache metrics, or cost.
- Adding persistent settings UI, clickable controls, branch watchers, or a general workspace-management framework.

Success is represented by deterministic coverage of the workspace, renderer, and real Pi loader/lifecycle boundaries. Live authenticated GitHub and subjective interactive ergonomics remain explicit validation gaps.

## Constraints

- The runtime uses Node.js standard library plus host-provided Pi, Pi TUI, and TypeBox peers; no bundled runtime dependencies.
- Local Git and `gh` operations are read-only, bounded, cancellable, and outside render. Decoration timers only advance pure motion memory and request repaints; optional public fleet requests are independently bounded and disposed.
- Active selection is session-local and follows the selected session branch; it must not leak to a new session.
- Missing tools, auth, network, checkout metadata, or malformed external responses remain visible as unavailable states.
- The extension must continue to work in non-TUI Pi modes even though no footer is installed.
