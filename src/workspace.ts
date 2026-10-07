import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

export type CheckoutInfo = {
  path: string;
  branch: string | null; // null only for confirmed detached HEAD
  revision: string | null;
  dirty: boolean | null;
  error?: string;
};
export type GithubRepository = { kind: 'repository'; name: string; url: string };
export type WorkspaceInfo = {
  path: string;
  git:
    | { kind: 'none' }
    | { kind: 'unknown'; reason: string }
    | { kind: 'repository'; active: CheckoutInfo; main: CheckoutInfo | null; isWorktree: boolean; mainUnavailableReason?: string };
  github:
    | GithubRepository
    | { kind: 'none'; reason: string }
    | { kind: 'unknown'; reason: string };
};
export type PullRequestInfo =
  | { kind: 'open'; number: number; url: string }
  | { kind: 'none' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'not-applicable' };

type CommandResult = { ok: boolean; stdout: string; stderr: string; code?: number; reason?: string };
// The optional deadline applies to each command, not the whole inspection.
type Options = { signal?: AbortSignal; timeoutMs?: number };

// Inherited Git routing variables must not override the explicitly selected cwd.
// Optional locks also prevent status from refreshing/writing the index.
function commandEnv(git: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: 'C', LANG: 'C', NO_COLOR: '1' };
  if (git) {
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_CEILING_DIRECTORIES', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) {
      delete env[key];
    }
    env.GIT_OPTIONAL_LOCKS = '0';
    env.GIT_TERMINAL_PROMPT = '0';
    env.GIT_NO_LAZY_FETCH = '1';
  } else {
    env.GH_PROMPT_DISABLED = '1';
    env.GH_PAGER = 'cat';
    // gh api always receives an explicit hostname and endpoint; no cwd inference.
    delete env.GH_DEBUG;
  }
  return env;
}

function command(file: 'git' | 'gh', args: string[], cwd: string | undefined, options: Options = {}): Promise<CommandResult> {
  if (options.signal?.aborted) return Promise.resolve({ ok: false, stdout: '', stderr: '', reason: `${file} lookup cancelled` });
  const { signal } = options;
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      resolve(result);
    };
    const child = execFile(file, args, {
      cwd, env: commandEnv(file === 'git'), encoding: 'utf8',
      timeout: options.timeoutMs ?? (file === 'git' ? 4000 : 10000), killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (!error) return done({ ok: true, stdout, stderr });
      const code = 'code' in error ? error.code : undefined;
      const reason = code === 'ENOENT' ? `${file} is not installed or executable`
        : code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? `${file} output exceeded the safety limit`
        : error.killed ? `${file} lookup timed out`
        : `${file} command failed${typeof code === 'number' ? ` (exit ${code})` : ''}`;
      // Never return raw command stderr: it may contain credential-bearing URLs.
      done({ ok: false, stdout, stderr, code: typeof code === 'number' ? code : undefined, reason });
    });
    // Not execFile's `signal`: aborting a spawn that failed with ENOENT before Node reports it
    // signals pid 0, the caller's whole process group (Node 22.23). Kill only a started child.
    function abort() {
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      done({ ok: false, stdout: '', stderr: '', reason: `${file} lookup cancelled` });
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function line(output: string): string {
  return output.endsWith('\n') ? output.slice(0, -1) : output;
}

function notRepository(result: CommandResult): boolean {
  return result.code === 128 && /not a git repository/i.test(result.stderr);
}

function noWorkingCheckout(result: CommandResult): boolean {
  return result.code === 128 && /must be run in a work tree/i.test(result.stderr);
}

async function directory(path: string): Promise<string> {
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isDirectory()) throw new Error('Active path must be an existing directory');
  return canonical;
}

export async function resolveActivePath(input: string, launchPath: string, options: Options = {}): Promise<string> {
  if (typeof input !== 'string' || input.length === 0 || input.includes('\0')) {
    throw new Error('Active path must be a non-empty directory path');
  }
  const path = await directory(resolve(launchPath, input));
  const root = await command('git', ['rev-parse', '--show-toplevel'], path, options);
  if (root.ok) return directory(line(root.stdout));
  if (notRepository(root) || noWorkingCheckout(root) || root.reason === 'git is not installed or executable') return path;
  throw new Error(root.reason ?? 'Cannot resolve Git checkout root');
}

async function checkout(path: string, options: Options): Promise<CheckoutInfo | { unavailable: string }> {
  const [branchResult, revisionResult, statusResult] = await Promise.all([
    command('git', ['symbolic-ref', '--quiet', 'HEAD'], path, options),
    command('git', ['rev-parse', '--verify', '--short', 'HEAD'], path, options),
    command('git', ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=none'], path, options),
  ]);
  // symbolic-ref exit 1 confirms detached HEAD; other failures tell us nothing
  // about the branch and must not disable PR discovery as "not applicable".
  if (!branchResult.ok && branchResult.code !== 1) {
    return { unavailable: `Git branch unavailable: ${branchResult.reason}` };
  }
  const errors: string[] = [];
  const branch = branchResult.ok ? line(branchResult.stdout).replace(/^refs\/heads\//, '') : null;
  let revision: string | null = null;
  if (revisionResult.ok && /^[0-9a-f]{4,64}\n?$/.test(revisionResult.stdout)) {
    revision = line(revisionResult.stdout);
  } else {
    // A missing HEAD is expected only for an unborn symbolic branch.
    const ref = branch === null ? null : await command('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], path, options);
    if (ref?.code !== 1) errors.push(revisionResult.reason ?? 'Invalid Git revision output');
  }
  if (!statusResult.ok) errors.push(statusResult.reason!);
  return {
    path, branch, revision,
    dirty: errors.length ? null : statusResult.stdout.length > 0,
    ...(errors.length ? { error: [...new Set(errors)].join('; ') } : {}),
  };
}

function githubName(name: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]+$/.test(name)
    && !['.', '..'].includes(name.split('/')[1]);
}

type Remote = { kind: 'github'; name: string } | { kind: 'other' } | { kind: 'invalid' };
function parseRemote(value: string): Remote {
  let host: string;
  let path: string;
  try {
    const scp = /^(?:[^/@:]+@)?([^/:]+):(?!\/\/)(.*)$/.exec(value);
    if (scp) {
      host = scp[1].toLowerCase();
      path = scp[2];
    } else {
      const url = new URL(value);
      host = url.hostname.toLowerCase();
      if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) {
        return host === 'github.com' || host === 'ssh.github.com' ? { kind: 'invalid' } : { kind: 'other' };
      }
      if (url.search || url.hash) return host === 'github.com' ? { kind: 'invalid' } : { kind: 'other' };
      path = url.pathname.replace(/^\//, '');
    }
  } catch {
    return /(?:^|[@/])(?:ssh\.)?github\.com(?=[:/]|$)/i.test(value) ? { kind: 'invalid' } : { kind: 'other' };
  }
  if (host !== 'github.com' && host !== 'ssh.github.com') return { kind: 'other' };
  const name = path.replace(/\/$/, '').replace(/\.git$/, '');
  return githubName(name) && !/[\x00-\x20\x7f]/.test(value) ? { kind: 'github', name } : { kind: 'invalid' };
}

async function github(path: string, options: Options): Promise<WorkspaceInfo['github']> {
  const config = await command('git', ['config', '--null', '--get-regexp', '^remote\\..*\\.url$'], path, options);
  if (!config.ok && config.code !== 1) return { kind: 'unknown', reason: config.reason! };
  if (!config.stdout) return { kind: 'none', reason: 'No GitHub remote' };
  const names = new Set<string>();
  for (const entry of config.stdout.split('\0').filter(Boolean)) {
    const separator = entry.indexOf('\n');
    const key = entry.slice(0, separator);
    const match = /^remote\.(.*)\.url$/.exec(key);
    if (separator < 0 || !match || /[\r\n]/.test(entry.slice(separator + 1))) {
      return { kind: 'unknown', reason: 'Malformed remote configuration' };
    }
    names.add(match[1]);
  }
  const remotes: { remote: string; values: Remote[] }[] = [];
  for (const remote of names) {
    const result = await command('git', ['remote', 'get-url', '--all', '--', remote], path, options);
    if (!result.ok) return { kind: 'unknown', reason: result.reason! };
    remotes.push({ remote, values: line(result.stdout).split('\n').map(parseRemote) });
  }
  const origin = remotes.find((remote) => remote.remote === 'origin');
  const candidates = origin?.values.some((value) => value.kind !== 'other') ? [origin] : remotes;
  if (candidates.some(({ values }) => values.some((value) => value.kind === 'invalid'))) {
    return { kind: 'unknown', reason: 'Malformed GitHub remote' };
  }
  if (candidates.some(({ values }) => values.some((value) => value.kind === 'github') && values.some((value) => value.kind === 'other'))) {
    return { kind: 'unknown', reason: 'Ambiguous remote URLs' };
  }
  const repositories = new Map<string, string>();
  for (const { values } of candidates) {
    for (const value of values) if (value.kind === 'github') repositories.set(value.name.toLowerCase(), value.name);
  }
  if (repositories.size === 0) return { kind: 'none', reason: 'No GitHub remote' };
  if (repositories.size > 1) return { kind: 'unknown', reason: 'Ambiguous GitHub remotes' };
  const name = [...repositories.values()][0];
  return { kind: 'repository', name, url: `https://github.com/${name}` };
}

export async function inspectWorkspace(input: string, options: Options = {}): Promise<WorkspaceInfo> {
  let path: string;
  try { path = await directory(input); }
  catch { return { path: input, git: { kind: 'unknown', reason: 'Workspace directory is unavailable' }, github: { kind: 'unknown', reason: 'Workspace directory is unavailable' } }; }
  const root = await command('git', ['rev-parse', '--show-toplevel'], path, options);
  if (!root.ok) {
    if (notRepository(root)) return { path, git: { kind: 'none' }, github: { kind: 'none', reason: 'Not a Git repository' } };
    const reason = noWorkingCheckout(root) ? 'Git repository has no working checkout' : root.reason!;
    return { path, git: { kind: 'unknown', reason }, github: { kind: 'unknown', reason } };
  }
  try { path = await directory(line(root.stdout)); }
  catch { return { path, git: { kind: 'unknown', reason: 'Git checkout root is unavailable' }, github: { kind: 'unknown', reason: 'Git checkout root is unavailable' } }; }
  const [active, repository, common, gitDir, worktrees] = await Promise.all([
    checkout(path, options), github(path, options),
    command('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], path, options),
    command('git', ['rev-parse', '--absolute-git-dir'], path, options),
    command('git', ['worktree', 'list', '--porcelain', '-z'], path, options),
  ]);
  if ('unavailable' in active) {
    return { path, git: { kind: 'unknown', reason: active.unavailable }, github: repository };
  }
  let main: CheckoutInfo | null = null;
  let mainUnavailableReason: string | undefined;
  // Failure to identify worktree metadata must not masquerade as an ordinary checkout.
  if (!common.ok || !gitDir.ok) {
    return { path, git: { kind: 'unknown', reason: common.reason ?? gitDir.reason! }, github: repository };
  }
  let commonPath: string;
  let isWorktree: boolean;
  try {
    commonPath = await realpath(line(common.stdout));
    isWorktree = commonPath !== await realpath(line(gitDir.stdout));
  } catch {
    return { path, git: { kind: 'unknown', reason: 'Git metadata is unavailable' }, github: repository };
  }
  if (!worktrees.ok) mainUnavailableReason = worktrees.reason;
  else {
    // Git documents the first porcelain record as the main worktree, regardless
    // of its branch name. NUL framing preserves spaces, Unicode and newlines.
    const fields = worktrees.stdout.split('\0\0')[0].split('\0');
    const first = fields[0];
    if (!first?.startsWith('worktree ')) mainUnavailableReason = 'Invalid Git worktree output';
    else if (fields.includes('bare')) mainUnavailableReason = 'Main repository is bare (no checkout)';
    else {
      try {
        const mainPath = await directory(first.slice('worktree '.length));
        if (mainPath !== path) {
          const mainCommon = await command('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], mainPath, options);
          if (!mainCommon.ok || await realpath(line(mainCommon.stdout)) !== commonPath) {
            mainUnavailableReason = 'Main checkout no longer belongs to this repository';
          } else {
            const inspected = await checkout(mainPath, options);
            if ('unavailable' in inspected) mainUnavailableReason = inspected.unavailable;
            else main = inspected;
          }
        }
      } catch { mainUnavailableReason = 'Main checkout directory is unavailable'; }
    }
  }
  return { path, git: { kind: 'repository', active, main, isWorktree, ...(mainUnavailableReason ? { mainUnavailableReason } : {}) }, github: repository };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function inspectPullRequest(repository: GithubRepository, branch: string | null, options: Options = {}): Promise<PullRequestInfo> {
  if (branch === null) return { kind: 'not-applicable' };
  const canonicalUrl = `https://github.com/${repository.name}`;
  if (!githubName(repository.name) || repository.url !== canonicalUrl || !branch || /[\x00-\x20\x7f]/.test(branch)) {
    return { kind: 'unavailable', reason: 'Invalid GitHub repository or branch' };
  }
  // REST head=owner:branch narrows the request. Validate full head repository
  // too: a same-named branch in a different fork must never be attributed here.
  // Explicit GET/raw fields avoid gh's POST inference and @file interpolation.
  const owner = repository.name.split('/')[0];
  const result = await command('gh', [
    'api', '--hostname', 'github.com', '--method', 'GET',
    `repos/${repository.name}/pulls`,
    '--raw-field', 'state=open', '--raw-field', `head=${owner}:${branch}`,
    '--raw-field', 'per_page=100',
  ], undefined, options);
  if (!result.ok) {
    const reason = result.code === 4 || /(?:HTTP 401|authentication|not logged|gh auth login)/i.test(result.stderr) ? 'GitHub authentication unavailable'
      : /rate limit/i.test(result.stderr) ? 'GitHub rate limit reached'
      : /HTTP 422/i.test(result.stderr) ? 'GitHub request validation failed'
      : /(?:HTTP 403|HTTP 404|forbidden)/i.test(result.stderr) ? 'GitHub repository access unavailable'
      : /(?:dial tcp|network|no such host|connection|TLS handshake)/i.test(result.stderr) ? 'GitHub network unavailable'
      : result.reason!;
    return { kind: 'unavailable', reason };
  }
  let data: unknown;
  try { data = JSON.parse(result.stdout); }
  catch { return { kind: 'unavailable', reason: 'Invalid GitHub response' }; }
  if (!Array.isArray(data) || data.length >= 100) return { kind: 'unavailable', reason: 'Invalid or truncated GitHub response' };
  const matches: { number: number; url: string }[] = [];
  for (const item of data) {
    if (!object(item) || !Number.isSafeInteger(item.number) || (item.number as number) <= 0
      || item.state !== 'open' || !object(item.head) || !object(item.head.repo)
      || typeof item.head.repo.full_name !== 'string' || !githubName(item.head.repo.full_name)
      || typeof item.head.ref !== 'string' || !item.head.ref || /[\x00-\x20\x7f]/.test(item.head.ref)
      || !object(item.base) || !object(item.base.repo)
      || typeof item.base.repo.full_name !== 'string' || item.base.repo.full_name.toLowerCase() !== repository.name.toLowerCase()
      || typeof item.html_url !== 'string'
      || item.html_url.toLowerCase() !== `${canonicalUrl}/pull/${item.number}`.toLowerCase()) {
      return { kind: 'unavailable', reason: 'Invalid GitHub pull request data' };
    }
    if (item.head.ref === branch && item.head.repo.full_name.toLowerCase() === repository.name.toLowerCase()) {
      matches.push({ number: item.number as number, url: item.html_url });
    }
  }
  if (matches.length > 1) return { kind: 'unavailable', reason: 'Ambiguous open pull requests' };
  return matches.length === 1 ? { kind: 'open', ...matches[0] } : { kind: 'none' };
}
