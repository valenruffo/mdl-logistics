/**
 * The explicit session check: run `scripts/session-check.mjs`, keep what it
 * printed, and remember the last few results.
 *
 * Why it is never automatic: the check opens Chromium against the store admin.
 * A page that re-ran it on every load would open browsers while the operator is
 * reading, so the only caller is the `POST /api/session-check` route, which only
 * the explicit button reaches.
 *
 * What is stored is the check's own output, truncated, plus its exit code. The
 * session file and the profile are never read here: their contents are a
 * credential (R15). The console reads that file for one number only — the
 * `expires` of the `admn_session` cookie — and nothing else from it.
 *
 * **The stored output never leaves the process.** The history file keeps the
 * script's `message` and `output` verbatim so the operator can read them over
 * SSH, but everything that crosses the HTTP boundary is the closed projection
 * of `factOfCheck()`: the result enum, the exit code, the timestamp and the
 * duration. A check prints what it saw on the panel, and that may name the
 * recipient, so no substring of it is serialised.
 *
 * A check is a browser, and the container has memory for one: the route that
 * calls this runs under the single-flight lock of `lock.ts`, and the timeout
 * here escalates `SIGTERM` → grace → `SIGKILL` on the check's **process group**,
 * so a wedged Chromium cannot outlive the check and keep that lock busy.
 *
 * Exit codes are the script's contract (see its header):
 *   0 usable · 1 unusable · 2 configuration refused · 3 no browser.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { messageOf } from '../executor/errors';
import { parentOf } from './paths';

/** Where the check history lives. Under `artifacts/`, like every other record. */
export const SESSION_CHECK_HISTORY_PATH = 'artifacts/ui/session-checks.json';

/** How many checks are remembered. Short on purpose: this is a trend, not an audit log. */
export const SESSION_CHECK_HISTORY_LIMIT = 10;

/** The script this module runs, relative to the repository root. */
export const SESSION_CHECK_SCRIPT = 'scripts/session-check.mjs';

/** A browser can take a while on a cold container; past this it is stopped. */
export const SESSION_CHECK_TIMEOUT_MS = 180_000;

/**
 * After `SIGTERM`, how long the check has before its process group gets
 * `SIGKILL`. Short: the point of the second signal is that a wedged Chromium
 * cannot outlive the check and keep the single-flight lock busy.
 */
export const SESSION_CHECK_KILL_GRACE_MS = 5_000;

/** Cap on the stored output. The full console transcript is not needed to diagnose. */
export const SESSION_CHECK_OUTPUT_LIMIT = 4_000;

/** The line the history file keeps, taken from the check's own output. Disk only. */
const FLAGGED_LINE = /^(ERROR|OK)\s*:/;

/**
 * The closed vocabulary of outcomes the console can show.
 *
 * Four values, and only these four, because the result is the one thing the HTTP
 * surface says about a check: the script's own words stay on disk. `unusable` is
 * the script's verdict about the session; `config-refused` means it refused before
 * opening a browser; `browser-failed` covers everything that kept it from
 * producing a verdict at all (no browser, an unknown exit code, a timeout, a
 * spawn failure).
 */
export type SessionCheckResult = 'usable' | 'unusable' | 'config-refused' | 'browser-failed';

export interface SessionCheckRun {
  /** `null` when the process never reported one (spawn failure or timeout). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Set when the check could not be executed at all. */
  spawnProblem: string | null;
  durationMs: number;
}

/** Injected so tests exercise the recording without ever launching a browser. */
export type SessionCheckRunner = () => Promise<SessionCheckRun>;

/** The one stream surface this module reads from the spawned check. */
export interface SessionCheckChildStream {
  setEncoding(encoding: string): void;
  on(event: 'data', listener: (chunk: string) => void): unknown;
}

/**
 * The slice of `ChildProcess` this module uses. Narrowed to an interface so a
 * test can inject a fake child and watch the timeout escalation without ever
 * starting a browser.
 */
export interface SessionCheckChild {
  readonly pid: number | undefined;
  readonly stdout: SessionCheckChildStream | null;
  readonly stderr: SessionCheckChildStream | null;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  kill(signal?: string): boolean;
}

/**
 * How `runSessionCheckProcess` starts the check and how it signals it. Both are
 * injectable for tests; the defaults are the real spawn and the real kill group.
 */
export interface SessionCheckProcessOptions {
  spawnChild?: () => SessionCheckChild;
  timeoutMs?: number;
  graceMs?: number;
  /** Sends `signal` to the child and everything it started. */
  signalGroup?: (child: SessionCheckChild, signal: string) => void;
}

export interface SessionCheckEntry {
  /** When the attempt started. */
  runAt: string;
  result: SessionCheckResult;
  exitCode: number | null;
  durationMs: number;
  /**
   * The line the check printed, verbatim (`OK: ...` / `ERROR: ...`).
   * **Disk only**: never serialised, because it is the script's own text.
   */
  message: string;
  /** stdout and stderr joined, truncated. Verbatim. **Disk only**, for the same reason. */
  output: string;
  /** Always true: the check opens a browser, and the record says so. */
  opensBrowser: true;
  /** Why the check could not be executed at all. **Disk only.** */
  spawnProblem: string | null;
}

/**
 * One check as the HTTP surface is allowed to know it: four facts, no text.
 *
 * This is the whole session-check shape over `/api/console`. There is no
 * `message`, no `output` and no `spawnProblem` field, so a response cannot carry
 * a byte the script printed even for a record that has them on disk.
 */
export interface SessionCheckFact {
  /** ISO-8601 UTC, as recorded. */
  runAt: string;
  /** One of the four closed results. */
  result: SessionCheckResult;
  /** The process exit code, or `null` when it never reported one. */
  exitCode: number | null;
  /** How long the check took, in milliseconds. */
  durationMs: number;
}

/** Drops a stored entry to the closed facts the console may show. */
export function factOfCheck(entry: SessionCheckEntry): SessionCheckFact {
  return {
    runAt: entry.runAt,
    result: entry.result,
    exitCode: entry.exitCode,
    durationMs: entry.durationMs,
  };
}

export interface SessionCheckHistory {
  version: 1;
  updatedAt: string;
  checks: SessionCheckEntry[];
}

export const SESSION_CHECK_RESULTS: readonly SessionCheckResult[] = [
  'usable',
  'unusable',
  'config-refused',
  'browser-failed',
];

/**
 * The result names an earlier revision wrote, mapped onto the closed vocabulary.
 *
 * The history file on a deployed box predates this rename, so the reader maps an
 * old record instead of dropping it: the disk format is read tolerantly, not
 * migrated. `error` covered every non-verdict, which is `browser-failed` now, and
 * `no-browser` (the script's exit code 3) is one of its causes.
 */
const LEGACY_RESULTS: ReadonlyMap<string, SessionCheckResult> = new Map<string, SessionCheckResult>([
  ['bad-config', 'config-refused'],
  ['no-browser', 'browser-failed'],
  ['error', 'browser-failed'],
]);

/** A stored `result` name reduced to the closed vocabulary; `null` when unknown. */
function resultNamed(value: string): SessionCheckResult | null {
  if (SESSION_CHECK_RESULTS.includes(value as SessionCheckResult)) return value as SessionCheckResult;
  return LEGACY_RESULTS.get(value) ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function missingFile(error: unknown): boolean {
  return isRecord(error) && (error['code'] === 'ENOENT' || error['code'] === 'ENOTDIR');
}

function textOrNull(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' ? value : null;
}

/**
 * The script's documented exit codes, mapped onto the closed vocabulary.
 *
 * `0` usable · `1` unusable · `2` configuration refused · everything else (its
 * own `3` "no browser", an unexpected code, or no code at all) is a browser that
 * never produced a verdict, which is one fact: `browser-failed`.
 */
export function resultOfExitCode(exitCode: number | null): SessionCheckResult {
  switch (exitCode) {
    case 0:
      return 'usable';
    case 1:
      return 'unusable';
    case 2:
      return 'config-refused';
    default:
      return 'browser-failed';
  }
}

function outputOf(run: SessionCheckRun): string {
  const joined = [run.stdout.trim(), run.stderr.trim()].filter((part) => part !== '').join('\n');
  return joined.length > SESSION_CHECK_OUTPUT_LIMIT
    ? `${joined.slice(0, SESSION_CHECK_OUTPUT_LIMIT)}\n… (recortado)`
    : joined;
}

/** The check's own headline when it printed one; otherwise its last line. */
export function messageOfRun(run: SessionCheckRun): string {
  const lines = `${run.stdout}\n${run.stderr}`
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

  const flagged = lines.find((line) => FLAGGED_LINE.test(line));
  if (flagged !== undefined) return flagged;

  const last = lines[lines.length - 1];
  if (last !== undefined) return last;

  return run.spawnProblem ?? '(el chequeo no imprimió nada)';
}

export function entryOfRun(run: SessionCheckRun, runAt: string): SessionCheckEntry {
  return {
    runAt,
    result: run.spawnProblem === null ? resultOfExitCode(run.exitCode) : 'browser-failed',
    exitCode: run.exitCode,
    durationMs: run.durationMs,
    message: messageOfRun(run),
    output: outputOf(run),
    opensBrowser: true,
    spawnProblem: run.spawnProblem,
  };
}

/**
 * Starts the check in **its own process group**.
 *
 * The group is what makes the timeout honest: the script starts Chromium, and
 * signalling only the script leaves the browser it started behind. Detaching is
 * the price of being able to reach that whole group at once.
 */
function spawnSessionCheckChild(): SessionCheckChild {
  const child = spawn(process.execPath, ['--import', 'tsx', SESSION_CHECK_SCRIPT], {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
  });
  return child as unknown as SessionCheckChild;
}

/**
 * Signals the child **and everything it started**: `-pid` addresses the process
 * group, so the Chromium the check spawned gets the signal too. Where a group
 * cannot be addressed (Windows, or a child that never became a group leader),
 * the child itself is signalled and the failure is swallowed: the process may
 * already be gone, and reporting that is not more useful than the timeout.
 */
function signalProcessGroup(child: SessionCheckChild, signal: string): void {
  const pid = child.pid;
  if (pid !== undefined && pid > 0) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall through to signalling the child alone.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already gone: nothing left to stop.
  }
}

/**
 * Runs the check once and always stops the browser it opened.
 *
 * On timeout the escalation is two-staged: `SIGTERM` first, so the script can
 * finish writing what it saw, then `SIGKILL` to the whole group after
 * `SESSION_CHECK_KILL_GRACE_MS`. A wedged Chromium that ignores `SIGTERM`
 * therefore cannot outlive the check — which matters because the caller holds
 * the single-flight lock (`lock.ts`) until this promise settles.
 */
export function runSessionCheckProcess(options: SessionCheckProcessOptions = {}): Promise<SessionCheckRun> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? SESSION_CHECK_TIMEOUT_MS;
  const graceMs = options.graceMs ?? SESSION_CHECK_KILL_GRACE_MS;
  const signalGroup = options.signalGroup ?? signalProcessGroup;
  const spawnChild = options.spawnChild ?? spawnSessionCheckChild;

  const timeoutProblem =
    `el chequeo no terminó en ${timeoutMs} ms y se detuvo: SIGTERM al grupo de procesos y, ` +
    `tras ${graceMs} ms de gracia, SIGKILL para que ningún Chromium sobreviva al chequeo`;

  return new Promise<SessionCheckRun>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (exitCode: number | null, spawnProblem: string | null): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolve({ exitCode, stdout, stderr, spawnProblem, durationMs: Date.now() - startedAt });
    };

    let child: SessionCheckChild;
    try {
      child = spawnChild();
    } catch (error) {
      finish(null, `no se pudo iniciar el chequeo: ${messageOf(error)}`);
      return;
    }

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      // A wedged browser may ignore the polite signal; the group is killed next.
      signalGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        signalGroup(child, 'SIGKILL');
        // Resolve even if the group never reports back: the promise is what
        // frees the single-flight lock, so it must not wait on a dead browser.
        finish(null, timeoutProblem);
      }, graceMs);
    }, timeoutMs);

    if (child.stdout !== null) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
    }
    if (child.stderr !== null) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
    }

    child.on('error', (error) => {
      finish(null, timedOut ? timeoutProblem : `no se pudo iniciar el chequeo: ${messageOf(error)}`);
    });
    child.on('close', (code) => {
      finish(timedOut ? null : code, timedOut ? timeoutProblem : null);
    });
  });
}

/**
 * The real runner: the same script `npm run session-check` calls, started with
 * the Node that runs the UI, in the repository root.
 */
export function runSessionCheckScript(): Promise<SessionCheckRun> {
  return runSessionCheckProcess();
}

function entryFrom(value: unknown): SessionCheckEntry | null {
  if (!isRecord(value)) return null;

  const runAt = textOrNull(value, 'runAt');
  const storedResult = textOrNull(value, 'result');
  const message = textOrNull(value, 'message');
  if (runAt === null || storedResult === null || message === null) return null;
  const result = resultNamed(storedResult);
  if (result === null) return null;

  const exitCode = value['exitCode'];
  const durationMs = value['durationMs'];

  return {
    runAt,
    result,
    exitCode: typeof exitCode === 'number' ? exitCode : null,
    durationMs: typeof durationMs === 'number' ? durationMs : 0,
    message,
    output: textOrNull(value, 'output') ?? '',
    opensBrowser: true,
    spawnProblem: textOrNull(value, 'spawnProblem'),
  };
}

export interface SessionCheckHistoryRead {
  /** Newest first. */
  checks: SessionCheckEntry[];
  /** Set when the file exists but could not be used; never thrown. */
  problem: string | null;
  /**
   * True when the file exists and yields no usable entry at all: the whole thing
   * is unparseable. Only its **path** may then be reported — a parser message
   * quotes the bytes it choked on, and those bytes are the check's own output.
   */
  unparseable: boolean;
}

/** Nothing usable in the file: report the path, never an excerpt. */
function unreadable(path: string, reason: string): SessionCheckHistoryRead {
  return { checks: [], problem: reason, unparseable: true };
}

/**
 * Reads the history tolerantly. A missing file is "no check has run yet"; a
 * corrupt file is a warning the console renders, with the good entries kept.
 *
 * A parse failure is reported **by path only**. `messageOf(error)` is deliberately
 * not used here: `JSON.parse` quotes the token it choked on, and this file holds
 * the check's own stdout.
 */
export async function readSessionCheckHistory(path: string): Promise<SessionCheckHistoryRead> {
  let text: string;
  try {
    text = await readFile(path, { encoding: 'utf8' });
  } catch (error) {
    if (missingFile(error)) return { checks: [], problem: null, unparseable: false };
    return unreadable(path, `no se pudo leer el historial ${path}: ${messageOf(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return unreadable(
      path,
      `el historial ${path} no es JSON válido: se informa solo la ruta, nunca su contenido`,
    );
  }

  if (!isRecord(parsed)) {
    return unreadable(path, `el historial ${path} no es un objeto JSON: se informa solo la ruta`);
  }

  const raw = parsed['checks'];
  if (!Array.isArray(raw)) {
    return unreadable(path, `el historial ${path} no trae una lista "checks": se informa solo la ruta`);
  }

  const checks: SessionCheckEntry[] = [];
  let dropped = 0;
  for (const item of raw) {
    const entry = entryFrom(item);
    if (entry === null) dropped += 1;
    else checks.push(entry);
  }

  const problem =
    dropped === 0 ? null : `${dropped} entrada(s) del historial ${path} no se pudieron leer y se omitieron`;

  return {
    checks,
    problem,
    // Every stored entry unreadable is, in effect, a file with nothing usable in
    // it: the console says "unparseable" and names the path instead of claiming
    // that no check ever ran.
    unparseable: checks.length === 0 && dropped > 0,
  };
}

export interface SessionCheckAppend {
  /** The history as it now stands, newest first, capped. */
  entries: SessionCheckEntry[];
  /** Everything that went wrong while reading or writing; nothing was thrown. */
  problems: string[];
}

/** Prepends the new entry, caps the list and rewrites the file. Failures are reported. */
export async function appendSessionCheck(
  path: string,
  entry: SessionCheckEntry,
  limit: number = SESSION_CHECK_HISTORY_LIMIT,
): Promise<SessionCheckAppend> {
  const problems: string[] = [];
  const existing = await readSessionCheckHistory(path);
  if (existing.problem !== null) problems.push(existing.problem);

  const entries = [entry, ...existing.checks].slice(0, limit);
  const history: SessionCheckHistory = {
    version: 1,
    updatedAt: new Date().toISOString(),
    checks: entries,
  };

  try {
    const parent = parentOf(path);
    if (parent !== '') await mkdir(parent, { recursive: true });
    await writeFile(path, `${JSON.stringify(history, null, 2)}\n`, { encoding: 'utf8' });
  } catch (error) {
    problems.push(`no se pudo guardar el historial en ${path}: ${messageOf(error)}`);
  }

  return { entries, problems };
}

/**
 * Runs the check once and records it. The console keeps working when the write
 * fails: the entry is still returned and the failure is a visible warning.
 */
export async function runAndRecordSessionCheck(
  path: string,
  runner: SessionCheckRunner,
): Promise<{ entry: SessionCheckEntry; problems: string[] }> {
  const runAt = new Date().toISOString();

  let run: SessionCheckRun;
  try {
    run = await runner();
  } catch (error) {
    run = {
      exitCode: null,
      stdout: '',
      stderr: '',
      spawnProblem: `el chequeo falló: ${messageOf(error)}`,
      durationMs: 0,
    };
  }

  const entry = entryOfRun(run, runAt);
  const appended = await appendSessionCheck(path, entry);
  return { entry, problems: appended.problems };
}
