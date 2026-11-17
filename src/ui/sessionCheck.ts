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
 * session file and the profile are only `stat`ed elsewhere — never read here:
 * their contents are a credential (R15).
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

/** Cap on the stored output. The full console transcript is not needed to diagnose. */
export const SESSION_CHECK_OUTPUT_LIMIT = 4_000;

/** The one line the console shows, taken from the check's own output. */
const FLAGGED_LINE = /^(ERROR|OK)\s*:/;

export type SessionCheckResult = 'usable' | 'unusable' | 'bad-config' | 'no-browser' | 'error';

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

export interface SessionCheckEntry {
  /** When the attempt started. */
  runAt: string;
  result: SessionCheckResult;
  exitCode: number | null;
  durationMs: number;
  /** The line the check printed, verbatim (`OK: ...` / `ERROR: ...`). */
  message: string;
  /** stdout and stderr joined, truncated. Verbatim. */
  output: string;
  /** Always true: the check opens a browser, and the record says so. */
  opensBrowser: true;
  spawnProblem: string | null;
}

export interface SessionCheckHistory {
  version: 1;
  updatedAt: string;
  checks: SessionCheckEntry[];
}

const RESULTS: readonly SessionCheckResult[] = ['usable', 'unusable', 'bad-config', 'no-browser', 'error'];

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

/** The script's documented exit codes, mapped to what the console shows. */
export function resultOfExitCode(exitCode: number | null): SessionCheckResult {
  switch (exitCode) {
    case 0:
      return 'usable';
    case 1:
      return 'unusable';
    case 2:
      return 'bad-config';
    case 3:
      return 'no-browser';
    default:
      return 'error';
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
    result: run.spawnProblem === null ? resultOfExitCode(run.exitCode) : 'error',
    exitCode: run.exitCode,
    durationMs: run.durationMs,
    message: messageOfRun(run),
    output: outputOf(run),
    opensBrowser: true,
    spawnProblem: run.spawnProblem,
  };
}

/**
 * The real runner: the same script `npm run session-check` calls, started with
 * the Node that runs the UI, in the repository root.
 */
export function runSessionCheckScript(): Promise<SessionCheckRun> {
  const startedAt = Date.now();

  return new Promise<SessionCheckRun>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: unknown;

    const finish = (exitCode: number | null, spawnProblem: string | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, spawnProblem, durationMs: Date.now() - startedAt });
    };

    let child;
    try {
      child = spawn(process.execPath, ['--import', 'tsx', SESSION_CHECK_SCRIPT], {
        cwd: process.cwd(),
        env: process.env,
      });
    } catch (error) {
      finish(null, `no se pudo iniciar el chequeo: ${messageOf(error)}`);
      return;
    }

    timer = setTimeout(() => {
      child.kill();
      finish(null, `el chequeo no terminó en ${SESSION_CHECK_TIMEOUT_MS} ms y se detuvo`);
    }, SESSION_CHECK_TIMEOUT_MS);

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
      finish(null, `no se pudo iniciar el chequeo: ${messageOf(error)}`);
    });
    child.on('close', (code) => {
      finish(code, null);
    });
  });
}

function entryFrom(value: unknown): SessionCheckEntry | null {
  if (!isRecord(value)) return null;

  const runAt = textOrNull(value, 'runAt');
  const result = textOrNull(value, 'result');
  const message = textOrNull(value, 'message');
  if (runAt === null || result === null || message === null) return null;
  if (!RESULTS.includes(result as SessionCheckResult)) return null;

  const exitCode = value['exitCode'];
  const durationMs = value['durationMs'];

  return {
    runAt,
    result: result as SessionCheckResult,
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
}

/**
 * Reads the history tolerantly. A missing file is "no check has run yet"; a
 * corrupt file is a warning the console renders, with the good entries kept.
 */
export async function readSessionCheckHistory(path: string): Promise<SessionCheckHistoryRead> {
  let text: string;
  try {
    text = await readFile(path, { encoding: 'utf8' });
  } catch (error) {
    if (missingFile(error)) return { checks: [], problem: null };
    return { checks: [], problem: `no se pudo leer el historial ${path}: ${messageOf(error)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { checks: [], problem: `el historial ${path} no es JSON válido: ${messageOf(error)}` };
  }

  if (!isRecord(parsed)) return { checks: [], problem: `el historial ${path} no es un objeto JSON` };

  const raw = parsed['checks'];
  if (!Array.isArray(raw)) return { checks: [], problem: `el historial ${path} no trae una lista "checks"` };

  const checks: SessionCheckEntry[] = [];
  let dropped = 0;
  for (const item of raw) {
    const entry = entryFrom(item);
    if (entry === null) dropped += 1;
    else checks.push(entry);
  }

  return {
    checks,
    problem: dropped === 0 ? null : `${dropped} entrada(s) del historial ${path} no se pudieron leer y se omitieron`,
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
