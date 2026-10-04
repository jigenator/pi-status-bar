import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { inspectPullRequest, inspectWorkspace, resolveActivePath } from '../src/workspace.ts';
import type { GithubRepository, WorkspaceInfo } from '../src/workspace.ts';

const originalPath = process.env.PATH ?? '';
const repository: GithubRepository = { kind: 'repository', name: 'Owner/project', url: 'https://github.com/Owner/project' };
type Fixture = { root: string; git: (cwd: string, ...args: string[]) => string };

async function withEnv<T>(env: NodeJS.ProcessEnv, run: () => Promise<T>): Promise<T> {
  const previous = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  try { return await run(); }
  finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previous);
  }
}

async function fixture(run: (f: Fixture) => Promise<void>): Promise<void> {
  // Canonicalize macOS /var -> /private/var before comparing returned roots.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-workspace-')));
  const home = join(root, 'home');
  await mkdir(home);
  const env: NodeJS.ProcessEnv = {
    ...process.env, PATH: originalPath, HOME: home, XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'no-global-config'),
    GIT_AUTHOR_NAME: 'Workspace Test', GIT_AUTHOR_EMAIL: 'workspace-test@example.invalid',
    GIT_COMMITTER_NAME: 'Workspace Test', GIT_COMMITTER_EMAIL: 'workspace-test@example.invalid',
    GIT_CONFIG_COUNT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', LANG: 'C',
  };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG_PARAMETERS']) delete env[key];
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\n$/, '');
  try { await withEnv(env, () => run({ root, git })); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function repo(f: Fixture, name = 'repo', born = true): Promise<string> {
  const path = join(f.root, name);
  await mkdir(path);
  f.git(path, 'init', '--initial-branch=trunk');
  // Commit attribution is isolated to disposable test repositories only.
  f.git(path, 'config', 'user.name', 'Workspace Test');
  f.git(path, 'config', 'user.email', 'workspace-test@example.invalid');
  assert.equal(f.git(path, 'config', 'user.name'), 'Workspace Test');
  assert.equal(f.git(path, 'config', 'user.email'), 'workspace-test@example.invalid');
  if (born) {
    await writeFile(join(path, 'tracked.txt'), 'hello\n');
    f.git(path, 'add', '--', 'tracked.txt');
    f.git(path, 'commit', '-m', 'fixture');
  }
  return path;
}

function gitInfo(info: WorkspaceInfo): Extract<WorkspaceInfo['git'], { kind: 'repository' }> {
  assert.equal(info.git.kind, 'repository');
  if (info.git.kind !== 'repository') throw new Error('Expected repository');
  return info.git;
}

// PATH stubs are disposable, deterministic executables; no live gh is invoked.
async function mock(f: Fixture, file: 'git' | 'gh', body: string, run: (log: string) => Promise<void>): Promise<void> {
  const bin = join(f.root, `bin-${file}`);
  await mkdir(bin, { recursive: true });
  const log = join(bin, 'calls.jsonl');
  await rm(log, { force: true });
  const executable = join(bin, file);
  await writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs'); const args=process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,cwd:process.cwd(),optionalLocks:process.env.GIT_OPTIONAL_LOCKS,noLazyFetch:process.env.GIT_NO_LAZY_FETCH,promptDisabled:process.env.GH_PROMPT_DISABLED})+'\\n');\n${body}\n`);
  await chmod(executable, 0o755);
  await withEnv({ ...process.env, PATH: `${bin}${delimiter}${originalPath}` }, () => run(log));
}
const realGitFallback = `const c=require('node:child_process').spawnSync('git',args,{cwd:process.cwd(),env:{...process.env,PATH:${JSON.stringify(originalPath)}},encoding:'utf8'}); process.stdout.write(c.stdout||''); process.stderr.write(c.stderr||''); process.exitCode=c.status;`;
const response = (data: unknown) => `process.stdout.write(${JSON.stringify(JSON.stringify(data))});`;
function pr(number = 7, headRepository = repository.name, branch = 'feature/safe'): Record<string, unknown> {
  return { number, state: 'open', html_url: `${repository.url}/pull/${number}`, head: { ref: branch, repo: { full_name: headRepository } }, base: { repo: { full_name: repository.name } } };
}

test('active path validates directories, canonicalizes symlinks and resolves relative checkout roots', async () => fixture(async (f) => {
  const path = await repo(f, 'checkout with spaces 日本語');
  const nested = join(path, 'nested');
  await mkdir(nested);
  assert.equal(await resolveActivePath('nested', path), path);
  const alias = join(f.root, 'alias');
  await symlink(nested, alias);
  assert.equal(await resolveActivePath(alias, f.root), path);
  const plain = join(f.root, 'plain');
  await mkdir(plain);
  assert.equal(await resolveActivePath('plain', f.root), plain);
  for (const input of ['', 'missing', join(path, 'tracked.txt'), 'bad\0path']) await assert.rejects(resolveActivePath(input, f.root));
  assert.equal(process.cwd().includes(f.root), false);
}));

test('plain and unavailable directories remain distinct from unknown Git', async () => fixture(async (f) => {
  assert.equal((await inspectWorkspace(f.root)).git.kind, 'none');
  assert.equal((await inspectWorkspace(f.root)).github.kind, 'none');
  const missing = await inspectWorkspace(join(f.root, 'missing'));
  assert.equal(missing.git.kind, 'unknown');
  assert.equal(missing.github.kind, 'unknown');
}));

test('read-only local status handles clean, untracked, staged, unstaged, ignored and no GitHub', async () => fixture(async (f) => {
  const path = await repo(f);
  const index = await readFile(join(path, '.git', 'index'));
  const clean = await inspectWorkspace(path);
  const info = gitInfo(clean);
  assert.equal(info.active.branch, 'trunk');
  assert.match(info.active.revision!, /^[a-f0-9]+$/);
  assert.equal(info.active.dirty, false);
  assert.equal(info.main, null);
  assert.equal(info.isWorktree, false);
  assert.equal(clean.github.kind, 'none');
  assert.deepEqual(await readFile(join(path, '.git', 'index')), index, 'index must not be refreshed');
  await writeFile(join(path, 'untracked'), 'x');
  assert.equal(gitInfo(await inspectWorkspace(path)).active.dirty, true);
  await rm(join(path, 'untracked'));
  await writeFile(join(path, 'tracked.txt'), 'modified');
  assert.equal(gitInfo(await inspectWorkspace(path)).active.dirty, true);
  f.git(path, 'add', '--', 'tracked.txt');
  assert.equal(gitInfo(await inspectWorkspace(path)).active.dirty, true);
  f.git(path, 'reset', '--hard', 'HEAD');
  await writeFile(join(path, '.git', 'info', 'exclude'), 'ignored\n');
  await writeFile(join(path, 'ignored'), 'x');
  assert.equal(gitInfo(await inspectWorkspace(path)).active.dirty, false);
}));

test('unborn and detached HEAD are truthful; branch/tag collision cannot alter the branch', async () => fixture(async (f) => {
  const unborn = gitInfo(await inspectWorkspace(await repo(f, 'unborn', false))).active;
  assert.equal(unborn.branch, 'trunk');
  assert.equal(unborn.revision, null);
  assert.equal(unborn.dirty, false);
  assert.equal(unborn.error, undefined);
  const path = await repo(f);
  f.git(path, 'tag', 'trunk');
  assert.equal(gitInfo(await inspectWorkspace(path)).active.branch, 'trunk');
  f.git(path, 'checkout', '--detach', 'HEAD');
  const detached = gitInfo(await inspectWorkspace(path)).active;
  assert.equal(detached.branch, null);
  assert.notEqual(detached.revision, null);
  assert.equal(detached.dirty, false);
}));

test('branch lookup failure is unavailable, not a detached active or main checkout', async () => fixture(async (f) => {
  const main = await repo(f);
  const active = join(f.root, 'linked');
  f.git(main, 'worktree', 'add', '-b', 'feature/safe', active);
  for (const failingPath of [active, main]) {
    await mock(f, 'git', `if(args[0]==='symbolic-ref' && process.cwd()===${JSON.stringify(failingPath)}) { process.stderr.write('failure secret'); process.exitCode=128; } else {${realGitFallback}}`, async () => {
      const info = await inspectWorkspace(active);
      if (failingPath === active) {
        assert.equal(info.git.kind, 'unknown');
        assert.match(JSON.stringify(info.git), /branch.*exit 128/i);
      } else {
        const status = gitInfo(info);
        assert.equal(status.active.branch, 'feature/safe');
        assert.equal(status.main, null);
        assert.match(status.mainUnavailableReason!, /branch.*exit 128/i);
      }
      assert.equal(JSON.stringify(info).includes('secret'), false);
    });
  }
}));

test('linked worktree reports actual main checkout, never the unrelated launch repository', async () => fixture(async (f) => {
  const main = await repo(f, 'main with spaces 日本語');
  const launch = await repo(f, 'unrelated launch');
  const active = join(f.root, 'worktree\nwith newline');
  f.git(main, 'worktree', 'add', '-b', 'feature/safe', active);
  await writeFile(join(main, 'dirty-main'), 'x');
  assert.equal(await resolveActivePath(active, launch), active);
  const info = gitInfo(await inspectWorkspace(active));
  assert.equal(info.isWorktree, true);
  assert.equal(info.active.path, active);
  assert.equal(info.active.branch, 'feature/safe');
  assert.equal(info.active.dirty, false);
  assert.equal(info.main?.path, main);
  assert.equal(info.main?.branch, 'trunk');
  assert.equal(info.main?.dirty, true);
  assert.equal(gitInfo(await inspectWorkspace(launch)).main, null);
}));

test('missing/pruned or unrelated replacement main checkout is unavailable, not guessed', async () => fixture(async (f) => {
  const main = await repo(f);
  const active = join(f.root, 'linked');
  f.git(main, 'worktree', 'add', '-b', 'feature/safe', active);
  const unrelated = await repo(f, 'replacement');
  for (const candidate of [join(f.root, 'gone-main'), unrelated]) {
    const record = `worktree ${candidate}\0HEAD abc\0\0`;
    await mock(f, 'git', `if(args[0]==='worktree') process.stdout.write(${JSON.stringify(record)}); else {${realGitFallback}}`, async () => {
      const info = gitInfo(await inspectWorkspace(active));
      assert.equal(info.main, null);
      assert.ok(info.mainUnavailableReason);
      assert.equal(info.active.dirty, false);
    });
  }
}));

test('bare parent has no main checkout; bare directory itself is not a working checkout', async () => fixture(async (f) => {
  const source = await repo(f);
  const bare = join(f.root, 'bare.git');
  f.git(f.root, 'clone', '--bare', source, bare);
  const active = join(f.root, 'from-bare');
  f.git(bare, 'worktree', 'add', active, 'trunk');
  const info = gitInfo(await inspectWorkspace(active));
  assert.equal(info.isWorktree, true);
  assert.equal(info.main, null);
  assert.match(info.mainUnavailableReason!, /bare/);
  assert.equal(await resolveActivePath(bare, f.root), bare);
  assert.equal((await inspectWorkspace(bare)).git.kind, 'unknown');
  assert.match(JSON.stringify(await inspectWorkspace(bare)), /no working checkout/);
}));

test('remote discovery prefers GitHub origin, supports standard forms/rewrite rules and avoids guessing', async () => fixture(async (f) => {
  const path = await repo(f);
  f.git(path, 'remote', 'add', 'other', 'git@gitlab.com:elsewhere/project.git');
  assert.equal((await inspectWorkspace(path)).github.kind, 'none');
  for (const url of ['git@github.com:Owner/project.git', 'github.com:Owner/project.git', 'https://github.com/Owner/project.git', 'ssh://git@github.com/Owner/project.git', 'ssh://git@ssh.github.com:443/Owner/project.git']) {
    f.git(path, 'config', 'remote.origin.url', url);
    assert.deepEqual((await inspectWorkspace(path)).github, repository);
  }
  f.git(path, 'remote', 'add', 'upstream', 'https://github.com/Upstream/project');
  assert.deepEqual((await inspectWorkspace(path)).github, repository);
  f.git(path, 'remote', 'remove', 'origin');
  assert.equal((await inspectWorkspace(path)).github.kind, 'repository');
  f.git(path, 'remote', 'add', 'second', 'https://github.com/Another/project');
  assert.equal((await inspectWorkspace(path)).github.kind, 'unknown');
  f.git(path, 'remote', 'remove', 'second');
  f.git(path, 'config', 'remote.origin.url', 'github:Owner/project');
  f.git(path, 'config', 'url.https://github.com/.insteadOf', 'github:');
  assert.deepEqual((await inspectWorkspace(path)).github, repository);
}));

test('malformed/ambiguous remotes are unknown; spoofed hosts/local paths are not GitHub', async () => fixture(async (f) => {
  const path = await repo(f);
  for (const url of ['https://github.com/Owner', 'https://github.com/Owner/project?token=secret', 'https://github.com/Owner/extra/project']) {
    f.git(path, 'config', 'remote.origin.url', url);
    const info = await inspectWorkspace(path);
    assert.equal(info.github.kind, 'unknown');
    assert.equal(JSON.stringify(info).includes('secret'), false);
  }
  for (const url of ['https://github.com.attacker.invalid/Owner/project', join(f.root, 'local with spaces')]) {
    f.git(path, 'config', 'remote.origin.url', url);
    assert.equal((await inspectWorkspace(path)).github.kind, 'none');
  }
  f.git(path, 'config', 'remote.origin.url', 'https://github.com/Owner/project');
  f.git(path, 'config', '--add', 'remote.origin.url', 'https://github.com/Other/project');
  assert.equal((await inspectWorkspace(path)).github.kind, 'unknown');
}));

test('inherited Git routing variables cannot select an unrelated repository', async () => fixture(async (f) => {
  const selected = await repo(f, 'selected');
  const unrelated = await repo(f, 'unrelated');
  f.git(unrelated, 'checkout', '-b', 'wrong');
  await withEnv({ ...process.env, GIT_DIR: join(unrelated, '.git'), GIT_WORK_TREE: unrelated, GIT_INDEX_FILE: join(unrelated, '.git', 'index') }, async () => {
    assert.equal(await resolveActivePath(selected, f.root), selected);
    assert.equal(gitInfo(await inspectWorkspace(selected)).active.branch, 'trunk');
  });
}));

test('status disables executable fsmonitor hooks and observes dirty submodules despite ignore config', async () => fixture(async (f) => {
  const path = await repo(f);
  const hook = join(f.root, 'fsmonitor');
  const marker = join(f.root, 'hook-ran');
  await writeFile(hook, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');\n`);
  await chmod(hook, 0o755);
  f.git(path, 'config', 'core.fsmonitor', hook);
  assert.equal(gitInfo(await inspectWorkspace(path)).active.dirty, false);
  await assert.rejects(readFile(marker));
  const source = await repo(f, 'submodule-source');
  f.git(path, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'sub');
  f.git(path, 'commit', '-m', 'submodule fixture');
  f.git(path, 'config', 'status.ignoreSubmodules', 'all');
  await writeFile(join(path, 'sub', 'tracked.txt'), 'modified');
  assert.equal(gitInfo(await inspectWorkspace(path)).active.dirty, true);
}));

test('Git absence, status errors and cancellation never claim clean or non-Git', async () => fixture(async (f) => {
  const path = await repo(f);
  const empty = join(f.root, 'empty-bin');
  await mkdir(empty);
  await withEnv({ ...process.env, PATH: empty }, async () => {
    assert.equal((await inspectWorkspace(path)).git.kind, 'unknown');
    assert.equal(await resolveActivePath(path, f.root), path);
    assert.equal((await inspectPullRequest(repository, 'feature/safe')).kind, 'unavailable');
  });
  for (const failure of ["process.stderr.write('permission denied secret'); process.exitCode=128;", "process.stdout.write('x'.repeat(2*1024*1024));"]) {
    await mock(f, 'git', `if(args.includes('status')) {${failure}} else {${realGitFallback}}`, async (log) => {
      const info = gitInfo(await inspectWorkspace(path));
      assert.equal(info.active.dirty, null);
      assert.ok(info.active.error);
      assert.equal(JSON.stringify(info).includes('secret'), false);
      const calls = (await readFile(log, 'utf8')).trim().split('\n').map((entry) => JSON.parse(entry));
      assert.equal(calls.every((call) => call.optionalLocks === '0' && call.noLazyFetch === '1'), true);
    });
  }
  const controller = new AbortController();
  controller.abort();
  assert.equal((await inspectWorkspace(path, { signal: controller.signal })).git.kind, 'unknown');
  assert.equal((await inspectPullRequest(repository, 'feature/safe', { signal: controller.signal })).kind, 'unavailable');
}));

test('bounded local Git timeout is unknown and active path resolution rejects it', async () => fixture(async (f) => {
  await mock(f, 'git', 'setTimeout(()=>{},20000);', async () => {
    const started = Date.now();
    const info = await inspectWorkspace(f.root);
    assert.equal(info.git.kind, 'unknown');
    assert.match(JSON.stringify(info), /timed out/);
    assert.ok(Date.now() - started < 8000);
    await assert.rejects(resolveActivePath(f.root, f.root), /timed out/);
  });
}));

test('safe PR lookup explicitly narrows read-only API request and validates fork identity', async () => fixture(async (f) => {
  await mock(f, 'gh', response([pr()]), async (log) => {
    assert.deepEqual(await inspectPullRequest(repository, 'feature/safe'), { kind: 'open', number: 7, url: `${repository.url}/pull/7` });
    const call = JSON.parse((await readFile(log, 'utf8')).trim());
    assert.deepEqual(call.args, ['api', '--hostname', 'github.com', '--method', 'GET', 'repos/Owner/project/pulls', '--raw-field', 'state=open', '--raw-field', 'head=Owner:feature/safe', '--raw-field', 'per_page=100']);
    assert.equal(call.promptDisabled, '1');
  });
  for (const data of [[], [pr(8, 'Other/project')], [pr(8, repository.name, 'different')]]) {
    await mock(f, 'gh', response(data), async () => assert.deepEqual(await inspectPullRequest(repository, 'feature/safe'), { kind: 'none' }));
  }
  const unusual = 'feature/$();日本語';
  await mock(f, 'gh', response([pr(9, repository.name, unusual)]), async () => assert.equal((await inspectPullRequest(repository, unusual)).kind, 'open'));
}));

test('PR boundary rejects malformed, wrong-base, duplicate and truncated API responses', async () => fixture(async (f) => {
  const malformed = [
    {}, [{ ...pr(), html_url: 'https://attacker.invalid/pull/7' }],
    [{ ...pr(), base: { repo: { full_name: 'Other/project' } } }],
    [{ ...pr(), head: { ref: 'feature/safe', repo: null } }],
    [{ ...pr(), head: { ref: '', repo: { full_name: repository.name } } }],
    [pr(1), pr(2)], Array.from({ length: 100 }, (_, i) => pr(i + 1)),
  ];
  for (const data of malformed) await mock(f, 'gh', response(data), async () => assert.equal((await inspectPullRequest(repository, 'feature/safe')).kind, 'unavailable'));
  await mock(f, 'gh', "process.stdout.write('not json');", async () => assert.equal((await inspectPullRequest(repository, 'feature/safe')).kind, 'unavailable'));
}));

test('PR auth, access, validation, rate-limit, network and cancellation stay unavailable without leaking stderr', async () => fixture(async (f) => {
  for (const [stderr, reason, code] of [
    ['secret', 'authentication', 4], ['HTTP 403 secret', 'access', 1],
    ['HTTP 422 secret', 'validation', 1], ['HTTP 403 rate limit secret', 'rate limit', 1],
    ['dial tcp connection refused secret', 'network', 1],
  ] as const) {
    await mock(f, 'gh', `process.stderr.write(${JSON.stringify(stderr)}); process.exitCode=${code};`, async () => {
      const info = await inspectPullRequest(repository, 'feature/safe');
      assert.equal(info.kind, 'unavailable');
      assert.match(JSON.stringify(info), new RegExp(reason));
      assert.equal(JSON.stringify(info).includes('secret'), false);
    });
  }
  await mock(f, 'gh', 'setTimeout(()=>{},20000);', async () => {
    const controller = new AbortController();
    const pending = inspectPullRequest(repository, 'feature/safe', { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    assert.match(JSON.stringify(await pending), /cancelled/);
  });
}));

test('GitHub timeout is unavailable, never no-open-PR', async () => fixture(async (f) => {
  await mock(f, 'gh', 'setTimeout(()=>{},20000);', async () => {
    const started = Date.now();
    const info = await inspectPullRequest(repository, 'feature/safe');
    assert.equal(info.kind, 'unavailable');
    assert.match(JSON.stringify(info), /timed out/);
    assert.ok(Date.now() - started < 15000);
  });
}));

test('detached and invalid PR inputs never invoke gh or infer an arbitrary repository', async () => fixture(async (f) => {
  await mock(f, 'gh', "throw new Error('Must not invoke gh');", async (log) => {
    assert.deepEqual(await inspectPullRequest(repository, null), { kind: 'not-applicable' });
    for (const candidate of [{ ...repository, name: '../injection' }, { ...repository, url: 'https://other.invalid/Owner/project' }]) assert.equal((await inspectPullRequest(candidate, 'feature/safe')).kind, 'unavailable');
    assert.equal((await inspectPullRequest(repository, 'bad\nbranch')).kind, 'unavailable');
    await assert.rejects(readFile(log));
  });
}));
