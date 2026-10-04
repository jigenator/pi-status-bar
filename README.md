# Pi Status Bar

A Pi extension that replaces the default footer with an explicit view of where the session launched and which project the agent says is active.

It shows:

- fixed **Launch** and agent-reported **Active** paths;
- active Git branch and clean/modified state;
- the repository's primary checkout when Active is a linked worktree;
- GitHub repository and open-pull-request state when available;
- current context usage, model, thinking level, and statuses from other extensions.

Token totals, cache metrics, and cost are intentionally omitted. Active is display-only: selecting it does not change Pi's cwd, tools, instructions, or loaded resources.

## Quick start

Prerequisites are Node.js 22.19 or newer and an installed Pi host. Git and the `gh` CLI are optional; missing or unavailable integrations are shown explicitly.

From this repository, load the package for one Pi invocation without installing it:

```sh
pi -e .
```

The extension gives the agent a `set_active_project({ path })` tool. It should call the tool before deliberately moving work to another project or worktree and call it again when switching back. Incidental reads should not change Active.

## Limitations

Active is an agent declaration, not automatic cwd tracking, so the footer can be stale if the agent forgets to signal a switch. GitHub repository detection is local; PR lookup requires a recognizable public GitHub remote plus a working, authenticated `gh` command. It checks the selected remote repository, not outbound PRs from a fork to an upstream repository. Failures are reported as unavailable rather than as clean or no-PR states.

## Project guides

- [Mission](docs/mission.md)
- [Design](docs/design.md)
- [Architecture](docs/architecture.md)
- [Contributing](CONTRIBUTING.md)
