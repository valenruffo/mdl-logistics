/**
 * The maintenance console's readers: runtime, session, runs, artifacts, errors
 * and the derived health line.
 *
 * Three rules shape this module:
 *
 * 1. **Every read is tolerant.** A missing directory, an unreadable record or a
 *    corrupt JSON file becomes a `Warning` that the page renders. Nothing here
 *    throws at the page and nothing here silently shows a zero instead of the
 *    problem it could not read.
 * 2. **Nothing is interpreted.** Every string the console shows is either a file
 *    name, a path, a value read verbatim from a record, or a sentence this module
 *    derived from those values by an explicit rule. There is no model in this
 *    path and no free-text summary of anything.
 * 3. **No secret is read.** The session file and the Chromium profile are only
 *    `stat`ed (size and mtime); their contents are a credential (R15). The store
 *    origin is shown as a host, and it cannot carry userinfo because
 *    `resolveStoreOrigin()` refuses it.
 *
 * Run records are read here with a tolerant reader instead of
 * `loadRunRecords()`, which is deliberately fail-closed for the *gate*: the gate
 * must refuse to run on an unreadable record, while the console must show it.
 */
import { accessSync, constants, statSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';

import { humanResolutionHint } from '../cli/gates';
import { readEnv, readEnvBool } from '../executor/env';
import { messageOf } from '../executor/errors';
import { STORE_ORIGIN_VARIABLE, resolveStoreOrigin } from '../executor/panel';
import {
  baseNameOf,
  hrefForFile,
  isAbsolutePath,
  joinPath,
  relativeSegments,
} from './paths';
import {
  SESSION_CHECK_HISTORY_LIMIT,
  SESSION_CHECK_HISTORY_PATH,
  readSessionCheckHistory,
  runAndRecordSessionCheck,
  runSessionCheckScript,
  type SessionCheckEntry,
  type SessionCheckRunner,
} from './sessionCheck';

/** The artifacts tree, relative to the working directory. */
export const ARTIFACTS_DIR = 'artifacts';

/** How many run records are rendered. A cap, announced, never a silent truncation. */
export const CONSOLE_MAX_RUNS = 100;

/** The executor's own report files. Their failures are the "Errors" section. */
export const REPORT_FILE_NAMES: readonly string[] = ['dry-run.json', 'create-run.json', 'failure.json'];

// ------------------------------------------------------------------- shapes

export type Level = 'ok' | 'warn' | 'bad';

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
 * `stat` only. The file's *contents* are the store session and are never read,
 * parsed, logged or rendered.
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

export interface SessionSection {
  file: SessionFileRead;
  /** Newest first, capped at `limit`. */
  checks: SessionCheckEntry[];
  lastCheck: SessionCheckEntry | null;
  limit: number;
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

  const checks = history.checks.slice(0, SESSION_CHECK_HISTORY_LIMIT);

  return {
    file,
    checks,
    lastCheck: checks[0] ?? null,
    limit: SESSION_CHECK_HISTORY_LIMIT,
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
  /** What the panel showed for the cost, verbatim, or `null`. */
  costText: string | null;
  /** Artifact directory, relative to the artifacts root; `null` when unknown. */
  artifactDir: string | null;
  artifactHref: string | null;
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

function costTextOf(outcome: Record<string, unknown>): string | null {
  const cost = recordOf(outcome, 'costShown');
  if (cost === null) return null;

  const parts: string[] = [];
  const summary = textOf(cost, 'summaryModality');
  const detail = textOf(cost, 'detailShipmentData');
  if (summary !== null && summary.trim() !== '') parts.push(`resumen: ${summary}`);
  if (detail !== null && detail.trim() !== '') parts.push(`detalle: ${detail}`);
  return parts.length === 0 ? null : parts.join(' · ');
}

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
  let parsed: Record<string, unknown>;
  try {
    const text = await readFile(joinPath(deps.recordDir, [name]), { encoding: 'utf8' });
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) {
      problems.push('el registro no es un objeto JSON');
      return null;
    }
    parsed = value;
  } catch (error) {
    problems.push(`no se pudo leer el registro: ${messageOf(error)}`);
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
    costText: null,
    artifactDir: null,
    artifactHref: null,
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

  let parsed: Record<string, unknown>;
  try {
    const text = await readFile(path, { encoding: 'utf8' });
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) {
      row.problems.push('el desenlace no es un objeto JSON: se trata como no resuelto');
      return;
    }
    parsed = value;
  } catch (error) {
    row.problems.push(`el desenlace no se pudo leer y se trata como no resuelto: ${messageOf(error)}`);
    return;
  }

  const status = textOf(parsed, 'status');
  if (status === null || !OUTCOME_STATUSES.includes(status as RecordedOutcomeStatus)) {
    row.problems.push(
      `el desenlace trae un status que no se puede usar (${JSON.stringify(parsed['status'] ?? null)}): se trata como no resuelto`,
    );
    return;
  }

  row.outcome = status as RecordedOutcomeStatus;
  row.outcomeFinishedAt = textOf(parsed, 'finishedAt');
  row.shipmentId = textOf(parsed, 'shipmentId');
  row.costText = costTextOf(parsed);

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
        const segments = relativeSegments(recorded.dir);
        raw.row.artifactHref = segments === null ? null : hrefForFile(segments);
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
  href: string;
}

export interface RunArtifacts {
  runId: string;
  /** Relative to the artifacts root; `null` when the run did not record one. */
  dir: string | null;
  href: string | null;
  files: ArtifactFile[];
  totalBytes: number;
  problems: string[];
}

export interface ArtifactsSection {
  /** One entry per run, in the same order as the runs section. */
  runs: RunArtifacts[];
  warnings: Warning[];
}

async function readArtifacts(deps: ConsoleDeps, rows: readonly RunRow[]): Promise<ArtifactsSection> {
  const warnings: Warning[] = [];
  const runs: RunArtifacts[] = [];

  for (const row of rows) {
    if (row.artifactDir === null) {
      runs.push({
        runId: row.runId,
        dir: null,
        href: null,
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
        href: null,
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
      runs.push({ runId: row.runId, dir: row.artifactDir, href: hrefForFile(segments), files: [], totalBytes: 0, problems: [message] });
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
      files.push({ name, sizeBytes: stats.size, href: hrefForFile([...segments, name]) });
      totalBytes += stats.size;
    }

    runs.push({
      runId: row.runId,
      dir: row.artifactDir,
      href: hrefForFile(segments),
      files,
      totalBytes,
      problems,
    });
  }

  return { runs, warnings };
}

// ------------------------------------------------------------------- errors

export interface FailedCheck {
  /** Which field of the report failed, as it is named in the file. */
  check: string;
  /** Its value, verbatim. */
  detail: string;
}

export interface FailureReport {
  /** Repository-relative path of the report file. */
  path: string;
  href: string;
  kind: string;
  mode: string | null;
  finishedAt: string | null;
  /** The failing structural checks, verbatim. */
  checks: FailedCheck[];
  /** The report's own message field(s), verbatim; `null` when it carried none. */
  message: string | null;
  /** The report file's modification time, ISO. */
  recordedAt: string;
}

export interface ErrorsSection {
  latest: FailureReport | null;
  warnings: Warning[];
}

function stringListOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const parts: string[] = [];
  for (const item of value) if (typeof item === 'string') parts.push(item);
  return parts;
}

function failedChecksOf(source: Record<string, unknown>): FailedCheck[] {
  const checks: FailedCheck[] = [];

  stringListOf(source['mismatches']).forEach((detail, index) => {
    checks.push({ check: `mismatches[${index}]`, detail });
  });

  if (source['formMatchesApproval'] === false) {
    checks.push({ check: 'formMatchesApproval', detail: 'false' });
  }
  if (source['outcome'] === 'unknown') {
    checks.push({ check: 'outcome', detail: 'unknown' });
  }
  const status = textOf(source, 'status');
  if (status === 'failed' || status === 'error') {
    checks.push({ check: 'status', detail: status });
  }

  const reconciliation = recordOf(source, 'reconciliation');
  if (reconciliation !== null) {
    const interpretation = textOf(reconciliation, 'interpretation');
    if (interpretation !== null) checks.push({ check: 'reconciliation.interpretation', detail: interpretation });
  }

  return checks;
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

async function readErrors(deps: ConsoleDeps): Promise<ErrorsSection> {
  const warnings: Warning[] = [];
  const candidates = await reportCandidates(deps, warnings);
  const failures: FailureReport[] = [];

  for (const candidate of candidates) {
    let parsed: Record<string, unknown>;
    try {
      const text = await readFile(candidate.file, { encoding: 'utf8' });
      const value: unknown = JSON.parse(text);
      if (!isRecord(value)) {
        warnings.push({ source: candidate.file, message: 'el informe no es un objeto JSON' });
        continue;
      }
      parsed = value;
    } catch (error) {
      warnings.push({ source: candidate.file, message: `el informe no se pudo leer: ${messageOf(error)}` });
      continue;
    }

    const checks = failedChecksOf(parsed);
    if (checks.length === 0) continue;

    failures.push({
      path: candidate.segments.join('/'),
      href: hrefForFile(candidate.segments),
      kind: baseNameOf(candidate.segments.join('/')),
      mode: textOf(parsed, 'mode'),
      finishedAt: textOf(parsed, 'finishedAt'),
      checks,
      message:
        textOf(parsed, 'message') ??
        textOf(parsed, 'reason') ??
        textOf(parsed, 'failure') ??
        textOf(parsed, 'error'),
      recordedAt: candidate.recordedAt,
    });
  }

  failures.sort((left, right) => right.recordedAt.localeCompare(left.recordedAt));

  return { latest: failures[0] ?? null, warnings };
}

// ------------------------------------------------------------------- health

export interface HealthFact {
  key: string;
  label: string;
  level: Level;
  detail: string;
}

export interface HealthLine {
  level: Level;
  canWork: boolean;
  /** One line. Derived from `facts`, never written by hand. */
  line: string;
  facts: HealthFact[];
}

export interface HealthInput {
  lastCheck: SessionCheckEntry | null;
  unresolvedRunIds: readonly string[];
  artifactsWritable: boolean;
  artifactsProblem: string | null;
  artifactsDir: string;
}

function exitText(entry: SessionCheckEntry): string {
  return entry.exitCode === null ? 'sin código de salida' : `código ${entry.exitCode}`;
}

/**
 * The health line. Three facts, each derived: the session as the **last recorded
 * check** saw it, whether any run record is still unresolved (that is what blocks
 * the create path), and whether the artifacts directory can be written.
 *
 * "Able to work" requires all three to be ok. A session nobody has checked yet is
 * a `warn`, not a `yes`: this line never claims what it has not read.
 */
export function deriveHealth(input: HealthInput): HealthLine {
  const sessionFact: HealthFact =
    input.lastCheck === null
      ? {
          key: 'session',
          label: 'sesión',
          level: 'warn',
          detail: 'no hay ningún chequeo de sesión registrado: el estado de la sesión no se puede leer',
        }
      : input.lastCheck.result === 'usable'
        ? {
            key: 'session',
            label: 'sesión',
            level: 'ok',
            detail: `el chequeo del ${input.lastCheck.runAt} (${exitText(input.lastCheck)}) la dio por utilizable`,
          }
        : {
            key: 'session',
            label: 'sesión',
            level: 'bad',
            detail: `el chequeo del ${input.lastCheck.runAt} terminó con ${exitText(input.lastCheck)} (${input.lastCheck.result}): ${input.lastCheck.message}`,
          };

  const attemptFact: HealthFact =
    input.unresolvedRunIds.length === 0
      ? {
          key: 'attempts',
          label: 'intentos abiertos',
          level: 'ok',
          detail: 'ningún registro de ejecución quedó sin desenlace',
        }
      : {
          key: 'attempts',
          label: 'intentos abiertos',
          level: 'bad',
          detail: `${input.unresolvedRunIds.length} registro(s) sin desenlace bloquean la creación: ${input.unresolvedRunIds.join(', ')}`,
        };

  const artifactFact: HealthFact = input.artifactsWritable
    ? {
        key: 'artifacts',
        label: 'artefactos',
        level: 'ok',
        detail: `se puede escribir en ${input.artifactsDir}`,
      }
    : {
        key: 'artifacts',
        label: 'artefactos',
        level: 'bad',
        detail: input.artifactsProblem ?? `${input.artifactsDir} no se puede escribir`,
      };

  const facts = [sessionFact, attemptFact, artifactFact];
  const bad = facts.filter((fact) => fact.level === 'bad');
  const warn = facts.filter((fact) => fact.level === 'warn');
  const level: Level = bad.length > 0 ? 'bad' : warn.length > 0 ? 'warn' : 'ok';

  const line =
    level === 'ok'
      ? 'Sí: la sesión está utilizable, ningún intento quedó abierto y los artefactos se pueden escribir.'
      : level === 'bad'
        ? `No: ${bad.map((fact) => `${fact.label} — ${fact.detail}`).join('; ')}`
        : `No se puede afirmar que el agente pueda trabajar: ${warn.map((fact) => `${fact.label} — ${fact.detail}`).join('; ')}`;

  return { level, canWork: level === 'ok', line, facts };
}

interface WritableProbe {
  writable: boolean;
  problem: string | null;
  absolute: string;
}

/**
 * Derives whether the artifacts tree is writable. `mkdir` is idempotent and is
 * the only write the console performs: a directory a run will need anyway, so
 * the derivation reports what a run would find instead of guessing from a parent.
 */
async function probeArtifacts(deps: ConsoleDeps): Promise<WritableProbe> {
  const absolute = absolutePath(deps, deps.artifactsDir);

  try {
    await mkdir(absolute, { recursive: true });
  } catch (error) {
    return { writable: false, problem: `no se pudo crear ${absolute}: ${messageOf(error)}`, absolute };
  }

  try {
    if (!statSync(absolute).isDirectory()) {
      return { writable: false, problem: `${absolute} no es un directorio`, absolute };
    }
    accessSync(absolute, constants.W_OK);
    return { writable: true, problem: null, absolute };
  } catch (error) {
    return { writable: false, problem: `no se puede escribir en ${absolute}: ${messageOf(error)}`, absolute };
  }
}

// ---------------------------------------------------------------- aggregate

export interface ConsoleSnapshot {
  status: 'ok';
  readAt: string;
  health: HealthLine;
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
  const probe = await probeArtifacts(deps);

  const health = deriveHealth({
    lastCheck: session.lastCheck,
    unresolvedRunIds: runs.rows.filter((row) => row.unresolved).map((row) => row.runId),
    artifactsWritable: probe.writable,
    artifactsProblem: probe.problem,
    artifactsDir: probe.absolute,
  });

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
    health,
    runtime,
    session,
    runs,
    artifacts,
    errors,
    warnings,
  };
}

export interface SessionCheckCompleted {
  check: SessionCheckEntry;
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
  return { check: result.entry, problems: result.problems, snapshot };
}
