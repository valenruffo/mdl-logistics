/**
 * The persistent in-process shipment queue (v0.4.0).
 *
 * The operator asked to be able to stack creations: "puedo cargar 5 quizás y ya
 * olvidarme y que se vayan haciendo". This module is that queue: a FIFO list of
 * approved submissions persisted on disk, one JSON file per entry, drained by a
 * single worker loop that runs the exact same `runAttempt` path the one-shot run
 * used — same executor paths, same pre-click/post-click outcome contract.
 *
 * The deliberate boundaries:
 *
 * - **No BullMQ, no Redis, no new dependency.** The executor is strictly
 *   sequential (one Chromium, one panel session), so the drain *must* be serial;
 *   a durable in-process FIFO is all the problem needs.
 * - **The gates move to execution time.** Enqueueing only validates the form and
 *   computes the server-side hashes, so the operator can stack while the first
 *   one runs. What prevents a duplicate shipment — an already-created or
 *   unresolved prior attempt for the same message hash — is checked again inside
 *   `runAttempt` when the entry reaches the head of the queue. An entry whose
 *   gates refuse is marked `rechazada` with its reason and is never retried.
 * - **FIFO, no reordering, no priority.** Entries are named
 *   `NNNNNN-<messageHash12>.json`; the numeric prefix is the queue order, and it
 *   is derived from the directory, so the order survives a restart exactly as
 *   it was stacked.
 * - **Restart safety: re-execute, then let the guards protect the click.** An
 *   entry caught mid-run by a dead process stays on disk without an outcome; on
 *   startup it is put back `en-espera` and re-executed. The executor's own
 *   duplicate/unresolved gates make that safe: the run record the crashed
 *   attempt wrote — or the shipment it already created — refuses the second
 *   click (`runAttempt` refuses with a prior-attempt refusal), so a
 *   re-execution can never blindly click `Crear envío` twice. The entry ends
 *   `rechazada` with the record the operator resolves: visible instead of
 *   silent. A crash *before* the pre-click record simply runs fresh.
 * - **One browser owner.** The worker takes the same `browserLock` the routes
 *   take before each entry, so a session check and a queued creation never open
 *   two Chromia. While the lock is held elsewhere the entry stays `en-espera`.
 * - **Closed facts over HTTP.** `snapshot()` projects each entry: state words,
 *   shipment id, duration, one reason line and record paths. The message text,
 *   the form and the approved payload stay in the file on disk, never in the
 *   HTTP surface — the same rule `/api/console` keeps.
 */
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { computeAnyApprovalHash, messageFingerprint } from '../cli/gates';
import { CARRIER_NAME } from '../core/carrier';
import type { AnyShipmentRequest, MessageModality } from '../core/types';
import {
  approvalPayloadFromRequest,
  type ApprovalPayload,
  sucursalApprovalPayloadFromRequest,
  type SucursalApprovalPayload,
} from '../executor/approval';
import { SUCURSAL_CARRIER_NAME } from '../executor/envioNube';
import { messageOf } from '../executor/errors';
import { runAttempt, type ActionDeps, type RunInput, type RunResponse } from './actions';
import { requestFromForm, type FormIssue, type FormValues } from './form';
import { browserLock, type SingleFlightLock } from './lock';

/** Where the queue files live. Fixed, like the run records: `artifacts/queue`. */
export const QUEUE_DIR = 'artifacts/queue';

/**
 * How many entries can sit in the queue waiting or running. The operator asked
 * to stack "cinco quizás"; ten is the comfortable ceiling before the page asks
 * the operator to wait instead of stacking more.
 */
export const MAX_PENDING_ENTRIES = 10;

/** The refill wait of the worker loop when the queue is empty or the lock is busy. */
export const QUEUE_POLL_MS = 1_000;

/**
 * Transient write patience. The entry file is written atomically (temp file
 * plus rename), and on Windows a rename over a file a concurrent reader has
 * open — the page's own `/api/queue` poll, for one — answers with a transient
 * `EPERM` instead of queueing. A short retry burst absorbs it; only a real
 * failure of the volume exhausts it, and that stays a visible problem.
 */
const WRITE_RETRY_ATTEMPTS = 10;
const WRITE_RETRY_MS = 100;

/** How many finished entries the snapshot lists, newest first. */
export const SNAPSHOT_FINISHED_LIMIT = 5;

/** The readable refusal when the operator stacks one entry past the ceiling. */
export const QUEUE_FULL_MESSAGE =
  `la cola de envíos está llena (${MAX_PENDING_ENTRIES} esperando o en proceso): ` +
  'esperá un rato — los que ya cargaste se crean solos, de a uno — y volvé a cargar este mensaje';

/** The state of one entry, in the words the panel shows it. */
export type QueueState =
  | 'en-espera'
  | 'en-proceso'
  | 'creada'
  | 'sin-crear'
  | 'desconocida'
  | 'rechazada'
  | 'fallida';

const PENDING_STATES: readonly QueueState[] = ['en-espera', 'en-proceso'];

/** What the execution of one entry left behind, as closed facts for the page. */
export interface QueueOutcome {
  shipmentId: string | null;
  /** Wall-clock duration of the drained run in ms; `null` when nothing ran to time. */
  durationMs: number | null;
  /** One line: the gate's refusal, the unknown's reason or the failure's error. */
  reason: string | null;
  /** The pre-click record and the outcome record the drained run wrote, if any. */
  recordPath: string | null;
  outcomePath: string | null;
  /** The executor's own report path, as the drained response named it. */
  reportPath: string | null;
  /** For a `not-created` outcome: the pre-click stage the run reached. */
  stage: string | null;
}

/** One queue entry as it is persisted: the whole truth, on disk only. */
export interface QueueEntryFile {
  /** File-format version, so an older reader refuses instead of guessing. */
  version: 1;
  id: string;
  enqueuedAt: string;
  /** The exact message text posted from the page — the duplicate gate's input. */
  message: string;
  /** The values that were on screen, in the form model's own canonical shape. */
  form: FormValues;
  modality: MessageModality;
  messageHash: string;
  /** sha-256 of the payload the page posted, computed server-side like always. */
  approvalHash: string;
  /** The approved payload itself, so the file explains what it approved. */
  payload: ApprovalPayload | SucursalApprovalPayload;
  state: QueueState;
  startedAt: string | null;
  finishedAt: string | null;
  outcome: QueueOutcome | null;
}

/** What `POST /api/run` answers when the entry was accepted. */
export interface EnqueueAccepted {
  ok: true;
  entryId: string;
  /** 1-based position among the entries waiting or running. */
  position: number;
}

export type EnqueueRefused =
  | { ok: false; kind: 'invalid-form'; errors: FormIssue[] }
  | { ok: false; kind: 'queue-full'; reason: string };

export type EnqueueResult = EnqueueAccepted | EnqueueRefused;

/** One entry as `/api/queue` projects it: closed facts, never payload text. */
export interface QueueEntryProjection {
  id: string;
  state: QueueState;
  modality: MessageModality;
  enqueuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  shipmentId: string | null;
  durationMs: number | null;
  reason: string | null;
  recordPath: string | null;
  outcomePath: string | null;
  reportPath: string | null;
  stage: string | null;
}

export interface QueueSnapshot {
  status: 'ok';
  readAt: string;
  /** Panel order: `en-proceso`, then `en espera` oldest first, then finished newest first. */
  entries: QueueEntryProjection[];
  /** Entries waiting or running right now. */
  pending: number;
  limit: number;
  /** Queue files that could not be read or written; paths only, never contents. */
  problems: string[];
}

export interface ShipmentQueueOptions {
  /** Idle refill wait; a test seam. */
  pollIntervalMs?: number;
  /** The browser lock; a test seam. Production shares the routes' `browserLock`. */
  lock?: SingleFlightLock;
}

export function isPendingState(state: QueueState): boolean {
  return PENDING_STATES.includes(state);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error['code'] === 'ENOENT';
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** The queue directory that lives next to a record directory: same tree, same lifetime. */
export function queueDirOf(recordDir: string): string {
  return join(dirname(recordDir), 'queue');
}

const QUEUE_STATES: readonly QueueState[] = [
  'en-espera',
  'en-proceso',
  'creada',
  'sin-crear',
  'desconocida',
  'rechazada',
  'fallida',
];

function isQueueEntry(value: unknown): value is QueueEntryFile {
  if (!isRecord(value)) return false;
  if (value['version'] !== 1) return false;
  if (typeof value['id'] !== 'string' || typeof value['enqueuedAt'] !== 'string') return false;
  if (typeof value['message'] !== 'string' || !isRecord(value['form'])) return false;
  if (typeof value['messageHash'] !== 'string' || typeof value['approvalHash'] !== 'string') return false;
  if (typeof value['modality'] !== 'string') return false;
  if (value['modality'] !== 'domicilio' && value['modality'] !== 'sucursal') return false;
  if (typeof value['state'] !== 'string' || !QUEUE_STATES.includes(value['state'] as QueueState)) return false;
  return true;
}

/** `000123` style prefix, so the lexical order of the file names is the FIFO order. */
function numericPrefix(name: string): number {
  const match = /^\d{6}-/.exec(name);
  return match === null ? 0 : Number(match[0].slice(0, 6));
}

function nextSequence(existingNames: readonly string[]): number {
  let max = 0;
  for (const name of existingNames) max = Math.max(max, numericPrefix(name));
  return max + 1;
}

function pad6(value: number): string {
  return String(Math.min(value, 999_999)).padStart(6, '0');
}

/** One `runAttempt` response mapped onto the queue's own states and facts. */
function outcomeOf(response: RunResponse): { state: QueueState; outcome: QueueOutcome } {
  const paths = response as {
    recordPath?: string | null;
    outcomePath?: string | null;
    reportPath?: string | null;
  };
  const shape: QueueOutcome = {
    shipmentId: null,
    durationMs: null,
    reason: null,
    recordPath: paths.recordPath ?? null,
    outcomePath: paths.outcomePath ?? null,
    reportPath: paths.reportPath ?? null,
    stage: null,
  };

  if (response.status === 'created') {
    return { state: 'creada', outcome: { ...shape, shipmentId: response.shipmentId, durationMs: response.durationMs } };
  }
  if (response.status === 'not-created') {
    return {
      state: 'sin-crear',
      outcome: { ...shape, durationMs: response.durationMs, reason: response.reason, stage: response.stage },
    };
  }
  if (response.status === 'unknown') {
    return { state: 'desconocida', outcome: { ...shape, durationMs: response.durationMs, reason: response.reason } };
  }
  if (response.status === 'refused') {
    return { state: 'rechazada', outcome: { ...shape, reason: `${response.reason} (etapa: ${response.stage})` } };
  }
  if (response.status === 'invalid-form') {
    // Unreachable from the queue: enqueueing validates the same form model
    // before stacking. Belt for the type, nothing more.
    return { state: 'fallida', outcome: { ...shape, reason: 'los valores del envío no arman un payload utilizable' } };
  }
  return { state: 'fallida', outcome: { ...shape, durationMs: response.durationMs, reason: response.reason } };
}

function projectionOf(entry: QueueEntryFile): QueueEntryProjection {
  return {
    id: entry.id,
    state: entry.state,
    modality: entry.modality,
    enqueuedAt: entry.enqueuedAt,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
    shipmentId: entry.outcome?.shipmentId ?? null,
    durationMs: entry.outcome?.durationMs ?? null,
    reason: entry.outcome?.reason ?? null,
    recordPath: entry.outcome?.recordPath ?? null,
    outcomePath: entry.outcome?.outcomePath ?? null,
    reportPath: entry.outcome?.reportPath ?? null,
    stage: entry.outcome?.stage ?? null,
  };
}

function finishedSortKey(projection: QueueEntryProjection): string {
  return projection.finishedAt ?? projection.enqueuedAt;
}

/**
 * The queue and its worker. One instance per `ActionDeps` object — the same
 * identity the server's routes already share (`queueFor`, below) — so the whole
 * process has exactly one queue and one worker loop.
 */
export class ShipmentQueue {
  private readonly deps: ActionDeps;
  private readonly dir: string;
  private readonly pollIntervalMs: number;
  private readonly lock: SingleFlightLock;

  /** Restart recovery runs once, before the first drain, in this process. */
  private recovered = false;
  private stopped = false;
  private loopPromise: Promise<void> | null = null;

  /** Serializes enqueues so the FIFO prefix counter cannot race. */
  private writeChain: Promise<unknown> = Promise.resolve();

  /** The last queue-file problem, surfaced in the snapshot (path only, no bytes). */
  private problem: string | null = null;

  /** The wake hook of the worker's current idle sleep, for an instant first drain. */
  private wakeSleep: (() => void) | null = null;

  constructor(deps: ActionDeps, dir: string, options: ShipmentQueueOptions = {}) {
    this.deps = deps;
    this.dir = dir;
    this.pollIntervalMs = options.pollIntervalMs ?? QUEUE_POLL_MS;
    this.lock = options.lock ?? browserLock;
    this.runLoop();
  }

  // ------------------------------------------------------------ the worker

  private runLoop(): void {
    if (this.loopPromise !== null) return;
    this.loopPromise = this.loop().catch(() => {
      // The loop never throws: every step below is guarded. This catch is the
      // belt that keeps a bug from wedging the queue silently.
    });
  }

  /** Stops the worker; resolves when the entry currently running has been written. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.wakeSleep?.();
    const loop = this.loopPromise;
    this.loopPromise = null;
    if (loop !== null) await loop;
  }

  private async loop(): Promise<void> {
    await this.recover();
    while (!this.stopped) {
      const worked = await this.drainOnce();
      if (this.stopped) break;
      if (!worked) await this.sleep();
    }
  }

  /**
   * Restart recovery. See the module's own comment for the choice it documents:
   * re-execute, with the executor's duplicate/unresolved guards protecting the
   * click from ever happening twice.
   */
  private async recover(): Promise<void> {
    for (const { entry, path } of await this.readEntries()) {
      if (entry.state !== 'en-proceso') continue;
      entry.state = 'en-espera';
      entry.startedAt = null;
      await this.writeEntry(path, entry);
    }
    this.recovered = true;
  }

  /**
   * One serial drain step: take the oldest `en-espera` entry, hold the browser
   * lock, run the full create journey, write the outcome. Returns whether work
   * happened, so the loop can idle when the queue is empty or the lock is busy
   * with a session check.
   */
  private async drainOnce(): Promise<boolean> {
    const entries = await this.readEntries();

    // There is exactly one worker in this process, and it is idle right now —
    // this call runs between drains. So any entry still `en proceso` on disk
    // was left there by an interrupted write, not by a run in flight: recover
    // it the way startup would (re-execute; the executor's own gates then
    // refuse a second click), instead of letting the queue sit on a phantom.
    for (const orphan of entries.filter((candidate) => candidate.entry.state === 'en-proceso')) {
      orphan.entry.state = 'en-espera';
      orphan.entry.startedAt = null;
      await this.persistEntry(orphan.path, orphan.entry);
    }

    const next = entries.find((candidate) => candidate.entry.state === 'en-espera');
    if (next === undefined) return false;

    const lease = this.lock.tryAcquire('run');
    if (!lease.ok) return false;

    const { entry, path } = next;
    entry.state = 'en-proceso';
    entry.startedAt = new Date().toISOString();
    if (!(await this.persistEntry(path, entry))) {
      // The state write failed: do not run blind — release the lock and retry
      // on the next idle tick, with the problem visible in the snapshot.
      lease.release();
      return false;
    }

    const input: RunInput = { message: entry.message, form: entry.form, mode: 'create' };

    let response: RunResponse;
    try {
      response = await runAttempt(input, this.deps);
    } catch (error) {
      // `runAttempt` maps its own errors into responses; this is the belt for
      // anything that lands outside them.
      response = {
        status: 'failed',
        reason: `unexpected error: ${messageOf(error)}`,
        details: [],
        recordPath: null,
        note: 'the run stopped before anything was written',
        durationMs: null,
      };
    } finally {
      lease.release();
    }

    const { state, outcome } = outcomeOf(response);
    entry.state = state;
    entry.outcome = outcome;
    entry.finishedAt = new Date().toISOString();
    if (await this.persistEntry(path, entry)) return true;
    // The final write could not land. Never leave a phantom: set the entry
    // back `en espera` so the next tick re-executes it — the executor's own
    // prior-attempt gate now refuses (the pre-click record exists), so a
    // second click can never happen, and the operator sees the reason instead
    // of a wedged queue. This is the restart-recovery principle, applied live.
    entry.state = 'en-espera';
    entry.startedAt = null;
    entry.outcome = null;
    entry.finishedAt = null;
    await this.persistEntry(path, entry);
    return true;
  }

  // ---------------------------------------------------------------- the disk

  /**
   * The durable write, atomic: a temp file plus a rename, so a concurrent
   * snapshot read can never see a half-written entry (a torn read would look
   * like an entry that vanished). A failure is a visible problem, never a
   * silent zero.
   */
  /**
   * One durable write attempt, retried for a short burst when the atomic
   * rename collides with a concurrent reader (see WRITE_RETRY_ATTEMPTS). A
   * failure that survives it is a visible problem, never a silent zero.
   */
  private async persistEntry(path: string, entry: QueueEntryFile): Promise<boolean> {
    for (let attempt = 0; ; attempt += 1) {
      if (await this.writeEntry(path, entry)) return true;
      if (attempt >= WRITE_RETRY_ATTEMPTS) return false;
      await new Promise<void>((resolve) => setTimeout(resolve, WRITE_RETRY_MS));
    }
  }

  private async writeEntry(path: string, entry: QueueEntryFile): Promise<boolean> {
    const temp = `${path}.tmp`;
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(temp, `${JSON.stringify(entry, null, 2)}\n`, { encoding: 'utf8' });
      await rename(temp, path);
      this.problem = null;
      return true;
    } catch (renameError) {
      // The rename can collide with a concurrent reader of the same file (the
      // page's own `/api/queue` poll): on Windows that answers with a transient
      // `EPERM` instead of queueing. Fall back to a direct overwrite of the
      // same small file: a reader may then catch a torn read for one instant,
      // the next read is whole again, and no entry ever wedges mid-state.
      try {
        await mkdir(this.dir, { recursive: true });
        await writeFile(path, `${JSON.stringify(entry, null, 2)}\n`, { encoding: 'utf8' });
        this.problem = null;
        return true;
      } catch {
        this.problem = `no se pudo escribir la entrada de la cola: ${describe(renameError)}`;
        return false;
      }
    }
  }

  /** File names in FIFO order; every entry file is the queue's whole truth. */
  private async readEntries(): Promise<Array<{ name: string; path: string; entry: QueueEntryFile }>> {
    let names: string[];
    try {
      names = (await readdir(this.dir)).sort();
    } catch (error) {
      if (!isMissingFile(error)) {
        this.problem = `no se pudo leer la cola en ${this.dir}: ${describe(error)}`;
      }
      return [];
    }

    const entries: Array<{ name: string; path: string; entry: QueueEntryFile }> = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const path = join(this.dir, name);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(path, { encoding: 'utf8' }));
      } catch {
        this.problem = `la entrada de la cola ${name} no se pudo leer y se saltea; el archivo queda en disco`;
        continue;
      }
      if (!isQueueEntry(parsed)) {
        this.problem = `la entrada de la cola ${name} no tiene el formato que la cola escribe y se saltea`;
        continue;
      }
      entries.push({ name, path, entry: parsed });
    }
    return entries;
  }

  // ---------------------------------------------------------------- the API

  /**
   * Stacks one approved submission. The gates do **not** run here: the operator
   * can stack while the browser is busy. What is validated now is the form
   * (nothing unbuildable enters the queue) and the hashes the executor re-checks,
   * computed server-side from the posted form exactly like the one-shot run did.
   */
  async enqueue(message: string, form: FormValues): Promise<EnqueueResult> {
    const built = requestFromForm(form);
    if (!built.ok) return { ok: false, kind: 'invalid-form', errors: built.errors };

    // The canonical values requestFromForm returns round-trip into the exact
    // same request at execution time, so the queue stores those.
    const stack = (): Promise<EnqueueResult> => this.append(message, built.value, built.values);
    const result = this.writeChain.then(stack, stack);
    this.writeChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async append(
    message: string,
    request: AnyShipmentRequest,
    form: FormValues,
  ): Promise<EnqueueResult> {
    const entries = await this.readEntries();
    const pending = entries.filter(({ entry }) => isPendingState(entry.state));
    if (pending.length >= MAX_PENDING_ENTRIES) {
      return { ok: false, kind: 'queue-full', reason: QUEUE_FULL_MESSAGE };
    }

    const messageHash = messageFingerprint(message);
    const approvalHash = computeAnyApprovalHash(request);
    const sequence = nextSequence(entries.map(({ name }) => name));
    const id = `${pad6(sequence)}-${messageHash.slice(0, 12)}`;

    const file: QueueEntryFile = {
      version: 1,
      id,
      enqueuedAt: new Date().toISOString(),
      message,
      form,
      modality: request.modality,
      messageHash,
      approvalHash,
      payload:
        request.modality === 'sucursal'
          ? sucursalApprovalPayloadFromRequest(request, SUCURSAL_CARRIER_NAME)
          : approvalPayloadFromRequest(request, CARRIER_NAME),
      state: 'en-espera',
      startedAt: null,
      finishedAt: null,
      outcome: null,
    };

    if (!(await this.persistEntry(join(this.dir, `${file.id}.json`), file))) {
      // The entry never reached disk: the operator must know, or the panel
      // would silently forget a shipment that was never stacked.
      return { ok: false, kind: 'queue-full', reason: `no se pudo escribir la cola: ${this.problem ?? '(desconocido)'}` };
    }

    this.wake();
    return { ok: true, entryId: file.id, position: pending.length + 1 };
  }

  /** Snapshot read for the panel: closed facts in panel order. */
  async snapshot(): Promise<QueueSnapshot> {
    const projected = (await this.readEntries()).map(({ entry }) => projectionOf(entry));

    const running = projected.filter(({ state }) => state === 'en-proceso');
    const waiting = projected.filter(({ state }) => state === 'en-espera');
    const finished = projected
      .filter(({ state }) => !isPendingState(state))
      .sort((left, right) => finishedSortKey(right).localeCompare(finishedSortKey(left)))
      .slice(0, SNAPSHOT_FINISHED_LIMIT);

    return {
      status: 'ok',
      readAt: new Date().toISOString(),
      entries: [...running, ...waiting, ...finished],
      pending: running.length + waiting.length,
      limit: MAX_PENDING_ENTRIES,
      problems: this.problem === null ? [] : [this.problem],
    };
  }

  /** Wakes the worker right away, so a fresh entry starts before the idle tick. */
  wake(): void {
    this.wakeSleep?.();
    this.wakeSleep = null;
  }

  private sleep(): Promise<void> {
    return new Promise<void>((resolve) => {
      // The ambient timer type has no `unref`; the queue needs it so a sleeping
      // worker never holds a closing test process open.
      const timer = setTimeout(resolve, this.pollIntervalMs) as { unref?: () => void };
      timer.unref?.();
      this.wakeSleep = () => {
        clearTimeout(timer as unknown as number);
        resolve();
      };
    });
  }
}

const queues = new WeakMap<ActionDeps, ShipmentQueue>();

/**
 * The one queue of a server's deps, created lazily and shared ever after.
 *
 * `createRoutes` runs per request, so the queue instance must come from the deps
 * identity itself rather than a variable the route table closes over: this map
 * guarantees exactly one queue (and one worker loop) per server.
 */
export function queueFor(deps: ActionDeps, options?: ShipmentQueueOptions & { dir?: string }): ShipmentQueue {
  const existing = queues.get(deps);
  if (existing !== undefined) return existing;
  const created = new ShipmentQueue(deps, options?.dir ?? queueDirOf(deps.recordDir), options);
  queues.set(deps, created);
  return created;
}
