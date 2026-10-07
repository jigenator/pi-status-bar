# Agent guide

Purpose: maintain a truthful, display-only Pi footer for sessions that move across projects and worktrees; see [README.md](README.md) and [docs/mission.md](docs/mission.md).

## Critical engineering rules

- Never represent unavailable Git or GitHub data as clean or absent; preserve the discriminated results in `src/workspace.ts`. Usage windows likewise keep pending, failed, stale and unknown distinct from real quota (`src/usage.ts`). Full rule: [conventions — types and validation](docs/conventions.md#types-and-validation). Check: `test/workspace.test.ts` and `test/usage.test.ts`.
- Active is agent-reported display state only. Do not change cwd, wrap tools, reload instructions/resources, or infer switches from incidental reads. Rationale: [agent-reported active workspace](docs/decisions/agent-reported-active-workspace.md). Check: `test/extension.test.ts`.
- Keep local/remote I/O out of render, sanitize untrusted terminal content, retain extension status information (recognized `ponytail` goes to PNYTL; unknown text stays in EXT), and bound every rendered line. Decoration motion only repaints; displayed values are always current. Full flow: [architecture](docs/architecture.md). Check: `test/footer.test.ts` and `test/extension.test.ts`.
- Do not install dependencies to run this repository. Pi provides declared peer packages; use the existing host prerequisite and commands in [CONTRIBUTING.md](CONTRIBUTING.md).

## Read for the task

Start here and scan the supporting-documents map. Read every document whose `Read when` condition matches the task; do not load the whole tree by default.

| Task | Read before changing |
| --- | --- |
| Code or test change | Relevant flow in [architecture](docs/architecture.md) → applicable rule in [conventions](docs/conventions.md) → [validation sequence](CONTRIBUTING.md#full-validation-sequence) |
| Human-facing footer change | Also [design](docs/design.md) and [mission](docs/mission.md) |
| Active selection or persistence | Also [the active-workspace decision](docs/decisions/agent-reported-active-workspace.md) |
| Packaging or test-host wiring | [CONTRIBUTING.md](CONTRIBUTING.md) and the package boundary in [architecture](docs/architecture.md#system-and-module-map) |

## Where work belongs

| Change | Start here | Relevant boundary |
| --- | --- | --- |
| Path, Git, worktree, remote, or PR semantics | `src/workspace.ts` | Node standard library only; no Pi UI/session state |
| CodexBar invocation, provider list, or usage-window parsing | `src/usage.ts` | Node standard library only; no Pi UI/session state |
| Footer content, sanitization, wrapping, palette, or motion frames | `src/footer.ts` | Pure snapshot-and-frame-to-lines rendering; I/O and clocks forbidden |
| Tool/command registration, persistence, polling, cache, animation timer, or lifecycle | `src/extension.ts` | Use public Pi APIs; guard stale work and dispose resources |
| Regression coverage | Matching file in `test/` | Isolated fixtures; real installed loader only at integration boundary |

## Implement and verify

Trace callers before changing shared behavior. Follow `docs/conventions.md`; identify a nonconforming pattern instead of copying it. Avoid duplicate semantics and abstractions for hypothetical variants. Use only the canonical command sequence in `CONTRIBUTING.md`, and report passed, failed, skipped, and not-run checks plus missing prerequisites.

## Supporting documents

Every supporting guidance document is listed here. Keep this map current when guidance is added, moved, or removed.

| Document | Purpose | Read when |
| --- | --- | --- |
| [README.md](README.md) | User purpose, behavior, quick start, and limitations | Understanding or changing user-facing usage |
| [CLAUDE.md](CLAUDE.md) | Exact agent-runtime import of this guide | Checking runtime instruction discovery |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Toolchain, setup, commands, and review workflow | Implementing, testing, or reviewing any change |
| [docs/mission.md](docs/mission.md) | Product goals, non-goals, and constraints | Choosing scope or changing product behavior |
| [docs/conventions.md](docs/conventions.md) | Engineering rules, examples, checks, inventory, and gaps | Writing, refactoring, or reviewing code |
| [docs/architecture.md](docs/architecture.md) | Current modules, contracts, flows, invariants, and limits | Tracing behavior or changing dependencies/state/I/O |
| [docs/design.md](docs/design.md) | Footer experience, visual behavior, accessibility, and UI states | Changing human-facing output or interaction |
| [docs/decisions/agent-reported-active-workspace.md](docs/decisions/agent-reported-active-workspace.md) | Why Active is explicit, agent-reported, and display-only | Changing selection semantics, persistence, or cwd relationship |
