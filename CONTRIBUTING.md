# Contributing

## Toolchain and setup

Use Node.js 22.19 or newer; the integrated baseline was checked with Node 22.23.0, Pi 1.0.2, Git 2.50.1, and `gh` 2.93.0 on macOS. USG parsing was built against recorded CodexBar 0.60.3 output; no installed `codexbar` is needed or used by tests. The extension has no runtime dependency to install: Pi supplies the three peer packages declared in `package.json`.

Tests that exercise Pi need the installed host root. From the repository root:

```sh
export PI_HOST_ROOT="$(npm root -g)/@earendil-works/pi-coding-agent"
test -f "$PI_HOST_ROOT/dist/index.js"
```

This only discovers an existing global installation. Do not run an installer to make a test silently pass. Workspace fixtures create disposable repositories under the operating-system temp directory, isolate Git identity/configuration, and use a fake `gh` and a fake `codexbar`; they do not use a live GitHub account, CodexBar, provider account or network. The fakes are POSIX `sh` scripts that need `/bin/sh`, `/bin/sleep`, `/bin/cat` and `/usr/bin/grep`.

## Fast loop

For local Git/GitHub domain changes:

```sh
node --experimental-strip-types --test test/workspace.test.ts
```

For CodexBar usage parsing or invocation changes:

```sh
node --experimental-strip-types --test test/usage.test.ts
```

For renderer changes after setting `PI_HOST_ROOT`:

```sh
PI_HOST_ROOT="$PI_HOST_ROOT" node --experimental-strip-types --test test/footer*.test.ts
```

`test/footer.test.ts` alone runs only its first shard; the glob runs every shard in parallel processes.

These focused commands do not cover extension lifecycle, package loading, session restoration, or every other module.

## Full validation sequence

Source: `package.json` and the test files under `test/`.

| Order | Directory | Command | Prerequisites/effects | Coverage |
| --- | --- | --- | --- | --- |
| 1 | repository root | `export PI_HOST_ROOT="$(npm root -g)/@earendil-works/pi-coding-agent"` | Existing global Pi; reads npm's global root | Locates host-provided peers |
| 2 | repository root | `test -f "$PI_HOST_ROOT/dist/index.js"` | No writes | Fails clearly when the host prerequisite is absent |
| 3 | repository root | `PI_HOST_ROOT="$PI_HOST_ROOT" npm test` | Creates/removes temp Git/session fixtures; fake `gh` and `codexbar`; no live network | All workspace, usage, renderer, package-loader, lifecycle, refresh, and persistence tests |

Record every check as passed, failed, skipped, or not run. A missing host is a failed prerequisite, not a passing or skipped integrated suite. There is currently no established formatter, linter, standalone typecheck, or build command; do not claim one ran.

## Making a change

1. Trace the current flow in [the architecture guide](docs/architecture.md).
2. Put Git/path/GitHub semantics in `src/workspace.ts`, CodexBar invocation and usage-window parsing in `src/usage.ts`, pure display semantics in `src/footer.ts`, and Pi lifecycle/state orchestration in `src/extension.ts`.
3. Add the lowest-layer regression test that reproduces the issue. Add `test/extension.test.ts` coverage when a change crosses the real Pi loader or session boundary.
4. Run the focused test while iterating and the full sequence before handoff.

Preserve the public workspace result unions and truthful failure states. Never turn a timeout, malformed response, missing executable, or cancellation into “clean” or “no open PR.”

## Refactoring

Keep structural and semantic changes separate when practical. Preserve behavior with tests before moving code, migrate callers through the existing exported seam, and remove obsolete paths rather than maintaining aliases. Do not create a provider registry, background service, or generic utility module without a current requirement that the existing module split cannot satisfy.

## Review checks

- Dependency direction remains `extension -> workspace`, `extension -> usage` and `extension -> footer`; `footer` imports workspace and usage types only, while `workspace` and `usage` have no Pi UI dependency.
- Untrusted paths, Git names, remote data, and extension statuses remain terminal-safe and width-bounded.
- Read-only subprocesses use explicit argv/cwd, bounded output/time, and no credential-bearing diagnostics.
- Session timers and in-flight work are disposed; stale asynchronous results cannot overwrite a newer session or selection.
- New behavior has deterministic coverage and no live GitHub or CodexBar dependency.
- YAGNI: every abstraction/dependency serves a current requirement. KISS: compare it with a direct function or existing host API. Single source of truth: shared semantics stay in one module and commands stay here. Progressive disclosure: update the relevant guide and `AGENTS.md` map without making unrelated docs mandatory.

## Keeping docs accurate

Update `docs/conventions.md` when an engineering rule changes, `docs/architecture.md` when modules/contracts or flows change, this file when commands/prerequisites change, and `docs/design.md` when the footer experience changes. Add a decision record only for a consequential trade-off, and add every supporting guide to the `AGENTS.md` map.
