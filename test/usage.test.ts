import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { USAGE_PROVIDERS, fetchUsage } from '../src/usage.ts';
import type { UsageProviderId } from '../src/usage.ts';

// Payloads follow real CodexBar 0.60.3 output (identity already removed). Account
// fields are re-added here only to prove that nothing outside the whitelist is kept.
const account = { providerID: 'x', accountEmail: 'person@example.invalid', accountOrganization: 'Secret Org' };
const claude = [{
  pace: { primary: { stage: 'farBehind', summary: '55% in reserve', deltaPercent: -55 } },
  source: 'claude', provider: 'claude',
  usage: {
    secondary: { usedPercent: 6, resetsAt: '2026-10-12T19:00:00Z', resetDescription: 'ResetsOct13at3am(Asia/Singapore)', windowMinutes: 10080 },
    dataConfidence: 'percentOnly', updatedAt: '2026-10-07T03:02:07Z',
    primary: { usedPercent: 19, resetsAt: '2026-10-07T04:20:00Z', resetDescription: 'Resets12:20pm(Asia/Singapore)', windowMinutes: 300 },
    tertiary: null,
    extraRateWindows: [{ title: 'Fable only', id: 'claude-weekly-scoped-fable', window: { windowMinutes: 10080, usedPercent: 0, resetsAt: '2026-10-12T19:00:00Z' } }],
    identity: account,
  },
  credits: { remaining: 12, accountEmail: 'person@example.invalid' },
}];
const codex = [{
  usage: {
    secondary: { usedPercent: 25, resetsAt: '2026-10-13T05:20:02Z', resetDescription: 'Oct 13 at 1:20\u202fPM', windowMinutes: 10080 },
    dataConfidence: 'exact', updatedAt: '2026-10-07T03:01:50Z', primary: null, tertiary: null, identity: account,
  },
  pace: { secondary: { stage: 'farAhead', etaSeconds: 234325 } }, version: '0.153.0', provider: 'codex', source: 'oauth',
}];
const kimi = [{
  version: '2.1.1', provider: 'kimi', source: 'Kimi Code API key',
  usage: {
    secondary: { resetsAt: '2026-10-07T06:13:06Z', resetDescription: 'Rate: 0/100 per 5 hours', usedPercent: 0, windowMinutes: 300 },
    primary: { resetsAt: '2026-10-13T15:13:06Z', resetDescription: '7/100 requests', usedPercent: 7.000000000000001, windowMinutes: 10080 },
    tertiary: null, updatedAt: '2026-10-07T03:03:20Z', identity: account,
  },
}];
const failure = [{ error: { message: "Not logged in to Gemini. Run 'gemini' in Terminal to authenticate.", kind: 'provider', code: 1 }, source: 'auto', provider: 'claude' }];
const at = (iso: string) => Date.parse(iso);

// A disposable fake `codexbar` on PATH; no live CodexBar, provider account or network.
// Reuse one immutable executable: macOS checks each newly written executable at
// first launch. Payloads live in non-executable files in each isolated fixture.
const launcherRoot = await mkdtemp(join(tmpdir(), 'pi-usage-launcher-'));
const launcher = join(launcherRoot, 'codexbar');
await writeFile(launcher, `#!${process.execPath}\nconst fs=require('node:fs'), path=require('node:path'); const args=process.argv.slice(2);
const root=path.dirname(process.argv[1]);
new Function('fs','args',fs.readFileSync(path.join(root,'body'),'utf8'))(fs,args);
`);
await chmod(launcher, 0o755);
after(() => rm(launcherRoot, { recursive: true, force: true }));
async function fake(body: string, run: (log: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pi-usage-'));
  const log = join(root, 'calls.jsonl');
  await symlink(launcher, join(root, 'codexbar'));
  await writeFile(join(root, 'body'), `fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,noColor:process.env.NO_COLOR,pid:process.pid})+'\\n');\n${body}\n`);
  const path = process.env.PATH;
  process.env.PATH = `${root}${delimiter}${path ?? ''}`;
  try { await run(log); }
  finally { process.env.PATH = path; await rm(root, { recursive: true, force: true }); }
}
const print = (data: unknown, exit = 0) => `process.stdout.write(${JSON.stringify(typeof data === 'string' ? data : JSON.stringify(data))}); process.exitCode=${exit};`;
const calls = async (log: string) => { try { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; } };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

test('maps the real Claude, Codex and Kimi shapes by window length, not position, with exact read-only argv', async () => {
  assert.deepEqual([...USAGE_PROVIDERS], ['codex', 'claude', 'kimi']);
  const expected: Record<UsageProviderId, unknown> = {
    claude: { kind: 'usage', updatedAt: at('2026-10-07T03:02:07Z'), windows: { '5h': { usedPercent: 19, resetsAt: at('2026-10-07T04:20:00Z') }, wk: { usedPercent: 6, resetsAt: at('2026-10-12T19:00:00Z') } } },
    // Codex has no primary (5h) window today: it is absent, not unknown.
    codex: { kind: 'usage', updatedAt: at('2026-10-07T03:01:50Z'), windows: { wk: { usedPercent: 25, resetsAt: at('2026-10-13T05:20:02Z') } } },
    // Kimi reports the week as primary and 5h as secondary.
    kimi: { kind: 'usage', updatedAt: at('2026-10-07T03:03:20Z'), windows: { '5h': { usedPercent: 0, resetsAt: at('2026-10-07T06:13:06Z') }, wk: { usedPercent: 7.000000000000001, resetsAt: at('2026-10-13T15:13:06Z') } } },
  };
  for (const [provider, payload] of [['claude', claude], ['codex', codex], ['kimi', kimi]] as const) {
    await fake(print(payload), async (log) => {
      const result = await fetchUsage(provider);
      assert.deepEqual(result, expected[provider]);
      // Only whitelisted numbers survive: no identity, email, credits, pace, source or descriptions.
      assert.doesNotMatch(JSON.stringify(result), /person@|Secret|identity|credits|pace|source|Resets|requests|Fable|oauth/);
      assert.deepEqual((await calls(log)).map(({ args, noColor }) => ({ args, noColor })), [{ args: ['usage', '--provider', provider, '--format', 'json', '--json-only'], noColor: '1' }]);
    });
  }
});

test('error payloads, non-zero exits and malformed, empty, oversized or mismatched output are unavailable, never empty usage', async () => {
  const failed = { kind: 'unavailable', reason: 'failed' };
  const cases: [string, string][] = [
    ['error payload, exit 1', print(failure, 1)],
    ['error payload, exit 0', print(failure)],
    ['success payload but exit 1', print(claude, 1)],
    ['malformed JSON', print('[{"provider":"claude",')],
    ['empty output', print('')],
    ['non-array', print(claude[0])],
    ['two entries', print([...claude, ...claude])],
    ['other provider', print(kimi)],
    ['missing usage', print([{ provider: 'claude' }])],
    ['non-object window', print([{ provider: 'claude', usage: { primary: 'full' } }])],
    ['oversized output', `process.stdout.write('['+' '.repeat(1100000)+']');`],
    ['killed by a signal', `process.kill(process.pid,'SIGKILL');`],
  ];
  for (const [name, body] of cases) {
    await fake(body, async () => {
      const result = await fetchUsage('claude');
      assert.deepEqual(result, failed, name);
      assert.doesNotMatch(JSON.stringify(result), /Gemini|gemini|logged/, `${name}: raw messages are never returned`);
    });
  }
});

test('ENOENT is not-installed; timeout and abort are distinct and leave no running child', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'pi-usage-empty-'));
  const path = process.env.PATH;
  process.env.PATH = empty;
  try { assert.deepEqual(await fetchUsage('kimi'), { kind: 'not-installed' }); }
  finally { process.env.PATH = path; await rm(empty, { recursive: true, force: true }); }

  await fake(`setTimeout(()=>process.stdout.write(${JSON.stringify(JSON.stringify(kimi))}),5000);`, async (log) => {
    const started = Date.now();
    assert.deepEqual(await fetchUsage('kimi', { timeoutMs: 200 }), { kind: 'unavailable', reason: 'timeout' });
    assert.ok(Date.now() - started < 3000, 'the bound applies');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200); // after the child has started
    assert.deepEqual(await fetchUsage('kimi', { signal: controller.signal }), { kind: 'unavailable', reason: 'cancelled' });
    await sleep(50);
    const spawned = await calls(log);
    assert.equal(spawned.length, 2);
    for (const { pid } of spawned) assert.equal(alive(pid), false, 'timeout and abort terminate the child');
    const before = spawned.length;
    assert.deepEqual(await fetchUsage('kimi', { signal: AbortSignal.abort() }), { kind: 'unavailable', reason: 'cancelled' });
    assert.equal((await calls(log)).length, before, 'an already-aborted signal never spawns');
  });
});

test('a child that ignores SIGTERM settles at the deadline or abort and is killed after the grace period', async () => {
  await fake(`process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`, async (log) => {
    const started = Date.now();
    assert.deepEqual(await fetchUsage('kimi', { timeoutMs: 200, killGraceMs: 100 }), { kind: 'unavailable', reason: 'timeout' });
    assert.ok(Date.now() - started < 1500, 'settles at the deadline, not when the child exits');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    assert.deepEqual(await fetchUsage('kimi', { signal: controller.signal, killGraceMs: 100 }), { kind: 'unavailable', reason: 'cancelled' });
    const spawned = await calls(log);
    assert.equal(spawned.length, 2);
    assert.ok(spawned.some(({ pid }) => alive(pid)), 'SIGTERM alone does not stop it');
    await sleep(300);
    for (const { pid } of spawned) assert.equal(alive(pid), false, 'escalated to SIGKILL');
  });
});

test('aborting a call whose spawn failed (ENOENT) never signals the caller process group', async () => {
  // Node 22.23 signals pid 0 when execFile's own signal aborts a failed spawn. Run in a detached
  // process group so a regression kills only that probe, not the test runner.
  const empty = await mkdtemp(join(tmpdir(), 'pi-usage-empty-'));
  const script = `import { fetchUsage } from ${JSON.stringify(pathToFileURL(resolve('src/usage.ts')).href)};
const controller = new AbortController(), pending = fetchUsage('claude', { signal: controller.signal });
controller.abort();
console.log(JSON.stringify(await pending));
await new Promise((done) => setTimeout(done, 300));
console.log('survived');`;
  try {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { env: { ...process.env, PATH: empty }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    const [code, signal] = await new Promise<[number | null, string | null]>((done) => child.on('close', (...result) => done(result as [number | null, string | null])));
    assert.deepEqual([code, signal], [0, null], output);
    assert.equal(output, '{"kind":"unavailable","reason":"cancelled"}\nsurvived\n');
  } finally { await rm(empty, { recursive: true, force: true }); }
});

test('non-finite or missing percentages and invalid times are unknown; duplicate lengths keep the first; other lengths are ignored', async () => {
  // 1e999 is how JSON spells a non-finite number: JSON.parse yields Infinity.
  const payload = `[{"provider":"codex","usage":{"updatedAt":"yesterday",
    "primary":{"usedPercent":1e999,"resetsAt":"2026-10-07T04:20:00.000+08:00","windowMinutes":300},
    "secondary":{"usedPercent":40,"resetsAt":"not a date","windowMinutes":60},
    "tertiary":{"usedPercent":10,"resetsAt":"2026-10-13T05:20:02Z","windowMinutes":300},
    "extraRateWindows":[{"window":{"usedPercent":0,"windowMinutes":10080}}]}}]`;
  await fake(print(payload), async () => {
    assert.deepEqual(await fetchUsage('codex'), { kind: 'usage', updatedAt: null, windows: { '5h': { usedPercent: null, resetsAt: at('2026-10-06T20:20:00Z') } } });
  });
  const variants = [{ usedPercent: '19', resetsAt: 1_700_000_000 }, { usedPercent: null }, {}];
  for (const window of variants) {
    await fake(print([{ provider: 'claude', usage: { primary: { ...window, windowMinutes: 10080 } } }]), async () => {
      assert.deepEqual(await fetchUsage('claude'), { kind: 'usage', updatedAt: null, windows: { wk: { usedPercent: null, resetsAt: null } } }, JSON.stringify(window));
    });
  }
  // A successful payload with no 300/10080 windows is a real "no limits" state.
  await fake(print([{ provider: 'kimi', usage: { primary: { usedPercent: 3, windowMinutes: 43200 }, secondary: null } }]), async () => {
    assert.deepEqual(await fetchUsage('kimi'), { kind: 'usage', updatedAt: null, windows: {} });
  });
});
