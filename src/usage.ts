import { execFile } from 'node:child_process';

/** CodexBar provider ids shown in the footer, in display order. */
export const USAGE_PROVIDERS = ['codex', 'claude', 'kimi'] as const;
export type UsageProviderId = typeof USAGE_PROVIDERS[number];
/** A window's used share; null when CodexBar reported the window without a finite percentage. */
export type UsageWindow = { usedPercent: number | null; resetsAt: number | null };
/** Only 300-minute (5H) and 10080-minute (WK) windows are kept; an absent key is a window the provider does not report. */
export type UsageWindows = { '5h'?: UsageWindow; wk?: UsageWindow };
export type UsageResult =
  | { kind: 'usage'; windows: UsageWindows; updatedAt: number | null }
  | { kind: 'unavailable'; reason: 'timeout' | 'cancelled' | 'failed' }
  | { kind: 'not-installed' };
type Options = { signal?: AbortSignal; timeoutMs?: number; killGraceMs?: number };

const WINDOWS: Record<number, keyof UsageWindows> = { 300: '5h', 10080: 'wk' };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

// ISO 8601 instants only; anything else is unknown rather than guessed.
function instant(value: unknown): number | null {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

// Window position is not stable across providers (Kimi reverses them, Codex has
// no primary), so windows are identified by length. Identity, credits, pace and
// every other field are never copied out of the payload.
function parse(provider: UsageProviderId, stdout: string): UsageResult {
  const failed = { kind: 'unavailable', reason: 'failed' } as const;
  let data: unknown;
  try { data = JSON.parse(stdout); }
  catch { return failed; }
  if (!Array.isArray(data) || data.length !== 1) return failed;
  const [item] = data;
  if (!record(item) || item.provider !== provider || (item.error !== undefined && item.error !== null) || !record(item.usage)) return failed;
  const windows: UsageWindows = {};
  for (const position of ['primary', 'secondary', 'tertiary']) {
    const value = item.usage[position];
    if (value === null || value === undefined) continue;
    if (!record(value)) return failed;
    const key = typeof value.windowMinutes === 'number' ? WINDOWS[value.windowMinutes] : undefined;
    if (!key || windows[key]) continue; // first of a duplicated length wins
    const used = value.usedPercent;
    windows[key] = { usedPercent: typeof used === 'number' && Number.isFinite(used) ? used : null, resetsAt: instant(value.resetsAt) };
  }
  return { kind: 'usage', windows, updatedAt: instant(item.usage.updatedAt) };
}

/**
 * Read-only `codexbar usage` for one provider. On provider failure CodexBar exits 1
 * with a JSON error payload on stdout; its message is never returned because it is
 * untrusted and may name the account, so any non-zero exit is simply unavailable.
 */
export function fetchUsage(provider: UsageProviderId, options: Options = {}): Promise<UsageResult> {
  const { signal } = options;
  if (signal?.aborted) return Promise.resolve({ kind: 'unavailable', reason: 'cancelled' });
  return new Promise((resolve) => {
    let settled = false, deadline: ReturnType<typeof setTimeout> | undefined;
    const done = (result: UsageResult) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      signal?.removeEventListener('abort', abort);
      resolve(result);
    };
    const child = execFile('codexbar', ['usage', '--provider', provider, '--format', 'json', '--json-only'], {
      env: { ...process.env, NO_COLOR: '1' }, encoding: 'utf8', maxBuffer: 1024 * 1024,
    }, (error, stdout) => {
      if (!error) return done(parse(provider, stdout));
      const code = 'code' in error ? error.code : undefined;
      done(code === 'ENOENT' ? { kind: 'not-installed' } : { kind: 'unavailable', reason: 'failed' });
    });
    const running = () => child.pid !== undefined && child.exitCode === null && child.signalCode === null;
    // Not execFile's `signal` or `timeout`: aborting a spawn that failed with ENOENT before Node reports
    // it signals pid 0, the caller's whole process group (Node 22.23). Only a started child is signalled.
    // SIGTERM lets CodexBar clean up; one that ignores it is killed after a grace period. The result
    // settles at once either way, so a stuck child never holds up polling.
    const stop = (result: UsageResult) => {
      if (running()) {
        child.kill('SIGTERM');
        setTimeout(() => { if (running()) child.kill('SIGKILL'); }, options.killGraceMs ?? 5_000).unref();
      }
      done(result);
    };
    function abort() { stop({ kind: 'unavailable', reason: 'cancelled' }); }
    deadline = setTimeout(() => stop({ kind: 'unavailable', reason: 'timeout' }), options.timeoutMs ?? 60_000);
    deadline.unref();
    signal?.addEventListener('abort', abort, { once: true });
  });
}
