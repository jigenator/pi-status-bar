# Design

## Experience

The footer is for people supervising a Pi session that may cross repositories or worktrees. It should answer “where did this session launch, what project does the agent say it is working in, and what is that checkout's state?” without implying that the display controls execution.

The desired tone is factual and compact. Unknowns and failures are named; the interface never reassures with “clean” or “no open PR” when a lookup failed. The anti-goal is a dashboard with controls or cumulative usage/cost detail.

## Interaction and visual language

`set_active_project({ path })` is the only interaction. The agent calls it before deliberately moving work and when switching back. Relative paths resolve from Launch; valid Git paths normalize to checkout roots. Invalid or cancelled selections leave the previous Active value unchanged.

Rows appear in this order:

1. Launch path.
2. Active path plus active Git state or an explicit Git pending/none/unavailable state.
3. Main checkout only when it is distinct, or its unavailable state when relevant.
4. GitHub repository plus PR state, or explicit no-remote/unavailable/pending state.
5. Context usage and current model/thinking.
6. One row per other extension status.

Launch, Active, and Main abbreviate the home directory as `~`, including the home directory itself; similarly named sibling directories remain absolute. GitHub shows only `owner/repository`, without repeating its repository URL. PR numbers/URLs appear when an open PR is found; confirmed absence and not-applicable states have no PR suffix or trailing separator. Lookup failures still show an unavailable warning. These are display transformations only; stored paths and lookup URLs stay absolute/full.

Semantic host theme colors communicate dim metadata, success, warning, and error. Content wraps rather than disappearing at narrow widths. The renderer reads model, thinking, context, and extension statuses each frame so those values stay current.

## Accessibility and platform behavior

The footer is text-first and keyboard interaction remains Pi's responsibility; this extension adds no focusable controls. It uses host semantic theme colors rather than fixed color values, and every state also has a text label so color is not the sole signal. Every emitted line is bounded to terminal width, including widths narrower than a single wide glyph.

Paths, branches, URLs, errors, and status content are treated as untrusted terminal text. Control characters, bidi controls, OSC links, and non-style escapes are removed. Other extensions' SGR color sequences are preserved and reset per status row. Supported colon-form RGB/indexed foreground and background colors are normalized to Pi's semicolon form so their styling also survives wrapping.

## UI states

| State | Display behavior |
| --- | --- |
| Initial/local refresh | Active remains visible with Git/GitHub pending until a snapshot arrives |
| Plain directory | `Not a Git repository` and `No GitHub remote` |
| Git repository without GitHub | Branch plus clean/modified/unavailable status and `No GitHub remote` |
| Linked worktree | Active checkout and distinct repository-primary checkout each show their own branch/status |
| Detached or unborn checkout | Detached revision when available, or branch with no revision; never fabricate a branch |
| Open PR | Repository and validated PR number/URL |
| No open PR or PR not applicable | Repository name only; omit the PR field and separator |
| Integration failure | Explicit Git/GitHub/PR unavailable reason; no success-shaped fallback |
| Non-TUI mode | Tool and state lifecycle continue; no footer component is installed |

## Verification and open questions

Automated checks cover snapshots, semantic states, Unicode widths 1–160, terminal-control sanitization, live host values/statuses, real package loading, selection failure, session tree/reload/resume/fork behavior, polling/TTL, cancellation, and disposal.

Not yet verified: subjective rendering in a live interactive terminal, color/spacing across multiple themes, Windows behavior, and a real authenticated GitHub response. There is no open design proposal to automate Active; revisit only if explicit signaling proves unreliable and a trustworthy non-incidental signal becomes available.
