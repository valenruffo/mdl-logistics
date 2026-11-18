/**
 * The maintenance console's readers: runtime, session, runs, artifacts and errors.
 *
 * Three rules shape this module:
 *
 * 1. **Every read is tolerant.** A missing directory, an unreadable record or a
 *    corrupt JSON file becomes a `Warning` that the page renders. Nothing here
 *    throws at the page and nothing here silently shows a zero instead of the
 *    problem it could not read.
 * 2. **Nothing free-text crosses the HTTP boundary.** Every string the console
 *    shows is either a file name, a path, a value the console derived from a
 *    record by an explicit rule, or a sentence this module wrote. Executor
 *    reports are read only for *structural* facts: a report's message,
 *    mismatches, reconciliation, journey readback and card text can quote the
 *    recipient, so they are never copied into the snapshot (see
 *    `FAILED_CHECKS` and the no-artifact-over-HTTP rule in `server.ts`). The
 *    session-check history is projected the same way: only its closed facts
 *    (result, exit code, timestamp, duration) reach the snapshot, because the
 *    check prints what it saw on the panel. There is no model in this path and
 *    no free-text summary of anything.
 * 3. **No secret is read.** The session file and the Chromium profile are only
 *    `stat`ed (size and mtime) — with one exception, `readSessionExpiry()`: it
 *    opens the storageState file to read the `expires` number of the
 *    `admn_session` entry and nothing else, because when the panel session dies
 *    is an operator fact and not a credential. No cookie value, no other cookie,
 *    no `origins` entry, and no byte of the file is ever logged, rendered or
 *    serialised. The store origin is shown as a host, and it cannot carry
 *    userinfo because `resolveStoreOrigin()` refuses it.
 *
 * Run records are read here with a tolerant reader instead of
 * `loadRunRecords()`, which is deliberately fail-closed for the *gate*: the gate
 * must refuse to run on an unreadable record, while the console must show it.
 */
import { statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { humanResolutionHint } from '../cli/gates';
import { readEnv, readEnvBool } from '../executor/env';
import { messageOf } from '../executor/errors';
import { STORE_ORIGIN_VARIABLE, resolveStoreOrigin } from '../executor/panel';
import {
  baseNameOf,
  isAbsolutePath,
  joinPath,
  relativeSegments,
} from './paths';
import {
  SESSION_CHECK_HISTORY_LIMIT,
  SESSION_CHECK_HISTORY_PATH,
  factOfCheck,
  readSessionCheckHistory,
  runAndRecordSessionCheck,
  runSessionCheckScript,
  type SessionCheckFact,
  type SessionCheckRunner,
} from './sessionCheck';

/** The artifacts tree, relative to the working directory. */
export const ARTIFACTS_DIR = 'artifacts';

/** How many run records are rendered. A cap, announced, never a silent truncation. */
export const CONSOLE_MAX_RUNS = 100;

/** The executor's own report files. Their failures are the "Errors" section. */
export const REPORT_FILE_NAMES: readonly string[] = ['dry-run.json', 'create-run.json', 'failure.json'];

// ------------------------------------------------------------------- shapes

/** Something the page could not read. Rendered as a visible warning. */
export interface Warning {
  source: string;
  message: string;
}

export interface ProcessInfo {
  pid: number;
  nodeVersion: string;
  uptimeSeconds: number;
  platform: string;
  cwd: string;
}

/** The facts the console reads from the process it runs in. */
export function readProcessInfo(): ProcessInfo {
  return {
    pid: process.pid,
    nodeVersion: process.version,
    uptimeSeconds: Math.round(process.uptime()),
    platform: process.platform,
    cwd: process.cwd(),
  };
}

export interface ConsoleDeps {
  recordDir: string;
  artifactsDir: string;
  sessionCheckHistoryPath: string;
  sessionCheckRunner: SessionCheckRunner;
  processInfo: ProcessInfo;
}

export interface ConsoleOverrides {
  artifactsDir?: string;
  sessionCheckHistoryPath?: string;
  sessionCheckRunner?: SessionCheckRunner;
  processInfo?: ProcessInfo;
}

/** Fills every console dependency with the repository's own default. */
export function resolveConsoleDeps(input: ConsoleOverrides & { recordDir: string }): ConsoleDeps {
  return {
    recordDir: input.recordDir,
    artifactsDir: input.artifactsDir ?? ARTIFACTS_DIR,
    sessionCheckHistoryPath: input.sessionCheckHistoryPath ?? SESSION_CHECK_HISTORY_PATH,
    sessionCheckRunner: input.sessionCheckRunner ?? runSessionCheckScript,
    processInfo: input.processInfo ?? readProcessInfo(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function missingFile(error: unknown): boolean {
  return isRecord(error) && (error['code'] === 'ENOENT' || error['code'] === 'ENOTDIR');
}

function textOf(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' ? value : null;
}

function recordOf(source: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = source[key];
  return isRecord(value) ? value : null;
}

function shortHash(value: string | null): string | null {
  if (value === null || value.trim() === '') return null;
  return value.slice(0, 12);
}

/** Absolute form of a path that may be relative to the working directory. */
function absolutePath(deps: ConsoleDeps, target: string): string {
  if (isAbsolutePath(target)) return target;
  return `${deps.processInfo.cwd}/${target}`;
}

// ------------------------------------------------------------------ runtime

export type SessionMode = 'storage-state' | 'persistent-profile' | 'unresolved';

/** The session switches, read through the existing env layer. */
export interface SessionLayer {
  mode: SessionMode;
  /** Human label naming the source: the storageState file, or the profile. */
  source: string;
  path: string | null;
  headless: boolean | null;
  problem: string | null;
}

/**
 * Resolves the session switches with `resolveSessionConfig()`, imported lazily so
 * the page never loads Playwright just to print this panel. A refusal (an
 * unusable switch, a missing session file) is data: it becomes a problem string.
 */
export async function readSessionLayer(): Promise<SessionLayer> {
  let headless: boolean | null = null;
  let problem: string | null = null;

  try {
    const session = await import('../executor/session');

    try {
      headless = readEnvBool(session.HEADLESS_VARIABLE, false);
    } catch (error) {
      problem = messageOf(error);
    }

    try {
      const config = session.resolveSessionConfig();
      return {
        mode: config.mode,
        source: config.mode === 'storage-state' ? `${session.STORAGE_STATE_VARIABLE}` : 'perfil persistente de Chromium',
        path: config.mode === 'storage-state' ? config.storageStatePath : config.profileDir,
        headless: config.headless,
        problem,
      };
    } catch (error) {
      const reason = messageOf(error);
      problem = problem === null ? reason : `${problem} · ${reason}`;

      // The path is still worth showing: it is where the operator must look.
      const storageStatePath = readEnv(session.STORAGE_STATE_VARIABLE);
      if (storageStatePath !== undefined) {
        return {
          mode: 'storage-state',
          source: `${session.STORAGE_STATE_VARIABLE}`,
          path: storageStatePath,
          headless,
          problem,
        };
      }
      return { mode: 'unresolved', source: '(sin resolver)', path: null, headless, problem };
    }
  } catch (error) {
    return {
      mode: 'unresolved',
      source: '(sin resolver)',
      path: null,
      headless,
      problem: `el módulo de sesión no se pudo cargar: ${messageOf(error)}`,
    };
  }
}

export interface RuntimeInfo {
  pid: number;
  nodeVersion: string;
  platform: string;
  uptimeSeconds: number;
  startedAt: string;
  /** Host only: never a credential, and the origin cannot carry userinfo. */
  storeHost: string | null;
  storeVariable: string;
  storeProblem: string | null;
  sessionMode: SessionMode;
  sessionSource: string;
  /** The storageState file or the profile directory, as configured. */
  sessionPath: string | null;
  headless: boolean | null;
  headlessProblem: string | null;
  artifactsDir: string;
  artifactsDirAbsolute: string;
  recordDir: string;
  recordDirAbsolute: string;
  cwd: string;
  warnings: Warning[];
}

async function readRuntime(deps: ConsoleDeps, layer: SessionLayer): Promise<RuntimeInfo> {
  const warnings: Warning[] = [];

  let storeHost: string | null = null;
  let storeProblem: string | null = null;
  try {
    storeHost = resolveStoreOrigin().replace(/^https:\/\//, '');
  } catch (error) {
    storeProblem = messageOf(error);
    warnings.push({ source: STORE_ORIGIN_VARIABLE, message: storeProblem });
  }

  if (layer.problem !== null) {
    warnings.push({ source: 'sesión', message: layer.problem });
  }

  return {
    pid: deps.processInfo.pid,
    nodeVersion: deps.processInfo.nodeVersion,
    platform: deps.processInfo.platform,
    uptimeSeconds: deps.processInfo.uptimeSeconds,
    startedAt: new Date(Date.now() - deps.processInfo.uptimeSeconds * 1_000).toISOString(),
    storeHost,
    storeVariable: STORE_ORIGIN_VARIABLE,
    storeProblem,
    sessionMode: layer.mode,
    sessionSource: layer.source,
    sessionPath: layer.path,
    headless: layer.headless,
    headlessProblem: layer.problem === null || layer.headless !== null ? null : layer.problem,
    artifactsDir: deps.artifactsDir,
    artifactsDirAbsolute: absolutePath(deps, deps.artifactsDir),
    recordDir: deps.recordDir,
    recordDirAbsolute: absolutePath(deps, deps.recordDir),
    cwd: deps.processInfo.cwd,
    warnings,
  };
}

// ------------------------------------------------------------------ session

export interface SessionFileRead {
  mode: SessionMode;
  source: string;
  path: string | null;
  exists: boolean;
  isFile: boolean;
  sizeBytes: number | null;
  modifiedAt: string | null;
  problems: string[];
}

/**
 * `stat` only. The file's *contents* are the store session: apart from the one
 * `expires` number `readSessionExpiry()` takes, no field is read, parsed, logged
 * or rendered.
 */
function readSessionFile(layer: SessionLayer): SessionFileRead {
  const problems: string[] = [];
  const file: SessionFileRead = {
    mode: layer.mode,
    source: layer.source,
    path: layer.path,
    exists: false,
    isFile: false,
    sizeBytes: null,
    modifiedAt: null,
    problems,
  };

  if (layer.path === null) {
    problems.push('la configuración no dice de dónde sale la sesión');
    return file;
  }

  try {
    const stats = statSync(layer.path);
    file.exists = true;
    file.isFile = stats.isFile();
    file.sizeBytes = stats.size;
    file.modifiedAt = new Date(stats.mtimeMs).toISOString();
    if (!stats.isFile() && layer.mode === 'storage-state') {
      problems.push(`${layer.path} no es un archivo: la sesión transferida debe ser el archivo storageState`);
    }
  } catch (error) {
    problems.push(
      missingFile(error)
        ? `el archivo no existe: ${layer.path}`
        : `no se pudo leer ${layer.path}: ${messageOf(error)}`,
    );
  }

  if (layer.problem !== null) problems.push(layer.problem);
  return file;
}

/** The store's admin session cookie. Only its `expires` is ever read. */
export const SESSION_COOKIE_NAME = 'admn_session';

/** From how many days left the rail marks the expiry, so the operator acts early. */
export const EXPIRY_SOON_DAYS = 3;

const DAY_MS = 86_400_000;

/**
 * When the panel session dies, as the rail says it: an instant and a day count.
 *
 * `daysRemaining` is `null` whenever the answer is not known — no storageState
 * file, no such cookie, or a cookie with no expiry (a session cookie, `-1`) —
 * so the page can say `vence: desconocido` instead of inventing a date.
 */
export interface SessionExpiry {
  /** The cookie's own expiry, ISO-8601 UTC, or `null` when unknown. */
  expiresAt: string | null;
  /** Whole days left, floored at zero. `null` when unknown. */
  daysRemaining: number | null;
  /** True when `daysRemaining` is `EXPIRY_SOON_DAYS` or less: the rail marks it. */
  soon: boolean;
}

const UNKNOWN_EXPIRY: SessionExpiry = { expiresAt: null, daysRemaining: null, soon: false };

/**
 * The expiry of `admn_session`, out of a parsed storageState `cookies` array.
 *
 * Playwright writes `expires` as **seconds** since the epoch and `-1` for a
 * cookie that dies with the browser. Anything that is not a positive finite
 * number is not an expiry, so it is reported as unknown rather than guessed.
 * The cookie's `value` is not even looked at, which is what keeps this safe.
 */
export function expiryOfCookies(cookies: unknown, now: number): SessionExpiry {
  if (!Array.isArray(cookies)) return UNKNOWN_EXPIRY;

  for (const item of cookies) {
    if (!isRecord(item) || item['name'] !== SESSION_COOKIE_NAME) continue;

    const expires = item['expires'];
    if (typeof expires !== 'number' || !Number.isFinite(expires) || expires <= 0) return UNKNOWN_EXPIRY;

    const expiresAtMs = expires * 1_000;
    const daysRemaining = Math.max(0, Math.floor((expiresAtMs - now) / DAY_MS));
    return {
      expiresAt: new Date(expiresAtMs).toISOString(),
      daysRemaining,
      soon: daysRemaining <= EXPIRY_SOON_DAYS,
    };
  }

  return UNKNOWN_EXPIRY;
}

/**
 * Reads the storageState file for **one field of one cookie**: the `expires` of
 * `admn_session`.
 *
 * Why this is not a credential read: `expires` is the instant the panel stops
 * accepting the session. No value, no other cookie and no `origins` entry is
 * touched, and the only thing that leaves this function is that instant and a
 * day count. A file that is missing, unreadable or not JSON is `desconocido`,
 * and the parse failure is never quoted back — `JSON.parse` prints the bytes it
 * choked on, and those bytes are the session.
 *
 * The profile mode has no readable cookie: Chromium keeps it inside its own
 * encrypted store, so the answer there is `desconocido` too.
 */
async function readSessionExpiry(layer: SessionLayer, now: number): Promise<SessionExpiry> {
  if (layer.mode !== 'storage-state' || layer.path === null) return UNKNOWN_EXPIRY;

  let text: string;
  try {
    text = await readFile(layer.path, { encoding: 'utf8' });
  } catch {
    return UNKNOWN_EXPIRY;
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return UNKNOWN_EXPIRY;
    return expiryOfCookies(parsed['cookies'], now);
  } catch {
    return UNKNOWN_EXPIRY;
  }
}

/**
 * The check history as the HTTP surface may describe it: where it lives, and
 * whether the file could be used at all.
 *
 * `unparseable` is a fact about the **file**, not about a check: the console says
 * "unparseable" and names the path, and never an excerpt — the file holds the
 * check's own stdout.
 */
export interface SessionCheckHistoryFact {
  /** The history file, as configured (`artifacts/ui/session-checks.json` by default). */
  path: string;
  /** True when the file exists but yields no usable entry: only `path` is reportable. */
  unparseable: boolean;
}

export interface SessionSection {
  file: SessionFileRead;
  /** Newest first, capped at `limit`. Closed facts only: no script text. */
  checks: SessionCheckFact[];
  lastCheck: SessionCheckFact | null;
  limit: number;
  /** Where the checks — and the full output — are on disk. */
  history: SessionCheckHistoryFact;
  /** When the panel cookie dies; `null` fields when it cannot be known. */
  expiry: SessionExpiry;
  warnings: Warning[];
}

async function readSessionSection(deps: ConsoleDeps, layer: SessionLayer): Promise<SessionSection> {
  const warnings: Warning[] = [];
  const file = readSessionFile(layer);

  for (const problem of file.problems) {
    if (problem === layer.problem) continue;
    warnings.push({ source: 'sesión', message: problem });
  }

  const history = await readSessionCheckHistory(deps.sessionCheckHistoryPath);
  if (history.problem !== null) {
    warnings.push({ source: deps.sessionCheckHistoryPath, message: history.problem });
  }

  // The stored entries keep the script's output on disk; the snapshot keeps only
  // the four closed facts, so no substring of the check's stdout can be served.
  const checks = history.checks.slice(0, SESSION_CHECK_HISTORY_LIMIT).map(factOfCheck);

  return {
    file,
    checks,
    lastCheck: checks[0] ?? null,
    limit: SESSION_CHECK_HISTORY_LIMIT,
    history: { path: deps.sessionCheckHistoryPath, unparseable: history.unparseable },
    expiry: await readSessionExpiry(layer, Date.now()),
    warnings,
  };
}

// --------------------------------------------------------------------- runs

export type RecordedOutcomeStatus = 'created' | 'unknown' | 'not-created';

export interface RunRow {
  runId: string;
  /** The record's own timestamp, verbatim, or `null` when it did not carry one. */
  recordedAt: string | null;
  messageHashShort: string | null;
  approvalHashShort: string | null;
  /** The record's `status` field, verbatim (`attempted-unresolved`). */
  status: string | null;
  outcome: RecordedOutcomeStatus | null;
  outcomeFinishedAt: string | null;
  /** The `#EM<number>` the panel printed, when the run recorded one. */
  shipmentId: string | null;
  /** Artifact directory, relative to the artifacts root; `null` when unknown. */
  artifactDir: string | null;
  /** True when this record blocks the create path: no outcome, or an unknown one. */
  unresolved: boolean;
  /** The gate's own human-resolution instruction, for an unresolved record. */
  resolution: string | null;
  problems: string[];
}

export interface RunsSection {
  /** Newest first. */
  rows: RunRow[];
  total: number;
  warnings: Warning[];
}

const OUTCOME_STATUSES: readonly RecordedOutcomeStatus[] = ['created', 'unknown', 'not-created'];

/**
 * The artifact directory a recorded report path points at, relative to the
 * artifacts root.
 *
 * Two shapes exist in the records, both produced by hand or by the executor: the
 * path of the report file (`artifacts/executor-x/create-run.json`) and the path of
 * the run's artifact directory (`artifacts/executor-x`). The filesystem decides
 * which one it is; when neither resolves, the console says so instead of inventing
 * a directory.
 */
export interface RecordedArtifactDir {
  /** The directory the record points at, relative to the artifacts root. */
  dir: string;
  /** False when the directory is only named by the record and is not there. */
  exists: boolean;
}

/**
 * The artifact directory a recorded report path points at, relative to the
 * artifacts root.
 *
 * Two shapes exist in the records, both produced by hand or by the executor: the
 * path of the report file (`artifacts/executor-x/create-run.json`) and the path of
 * the run's artifact directory (`artifacts/executor-x`). The filesystem decides
 * which one it is. A directory the record names but that is not on disk is still
 * returned, marked `exists: false`, so the page can say which path is missing
 * instead of showing an empty list.
 */
function artifactDirOf(reportPath: string, artifactsDir: string): RecordedArtifactDir | null {
  const normalizedReport = reportPath.replace(/\\/g, '/');
  const normalizedRoot = artifactsDir.replace(/\\/g, '/').replace(/\/+$/, '');
  const repositoryRoot = ARTIFACTS_DIR;

  let relative: string | null = null;
  if (normalizedReport.startsWith(`${normalizedRoot}/`)) {
    relative = normalizedReport.slice(normalizedRoot.length + 1);
  } else if (normalizedReport.startsWith(`${repositoryRoot}/`)) {
    relative = normalizedReport.slice(repositoryRoot.length + 1);
  }
  if (relative === null) return null;

  const segments = relativeSegments(relative);
  if (segments === null) return null;

  if (isDirectory(joinPath(artifactsDir, segments))) return { dir: segments.join('/'), exists: true };
  if (segments.length < 2) return null;

  // A report file: the directory is what the page lists.
  const dir = segments.slice(0, -1).join('/');
  return { dir, exists: isDirectory(joinPath(artifactsDir, segments.slice(0, -1))) };
}

function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

interface RawRun {
  row: RunRow;
  /** The path the outcome record says its report was written to, when it did. */
  reportPath: string | null;
}

async function readRawRun(deps: ConsoleDeps, name: string, runId: string, problems: string[]): Promise<RawRun | null> {
  let text: string;
  try {
    text = await readFile(joinPath(deps.recordDir, [name]), { encoding: 'utf8' });
  } catch (error) {
    problems.push(`no se pudo leer el registro: ${messageOf(error)}`);
    return null;
  }

  // A record carries the approved payload (name, address, postal code), so a
  // parse failure is reported without the parser's own message: it quotes the
  // bytes it choked on.
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) {
      problems.push('el registro no es un objeto JSON');
      return null;
    }
    parsed = value;
  } catch {
    problems.push('no se pudo leer el registro: el archivo no es JSON válido (no se copia su contenido)');
    return null;
  }

  const row: RunRow = {
    runId: textOf(parsed, 'runId') ?? runId,
    recordedAt: textOf(parsed, 'recordedAt'),
    messageHashShort: shortHash(textOf(parsed, 'messageHash')),
    approvalHashShort: shortHash(textOf(parsed, 'approvalHash')),
    status: textOf(parsed, 'status'),
    outcome: null,
    outcomeFinishedAt: null,
    shipmentId: null,
    artifactDir: null,
    unresolved: true,
    resolution: null,
    problems,
  };

  if (row.messageHashShort === null) problems.push('el registro no trae messageHash');
  if (row.approvalHashShort === null) problems.push('el registro no trae approvalHash');

  return { row, reportPath: null };
}

async function readOutcome(
  deps: ConsoleDeps,
  outcomeName: string,
  raw: RawRun,
): Promise<void> {
  const { row } = raw;
  const path = joinPath(deps.recordDir, [outcomeName]);

  let text: string;
  try {
    text = await readFile(path, { encoding: 'utf8' });
  } catch (error) {
    row.problems.push(`el desenlace no se pudo leer y se trata como no resuelto: ${messageOf(error)}`);
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) {
      row.problems.push('el desenlace no es un objeto JSON: se trata como no resuelto');
      return;
    }
    parsed = value;
  } catch {
    row.problems.push(
      'el desenlace no se pudo leer y se trata como no resuelto: el archivo no es JSON válido (no se copia su contenido)',
    );
    return;
  }

  const status = textOf(parsed, 'status');
  if (status === null || !OUTCOME_STATUSES.includes(status as RecordedOutcomeStatus)) {
    row.problems.push(
      'el desenlace trae un status que no se puede usar: se trata como no resuelto (no se copia el valor)',
    );
    return;
  }

  row.outcome = status as RecordedOutcomeStatus;
  row.outcomeFinishedAt = textOf(parsed, 'finishedAt');
  row.shipmentId = textOf(parsed, 'shipmentId');

  const reportPath = textOf(parsed, 'reportPath');
  raw.reportPath = reportPath === null || reportPath.trim() === '' ? null : reportPath;
}

async function readRuns(deps: ConsoleDeps): Promise<RunsSection> {
  const warnings: Warning[] = [];

  let names: string[];
  try {
    names = (await readdir(deps.recordDir)).sort();
  } catch (error) {
    if (missingFile(error)) {
      warnings.push({
        source: deps.recordDir,
        message: 'el directorio de registros todavía no existe: no hay ningún run registrado',
      });
      return { rows: [], total: 0, warnings };
    }
    warnings.push({
      source: deps.recordDir,
      message: `no se pudo leer el directorio de registros: ${messageOf(error)}`,
    });
    return { rows: [], total: 0, warnings };
  }

  const attemptNames = names.filter((name) => name.endsWith('.json') && !name.endsWith('.outcome.json'));
  const outcomeNames = new Set(names.filter((name) => name.endsWith('.outcome.json')));

  const runs: RawRun[] = [];
  for (const name of attemptNames) {
    const runId = name.slice(0, -'.json'.length);
    const problems: string[] = [];
    const raw = await readRawRun(deps, name, runId, problems);
    if (raw === null) {
      warnings.push({ source: joinPath(deps.recordDir, [name]), message: problems.join(' · ') });
      continue;
    }

    const outcomeName = `${runId}.outcome.json`;
    if (outcomeNames.has(outcomeName)) await readOutcome(deps, outcomeName, raw);

    raw.row.unresolved = raw.row.outcome === null || raw.row.outcome === 'unknown';
    if (raw.row.unresolved) {
      raw.row.resolution = humanResolutionHint(raw.row.runId);
    }

    if (raw.reportPath !== null) {
      const recorded = artifactDirOf(raw.reportPath, deps.artifactsDir);
      if (recorded === null) {
        raw.row.problems.push(
          `el desenlace nombra ${JSON.stringify(raw.reportPath)}, que no es una ruta utilizable bajo el directorio de artefactos`,
        );
      } else {
        raw.row.artifactDir = recorded.dir;
        if (!recorded.exists) {
          raw.row.problems.push(`el directorio de artefactos ${recorded.dir} no existe en disco`);
        }
      }
    } else if (raw.row.outcome === null) {
      raw.row.problems.push(
        'el registro no dice dónde quedaron los artefactos: no hay desenlace escrito',
      );
    } else {
      raw.row.problems.push('el desenlace no nombra un informe del ejecutor');
    }

    runs.push(raw);
  }

  for (const name of outcomeNames) {
    const runId = name.slice(0, -'.outcome.json'.length);
    if (attemptNames.includes(`${runId}.json`)) continue;
    warnings.push({
      source: joinPath(deps.recordDir, [name]),
      message: 'hay un desenlace sin su registro previo: el archivo no corresponde a ningún run leído',
    });
  }

  const rows = runs.map((raw) => raw.row);
  rows.sort((left, right) => {
    const leftKey = left.recordedAt ?? left.runId;
    const rightKey = right.recordedAt ?? right.runId;
    return rightKey.localeCompare(leftKey);
  });

  if (rows.length > CONSOLE_MAX_RUNS) {
    warnings.push({
      source: deps.recordDir,
      message: `se muestran los ${CONSOLE_MAX_RUNS} registros más nuevos de ${rows.length}`,
    });
  }

  return {
    rows: rows.slice(0, CONSOLE_MAX_RUNS),
    total: rows.length,
    warnings,
  };
}

// ---------------------------------------------------------------- artifacts

export interface ArtifactFile {
  name: string;
  sizeBytes: number;
}

export interface RunArtifacts {
  runId: string;
  /** Relative to the artifacts root; `null` when the run did not record one. */
  dir: string | null;
  files: ArtifactFile[];
  totalBytes: number;
  problems: string[];
}

export interface ArtifactsSection {
  /** One entry per run, in the same order as the runs section. */
  runs: RunArtifacts[];
  warnings: Warning[];
}

/**
 * Lists what is on disk, nothing more: file names and sizes per run. There is no
 * href and no content field, because the page must not hand out recipient PII or
 * panel-session material; the operator retrieves the files from the mounted
 * volume over SSH.
 */

async function readArtifacts(deps: ConsoleDeps, rows: readonly RunRow[]): Promise<ArtifactsSection> {
  const warnings: Warning[] = [];
  const runs: RunArtifacts[] = [];

  for (const row of rows) {
    if (row.artifactDir === null) {
      runs.push({
        runId: row.runId,
        dir: null,
        files: [],
        totalBytes: 0,
        problems: ['el registro no nombra un directorio de artefactos'],
      });
      continue;
    }

    const segments = relativeSegments(row.artifactDir);
    if (segments === null) {
      runs.push({
        runId: row.runId,
        dir: row.artifactDir,
        files: [],
        totalBytes: 0,
        problems: [`${JSON.stringify(row.artifactDir)} no es una ruta relativa usable`],
      });
      continue;
    }

    const dirPath = joinPath(deps.artifactsDir, segments);

    let names: string[];
    try {
      names = (await readdir(dirPath)).sort();
    } catch (error) {
      const message = missingFile(error)
        ? `el directorio de artefactos ${row.artifactDir} no existe`
        : `no se pudo leer ${row.artifactDir}: ${messageOf(error)}`;
      warnings.push({ source: row.artifactDir, message });
      runs.push({ runId: row.runId, dir: row.artifactDir, files: [], totalBytes: 0, problems: [message] });
      continue;
    }

    const files: ArtifactFile[] = [];
    const problems: string[] = [];
    let totalBytes = 0;

    for (const name of names) {
      let stats: { size: number; isFile(): boolean };
      try {
        stats = statSync(joinPath(deps.artifactsDir, [...segments, name]));
      } catch (error) {
        problems.push(`no se pudo leer ${name}: ${messageOf(error)}`);
        continue;
      }
      if (!stats.isFile()) continue;
      files.push({ name, sizeBytes: stats.size });
      totalBytes += stats.size;
    }

    runs.push({
      runId: row.runId,
      dir: row.artifactDir,
      files,
      totalBytes,
      problems,
    });
  }

  return { runs, warnings };
}

// ------------------------------------------------------------------- errors

/**
 * The closed vocabulary of structural facts a report can fail.
 *
 * It exists because of *what is on the other side of the boundary*: a report is
 * written from the panel, so its `message`, its `mismatches`, its
 * `reconciliation.interpretation`, its journey readback and its card text can
 * quote the recipient's name, address and phone. Those fields are free text and
 * they never reach the HTTP surface (see `server.ts`: no artifact over HTTP).
 * Only identifiers from this list, the report's kind, a timestamp and the file
 * path do.
 *
 * `label-button` is the executor's third unpaid-label check: "a visible button
 * whose accessible name contains the label wording is present". The identifier
 * deliberately avoids the pay verb, because nothing in `src/ui/` names that
 * action.
 */
export const FAILED_CHECKS = [
  'shipment-id',
  'status-badge',
  'label-button',
  'form-mismatch',
  'form-not-approved',
  'outcome-unknown',
  'status-failed',
  'status-error',
  'reconciliation-unread',
] as const;

export type FailedCheckId = (typeof FAILED_CHECKS)[number];

/** The reports the console names. The same three files `REPORT_FILE_NAMES` lists. */
export const REPORT_KINDS = ['dry-run', 'create-run', 'failure'] as const;

export type ReportKind = (typeof REPORT_KINDS)[number];

/**
 * Report field names mapped onto the vocabulary. A report may name its failing
 * checks (`failedChecks`, `structuralChecks`); only names listed here survive,
 * and an unknown name is counted, never copied.
 */
const CHECK_NAME_ALIASES: ReadonlyMap<string, FailedCheckId> = new Map<string, FailedCheckId>([
  ['shipment-id', 'shipment-id'],
  ['shipmentid', 'shipment-id'],
  ['status-badge', 'status-badge'],
  ['statusbadge', 'status-badge'],
  ['label-button', 'label-button'],
  ['labelbutton', 'label-button'],
  ['buybutton', 'label-button'],
  ['form-mismatch', 'form-mismatch'],
  ['formmismatch', 'form-mismatch'],
  ['form-not-approved', 'form-not-approved'],
  ['formnotapproved', 'form-not-approved'],
  ['outcome-unknown', 'outcome-unknown'],
  ['outcomeunknown', 'outcome-unknown'],
  ['reconciliation-unread', 'reconciliation-unread'],
]);

/**
 * One failing report, reduced to structured facts.
 *
 * There is no `message`, no `mismatch` and no `reconciliation` field: those are
 * exactly the strings that could carry recipient data, and the HTTP surface must
 * not be able to return them even for a report that has them on disk.
 */
export interface FailureReport {
  /** Repository-relative path of the report file. */
  path: string;
  /** Which of the three report files this is, from `REPORT_KINDS`. */
  kind: ReportKind;
  /** The report's own `finishedAt`, kept only when it is an ISO timestamp. */
  finishedAt: string | null;
  /** The report file's modification time, ISO. */
  recordedAt: string;
  /** Closed-vocabulary identifiers only, in `FAILED_CHECKS` order. */
  checks: FailedCheckId[];
  /** How many names the report carried outside the vocabulary (a count, not text). */
  unrecognisedChecks: number;
  /** True when the file could not be reduced to those facts: show the path only. */
  unparseable: boolean;
}

export interface ErrorsSection {
  latest: FailureReport | null;
  warnings: Warning[];
}

/** ISO-8601 UTC, the only shape a report timestamp may have to be shown. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function timestampOf(source: Record<string, unknown>, key: string): string | null {
  const value = textOf(source, key);
  return value !== null && TIMESTAMP.test(value) ? value : null;
}

/** The report kind its file name declares; `null` for a name that is not one. */
function reportKindOf(file: string): ReportKind | null {
  const name = baseNameOf(file);
  const stripped = name.endsWith('.json') ? name.slice(0, -'.json'.length) : name;
  return (REPORT_KINDS as readonly string[]).includes(stripped) ? (stripped as ReportKind) : null;
}

interface ClosedFacts {
  checks: FailedCheckId[];
  unrecognisedChecks: number;
}

/**
 * Reads the report's *structure* and nothing else. Every branch below looks at a
 * boolean, an enum value or the length of an array; the values of the strings in
 * `mismatches` are never read out.
 */
function closedFactsOf(source: Record<string, unknown>): ClosedFacts {
  const found = new Set<FailedCheckId>();
  let unrecognisedChecks = 0;

  const mismatches = source['mismatches'];
  if (Array.isArray(mismatches) && mismatches.length > 0) found.add('form-mismatch');
  if (source['formMatchesApproval'] === false) found.add('form-not-approved');
  if (source['outcome'] === 'unknown') found.add('outcome-unknown');

  const status = textOf(source, 'status');
  if (status === 'failed') found.add('status-failed');
  if (status === 'error') found.add('status-error');
  if (recordOf(source, 'reconciliation') !== null) found.add('reconciliation-unread');

  for (const key of ['failedChecks', 'structuralChecks']) {
    const raw = source[key];
    if (!Array.isArray(raw)) continue;
    for (const item of raw) {
      if (typeof item !== 'string') {
        unrecognisedChecks += 1;
        continue;
      }
      const mapped = CHECK_NAME_ALIASES.get(item.trim().toLowerCase());
      if (mapped === undefined) unrecognisedChecks += 1;
      else found.add(mapped);
    }
  }

  return {
    checks: FAILED_CHECKS.filter((id) => found.has(id)),
    unrecognisedChecks,
  };
}

interface ReportCandidate {
  file: string;
  segments: string[];
  recordedAt: string;
}

async function reportCandidates(deps: ConsoleDeps, warnings: Warning[]): Promise<ReportCandidate[]> {
  const candidates: ReportCandidate[] = [];

  let names: string[];
  try {
    names = (await readdir(deps.artifactsDir)).sort();
  } catch (error) {
    warnings.push({
      source: deps.artifactsDir,
      message: missingFile(error)
        ? 'el directorio de artefactos todavía no existe: no hay informes del ejecutor'
        : `no se pudo leer el directorio de artefactos: ${messageOf(error)}`,
    });
    return candidates;
  }

  const visit = (segments: string[]): void => {
    const stats = statSync(joinPath(deps.artifactsDir, segments));
    if (!stats.isFile()) return;
    candidates.push({
      file: joinPath(deps.artifactsDir, segments),
      segments,
      recordedAt: new Date(stats.mtimeMs).toISOString(),
    });
  };

  for (const name of names) {
    let stats: { isDirectory(): boolean; isFile(): boolean };
    try {
      stats = statSync(joinPath(deps.artifactsDir, [name]));
    } catch (error) {
      warnings.push({ source: joinPath(deps.artifactsDir, [name]), message: `no se pudo leer: ${messageOf(error)}` });
      continue;
    }

    if (stats.isFile()) {
      if (REPORT_FILE_NAMES.includes(name)) {
        try {
          visit([name]);
        } catch (error) {
          warnings.push({ source: joinPath(deps.artifactsDir, [name]), message: `no se pudo leer: ${messageOf(error)}` });
        }
      }
      continue;
    }
    if (!stats.isDirectory()) continue;

    let inner: string[];
    try {
      inner = (await readdir(joinPath(deps.artifactsDir, [name]))).sort();
    } catch (error) {
      warnings.push({
        source: joinPath(deps.artifactsDir, [name]),
        message: `no se pudo leer el directorio de artefactos: ${messageOf(error)}`,
      });
      continue;
    }

    for (const innerName of inner) {
      if (!REPORT_FILE_NAMES.includes(innerName)) continue;
      try {
        visit([name, innerName]);
      } catch (error) {
        warnings.push({
          source: joinPath(deps.artifactsDir, [name, innerName]),
          message: `no se pudo leer: ${messageOf(error)}`,
        });
      }
    }
  }

  return candidates;
}

/**
 * Reads every report file and keeps the newest one that failed something.
 *
 * A report that cannot be reduced to `FAILED_CHECKS` is reported as
 * **unparseable**, by path, and nothing else. That includes a file that is not
 * JSON: a `JSON.parse` error message quotes the beginning of the file it choked
 * on, so the reason is never `messageOf(error)` here — a corrupt report would
 * leak its own first bytes through the warning.
 */
async function readErrors(deps: ConsoleDeps): Promise<ErrorsSection> {
  const warnings: Warning[] = [];
  const candidates = await reportCandidates(deps, warnings);
  const failures: FailureReport[] = [];

  for (const candidate of candidates) {
    const relative = candidate.segments.join('/');
    const kind = reportKindOf(relative);
    if (kind === null) continue;

    const unparseableReport = (): FailureReport => ({
      path: relative,
      kind,
      finishedAt: null,
      recordedAt: candidate.recordedAt,
      checks: [],
      unrecognisedChecks: 0,
      unparseable: true,
    });

    let text: string;
    try {
      text = await readFile(candidate.file, { encoding: 'utf8' });
    } catch (error) {
      warnings.push({ source: relative, message: `el informe no se pudo leer: ${messageOf(error)}` });
      failures.push(unparseableReport());
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      warnings.push({
        source: relative,
        message: 'el informe no es JSON válido: se informa solo la ruta, nunca su contenido',
      });
      failures.push(unparseableReport());
      continue;
    }

    if (!isRecord(parsed)) {
      warnings.push({ source: relative, message: 'el informe no es un objeto JSON: se informa solo la ruta' });
      failures.push(unparseableReport());
      continue;
    }

    const facts = closedFactsOf(parsed);
    if (facts.checks.length === 0 && facts.unrecognisedChecks === 0) {
      // A dry-run or create-run report where every check held is a passing
      // report, not an error. `failure.json` says by its name that it failed.
      if (kind !== 'failure') continue;
      warnings.push({
        source: relative,
        message: 'el informe de fallo no dice qué comprobación estructural falló: se informa solo la ruta',
      });
      failures.push(unparseableReport());
      continue;
    }

    failures.push({
      path: relative,
      kind,
      finishedAt: timestampOf(parsed, 'finishedAt'),
      recordedAt: candidate.recordedAt,
      checks: facts.checks,
      unrecognisedChecks: facts.unrecognisedChecks,
      unparseable: false,
    });
  }

  failures.sort((left, right) => right.recordedAt.localeCompare(left.recordedAt));

  return { latest: failures[0] ?? null, warnings };
}

// ---------------------------------------------------------------- aggregate

export interface ConsoleSnapshot {
  status: 'ok';
  readAt: string;
  runtime: RuntimeInfo;
  session: SessionSection;
  runs: RunsSection;
  artifacts: ArtifactsSection;
  errors: ErrorsSection;
  /** Every section's warnings, stamped with where they came from. */
  warnings: Warning[];
}

/** Reads everything the console shows. Never throws: failures become warnings. */
export async function readConsole(deps: ConsoleDeps): Promise<ConsoleSnapshot> {
  const layer = await readSessionLayer();
  const runtime = await readRuntime(deps, layer);
  const session = await readSessionSection(deps, layer);
  const runs = await readRuns(deps);
  const artifacts = await readArtifacts(deps, runs.rows);
  const errors = await readErrors(deps);

  const warnings: Warning[] = [
    ...runtime.warnings,
    ...session.warnings,
    ...runs.warnings,
    ...artifacts.warnings,
    ...errors.warnings,
  ];

  return {
    status: 'ok',
    readAt: new Date().toISOString(),
    runtime,
    session,
    runs,
    artifacts,
    errors,
    warnings,
  };
}

export interface SessionCheckCompleted {
  /** The check that just ran, as the closed facts the HTTP surface may carry. */
  check: SessionCheckFact;
  /** Warnings raised while recording the check (a failed write, a corrupt history). */
  problems: string[];
  snapshot: ConsoleSnapshot;
}

/**
 * The only action the console performs: run the session check once and record it.
 * Reached only from `POST /api/session-check`, never from a page load.
 */
export async function performSessionCheck(deps: ConsoleDeps): Promise<SessionCheckCompleted> {
  const result = await runAndRecordSessionCheck(deps.sessionCheckHistoryPath, deps.sessionCheckRunner);
  const snapshot = await readConsole(deps);
  return { check: factOfCheck(result.entry), problems: result.problems, snapshot };
}
