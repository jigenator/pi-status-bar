# Engineering conventions

## Project profile

Pi Status Bar is a TypeScript ESM Pi package for Node.js 22.19+. Runtime code is `src/extension.ts`, `src/footer.ts`, and `src/workspace.ts`; Pi supplies the host, TUI, and TypeBox peers declared in `package.json`. Tests use Node's built-in runner and TypeScript stripping.

Scope reviewed: baseline revision `60d738faa2b2264005717e599c4a917f69c59419`, the complete integrated source/test tree, `package.json`, and installed Pi 1.0.2 package/extension/TUI APIs and pi-subagents 0.76.0 public activity contract (native v9 integration on 2026-10-05). The installed host was read-only. This is a focused review of the complete current repository, not a claim about other Pi versions or platforms.

### Baseline discovery and conversion

The baseline commit contained only Git metadata: no source, manifest, CI, README, agent instructions, architecture, conventions, design, decisions, or test configuration. Requirements came from the approved implementation handoff; the integrated component files are the evidence for current behavior.

| Discovery | Classification | Canonical result |
| --- | --- | --- |
| Empty baseline repository at `60d738f` | Needs creation, not legacy conversion | Create the canonical root/docs set; no superseded files or stale links to remove |
| Approved behavior and frozen workspace contract | Needs documentation conversion | Product scope in `docs/mission.md`/`docs/design.md`; contracts and flows here and in `docs/architecture.md`; rationale in one decision record |
| `src/workspace.ts` and `test/workspace.test.ts` | Already conforms to the frozen domain seam; documentation was missing | Module, validation, failure, I/O, and test rules below |
| `src/footer.ts`, `src/extension.ts`, and their tests | Already implements the presentation/lifecycle seams; documentation was missing | Dependency/placement rules below and architecture flows |
| `package.json` and real installed Pi test prerequisite | New project wiring | Exact commands and effects in `CONTRIBUTING.md`; peer boundary in architecture |

Conversion map: there were no existing documents to move, merge, alias, or remove. Conversation requirements were canonicalized rather than copied as a parallel rulebook. `AGENTS.md` maps every created supporting guide, and `CLAUDE.md` contains only its exact import.

## Engineering principles

- **Progressive disclosure.** Rule: keep critical safety boundaries and a complete task-routed document map in `AGENTS.md`; put details in the relevant canonical guide. Example: a PR-lookup fix follows `AGENTS.md` to `src/workspace.ts`, the architecture contract, and the test command without requiring design prose. Reason: tasks should discover all applicable constraints without loading unrelated manuals. Check: review the code-change and human-facing routes plus every row in the supporting-documents map.
- **YAGNI.** Rule: add only capabilities required by current footer behavior; document limitations with a concrete revisit condition instead of adding hooks. Example: `src/workspace.ts` directly supports public GitHub remotes and does not add an enterprise-host provider registry. Reason: hypothetical variants add contracts and failure modes without a user need. Check: name the current requirement for every dependency, abstraction, option, or background process.
- **KISS.** Rule: prefer Node/Pi public APIs and plain functions over new frameworks. Example: `renderFooter` is a pure function and subprocesses use `execFile`; there is no DI container or rendering model hierarchy. Reason: direct control flow keeps safety and lifecycle behavior inspectable. Check: compare a proposal with the existing module/function seam and justify why it is insufficient.
- **Single source of truth.** Rule: keep workspace semantics in `src/workspace.ts`, rendering in `src/footer.ts`, lifecycle in `src/extension.ts`, and exact commands in `CONTRIBUTING.md`; link rather than duplicate. Example: renderer imports workspace types but does not re-detect Git. Reason: one semantic change should have one implementation and one canonical rule. Check: trace a behavior change through imports/callers and reject parallel parsers, caches, or command recipes.

## Module and dependency rules

**Rule:** dependency direction is `src/extension.ts -> src/workspace.ts` and `src/extension.ts -> src/footer.ts`; `src/footer.ts` may import workspace types only, and `src/workspace.ts` must not import Pi UI/session modules. **Example:** `renderFooter` receives a `FooterSnapshot`, while `inspectWorkspace` returns a discriminated `WorkspaceInfo`. **Reason:** local/GitHub semantics remain testable without Pi and rendering remains free of I/O. **Check:** inspect imports and run all three matching test files.

**Rule:** use the exported workspace types/functions as the public internal contract; keep subprocess parsing and renderer helpers private unless a real second caller needs them. **Example:** `resolveActivePath`, `inspectWorkspace`, and `inspectPullRequest` are the only runtime exports from `src/workspace.ts`. **Reason:** broad exports couple callers to parsing details. **Check:** review exports and contract-focused workspace tests.

Cycles are forbidden. Do not create a `shared`, `utils`, `helpers`, or `manager` module to conceal one; move behavior to the capability that owns its semantics.

## Placement and naming

**Rule:** capability files live directly under `src/` and have matching tests under `test/`: `workspace`, `footer`, and `extension`. **Reason:** this small package's real boundaries are clearer than additional nesting. **Check:** a new file must represent a cohesive new capability that cannot fit an existing owner.

Use descriptive lower-case filenames and named exports for reusable domain/render functions; the Pi runtime entry remains the default export from `src/extension.ts`. Place disposable fixtures inside tests and the OS temp directory. No migrations or generated source exist. `node_modules/` is ignored and must not be committed.

## Functions, APIs, and abstractions

**Rule:** use explicit inputs/results and make side effects visible. **Example:** `inspectWorkspace(path, { signal })` performs bounded reads and returns a complete state union; `renderFooter(snapshot, width, theme, frame)` performs no I/O and receives decoration time as a frame instead of reading a clock. **Reason:** callers can distinguish failure and control cancellation. **Check:** tests exercise success, failure, cancellation, and stale completion.

**Rule:** extract behavior only when semantics are genuinely shared. **Example:** terminal sanitization is centralized in `safeText`; active and main checkout formatting reuse the private `checkout` helper. Do not merge local Git and GitHub PR caches merely because both refresh. **Reason:** similar timing does not mean identical invalidation or failure rules. **Check:** identify callers and invariants before extraction; no speculative factory/interface/base class.

Public compatibility currently consists of the package entry, tool name/schema/details, the `/footer-motion` command, and workspace exports used by the extension/tests. Change these deliberately with updated integration coverage and, when consequential, a decision record.

## Types and validation

**Rule:** represent absence, unknown/unavailable, and success as discriminated unions; nullable checkout fields keep their documented meaning. **Example:** `dirty: null` means unavailable and can never mean clean; PR `none` is distinct from `unavailable`. **Reason:** static types and UI text must prevent false reassurance. **Check:** workspace and footer tests assert every state.

**Rule:** validate untrusted data at runtime even when typed. Optional fleet RPC must validate protocol, request identity, same-session capability, fleet version and safe nonnegative counts; failure is null/Unknown, never zero. Counts come from the authoritative total, not the bounded entries window. **Example:** GitHub remote URLs and `gh` JSON fields are checked for repository identity, branch, number, state, URL, ambiguity, truncation, and control characters. Tool paths must be non-empty existing directories and are canonicalized. **Reason:** subprocess and tool inputs cross runtime boundaries. **Check:** malformed/spoofed/hostile fixtures in all three test files.

**Rule:** Ponytail status integration consumes only verified, bounded text from key `ponytail`; all other keys and unrecognized Ponytail warnings remain visible. OFF requires an observed explicit clear, never map absence. The narrow public `setStatus` observer must forward original behavior, detach reversibly without overwriting foreign wrappers, and not stack across footer replacements. **Check:** matching real-host status/lifecycle tests in `test/extension.test.ts`; activation and version assumptions in [architecture](architecture.md#ponytail-status-integration).

Use TypeBox only at the Pi tool schema boundary. Do not serialize hidden credentials or raw command stderr into results.

## Errors and diagnostics

**Rule:** translate expected external failures into truthful result states at the domain boundary, preserving safe context but redacting raw stderr. **Example:** missing `gh`, auth, rate limit, network, timeout, and malformed responses become `PullRequestInfo.unavailable` reasons. **Reason:** the footer must remain operational without leaking credential-bearing URLs or pretending failure is absence. **Check:** `test/workspace.test.ts` asserts categories and secret non-disclosure.

Invalid `set_active_project` calls throw and preserve the previous selection. Unexpected inspection exceptions are converted by the extension to unknown/unavailable snapshots. Do not log the same error at every layer or swallow it into an empty success result.

## State, I/O, and migrations

**Rule:** subprocess I/O belongs only in `src/workspace.ts` and uses `execFile` with explicit argv/cwd, sanitized environment, output limits, timeouts, and cancellation. Local Git is read-only with optional locks/lazy fetch disabled. `gh api` is an explicit read-only GET. **Check:** command-argument/environment tests and real disposable Git fixtures.

**Rule:** session state belongs in the `SessionState` owned by `src/extension.ts`. Selection changes cancel prior local/PR work; every async completion verifies session/controller/path/key ownership. Timers, controllers, public RPC reply/ready listeners and in-flight ownership are disposed on shutdown/footer disposal. A reply listener and bounded timeout must exist before emit; Pi event-bus emission does not await async handler completion. **Check:** stale-selection, disposal, and polling tests.

Successful selection details are stored in the Pi session branch and restored on tree/reload/resume/fork. There is no database, transaction, cross-session storage, schema migration, retry loop, or write-side idempotency requirement. If the versioned selection detail shape changes, support only a concrete compatibility need and test migration/recovery before changing `version: 1`.

## Tests

Use the lowest layer that owns the behavior:

- `test/workspace.test.ts`: domain/contract tests with real disposable Git and deterministic fake executables.
- `test/footer.test.ts`: pure renderer states, snapshots, palette, width, motion frames/schedule, and sanitization.
- `test/extension.test.ts`: real installed Pi package loading, tool/lifecycle/session persistence, refresh/cache, cancellation, and disposal.

**Rule:** no test may depend on a live GitHub account/network, user Git identity, hooks, signing, or ambient Git routing. **Reason:** tests must be deterministic and non-destructive. **Check:** fixture setup isolates config and replaces `gh`.

See `CONTRIBUTING.md` for the only canonical commands and prerequisites. A skipped integrated boundary or missing host does not establish a full pass.

## Dependencies and generated output

**Rule:** use Node standard library first and host-provided Pi packages only where the host boundary requires them. Declare Pi/TUI/TypeBox as `"*"` peers, never runtime dependencies, to avoid duplicate host classes/registries. **Check:** `package.json` plus Pi's package-loader warnings and real load test.

A new dependency requires a current need, comparison with stdlib/host APIs, maintenance/security review, and deterministic tests. No lockfile is generated because there is nothing to install. There is no build artifact or generated file to edit.

## Performance and growth

Current bounded behavior: one unref'd decoration timeout, renderer-selected next wake with 50 ms transient granularity, none when `/footer-motion off`; independent fleet collection normally five seconds after completion, coalesced event refreshes with a one-second minimum start-to-start interval, one local RPC outstanding and a two-second timeout per request. The owner may use artifact-backed fallback status; client timeout cannot cancel that work. Root state is read from `isIdle()`, not inferred from event names or child count. Local status refreshes after tool completion and every 15 seconds in TUI mode; PR results cache for 60 seconds by repository URL/name and branch. Git commands time out after 4 seconds, `gh` after 10 seconds, and subprocess output is capped at 1 MiB. Rendering and decoration wakes perform no collection I/O and line output is width-bounded. Baseline pre-v9 render timings and settled repaint rates do not establish v9 performance; no new render-cost/full-host measurement is claimed.

No production workload or measured bottleneck exists. Treat suspected redraw, process-count, or large-repository cost as a measurement task before adding watchers, workers, services, persistence, or another cache. Revisit intervals only with observed latency/load data and lifecycle tests.

## Adoption gaps

| Gap | Priority / evidence | Next change | Verification |
| --- | --- | --- | --- |
| No standalone static typecheck, formatter, linter, build, or CI gate | Medium; current checks are runtime tests and syntax stripping | Evaluate the smallest tool only when maintainers approve dependency/tooling expansion | Proposed check—not implemented; do not claim these gates today |
| No manual live interactive-terminal/motion review | Medium for presentation; automated palette, width and motion checks pass | Exercise the unpackaged local extension at representative widths and color modes without changing user settings | Manual check—not run |
| No live fleet-owner smoke test | Medium; real Pi loader/event bus with deterministic offline replies is covered | Opt-in read-only observation with a separately authorized live owner; do not launch agents just to test | Manual check—not run |
| No live authenticated GitHub validation | Low for deterministic correctness; API boundary is mocked and validated | Run a read-only opt-in smoke against a controlled public repository if explicitly authorized | Opt-in check—not implemented; normal suite remains offline |
| Agent can forget to update Active | Product limitation inherent in explicit signaling | Collect evidence before changing the decision; do not infer from incidental reads | Revisit condition in the decision record |
| Windows execution is untested | Unknown relevance; implementation uses platform APIs but POSIX fixtures | Add platform CI only when Windows support is required | Proposed check—not implemented |
