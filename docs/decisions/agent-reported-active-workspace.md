# Agent-reported active workspace

Status: current.
Date/evidence: 2026-10-04 product requirements; implemented in `src/extension.ts` and covered by `test/extension.test.ts`.
Supersedes / superseded by: none.

## Problem

A Pi session can launch in one directory while the agent deliberately works in another repository or linked worktree. File reads are not a reliable signal: agents may inspect unrelated projects incidentally, and Pi's session cwd does not necessarily represent the intended project display.

## Choice and alternatives

Expose `set_active_project({ path })` as an explicit agent signal. Launch remains the original session header cwd. Active starts at Launch, validates an existing directory, resolves a Git checkout root when present, and persists in successful tool-result details along the selected session branch.

The signal is display-only. It does not call `process.chdir`, wrap tools, enforce cwd, or reload instructions/resources.

Rejected alternatives:

- **Infer from file/tool access:** incidental reads would create false switches and there is no single reliable project root for every tool.
- **Treat Pi cwd as Active:** it cannot represent deliberate work in an unrelated path while preserving the launch location.
- **Make selection enforce execution cwd:** that couples a status display to tool behavior and could silently change work semantics.
- **Persist globally:** it would leak one session's context into another.

## Consequences and verification

The prompt guideline asks the agent to signal before deliberate moves and when switching back, but the footer can be stale if the agent forgets. Because Active never changes execution, the footer names Launch (as `cwd`) whenever it differs from Active: that is when tools and loaded instructions come from somewhere other than the reported project. Invalid/cancelled signals preserve state. Session tree navigation restores the latest successful signal on the selected branch; reload, resume, and fork retain it, while a new session starts at Launch.

`test/extension.test.ts` verifies display-only behavior, invalid/aborted calls, branch-relative restoration, reload/resume/fork, fresh-session reset, and stale-work ownership.

## Revisit when

Reconsider only with evidence that explicit signaling is materially unreliable and a Pi API provides a trustworthy project-switch event that excludes incidental cross-project reads. Any replacement must preserve display-only behavior and branch/session isolation.
