import { mkdir, writeFile } from 'node:fs/promises';
import type { Page } from 'playwright';
import { CARRIER_NAME } from '../core/carrier';
import { textContains } from '../core/normalize';
import type {
  AnyShipmentRequest,
  MessageModality,
  ShipmentRequest,
  SucursalShipmentRequest,
} from '../core/types';
import {
  approvalPayloadFromReadback,
  hashApprovalPayload,
  hashSucursalApprovalPayload,
  sucursalApprovalPayloadFromReadback,
  type ApprovalPayload,
  type SucursalApprovalPayload,
} from './approval';
import {
  EnvioNube,
  SUCURSAL_CARRIER_NAME,
  type AgencyQuotationReadback,
  type AgencyScreenReadback,
  type BranchReadback,
  type CarrierReadback,
  type CostReadback,
  type RecipientReadback,
  type ReconciliationReport,
  type ShipmentDetailReadback,
  type SummaryReadback,
} from './envioNube';
import { arsAmountsEqual, parseArsAmount } from './currency';
import { branchIdentity } from './branch';
import { ExecutorError, UnknownOutcomeError, detailsOf, messageOf } from './errors';
import { openSession } from './session';

/**
 * The journey driver.
 *
 * `runDryRun` walks the journey and **stops before the create button**: for
 * domicilio that is the summary (screens 1–4); for sucursal it is the branch
 * selection on screen Q. It never clicks `Crear envío`, so nothing is created
 * and no label is involved. It returns every value read back from the panel,
 * plus the diff against the requested payload.
 *
 * `runCreate` walks the same journey and then delegates the one irreversible
 * click to `EnvioNube.createShipment` (domicilio) or `EnvioNube
 * .createAgencyShipment` (sucursal), which refuse unless the hash of the payload
 * read back from the form equals the approved hash. After a creation it reads
 * the shipment id, asserts the label is still unpaid (the `Comprar` button is
 * visible; it is never clicked) and stops. An unknown outcome is reconciled
 * against the shipments list once, and never retried.
 */

export interface RunOptions {
  /** Domicilio or sucursal; the journey is chosen by the request's own modality. */
  request: AnyShipmentRequest;
  /**
   * sha-256 of the payload the human approved in the preview (the approval
   * artifact, R10). The executor does not trust it — it compares it with the hash
   * of the values actually read back from the panel.
   */
  approvedPayloadHash: string;
  /** Defaults to `artifacts/executor-<timestamp>`. */
  artifactsDir?: string;
}

export interface JourneyReadback {
  cost: CostReadback;
  carrier: CarrierReadback;
  recipient: RecipientReadback;
  summary: SummaryReadback;
}

/** The two sucursal screens' readback, in walk order. */
export interface SucursalJourneyReadback {
  /** Screen P: recipient + package (the destination is only a postal code on screen Q). */
  screen: AgencyScreenReadback;
  carrier: CarrierReadback;
  branch: BranchReadback;
  /** Screen Q re-read: zip code, checked radio, selected branch, create button. */
  quotation: AgencyQuotationReadback;
}

export type Journey = JourneyReadback | SucursalJourneyReadback;

export interface DryRunResult {
  mode: 'dry-run';
  modality: MessageModality;
  startedAt: string;
  finishedAt: string;
  approvedPayloadHash: string;
  formPayloadHash: string;
  formMatchesApproval: boolean;
  mismatches: string[];
  journey: Journey;
  /** The dry run's terminal state: the summary, or the selected branch on screen Q. Nothing was created. */
  stoppedAt: 'summary' | 'agency-quotation';
  /** Visibility only: `Crear envío` was never clicked. */
  createButtonPresent: boolean;
  reportPath: string;
}

interface CreateRunBase {
  mode: 'create';
  modality: MessageModality;
  startedAt: string;
  finishedAt: string;
  approvedPayloadHash: string;
  formPayloadHash: string;
  mismatches: string[];
  journey: Journey;
  detailScreenshot: string | null;
  reportPath: string;
}

export type CreateRunResult =
  | (CreateRunBase & { outcome: 'created'; shipment: ShipmentDetailReadback; reconciliation: null })
  | (CreateRunBase & { outcome: 'unknown'; shipment: null; reconciliation: ReconciliationReport });

interface RunContext {
  panel: EnvioNube;
  page: Page;
  artifactsDir: string;
  tracePath: string;
}

interface FieldPair {
  label: string;
  expected: string;
  actual: string;
  /**
   * Compare as ARS amounts, not strings: a currency-masked panel holds the
   * Argentine format (`$ 100.000,00`), which equals the payload's `100000`
   * numerically. Parsed with `parseArsAmount`; unparsable text never matches.
   */
  numeric?: boolean;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Opens the prepared session, records a trace, and always writes artifacts on failure. */
async function withPanel<T>(artifactsDir: string | undefined, job: (context: RunContext) => Promise<T>): Promise<T> {
  const dir = artifactsDir ?? `artifacts/executor-${stamp()}`;
  await mkdir(dir, { recursive: true });
  const tracePath = `${dir}/trace.zip`;

  const session = await openSession();
  const page = session.page;
  let tracing = false;

  try {
    await page.context().tracing.start({ screenshots: true, snapshots: true });
    tracing = true;
    const panel = new EnvioNube(page);
    await panel.requireFrame();
    return await job({ panel, page, artifactsDir: dir, tracePath });
  } catch (error) {
    const artifactDetails = await captureFailure(page, dir, tracePath);
    const details = [...detailsOf(error), ...artifactDetails];
    if (error instanceof UnknownOutcomeError) throw new UnknownOutcomeError(messageOf(error), details);
    if (error instanceof ExecutorError) throw new ExecutorError(messageOf(error), details);
    throw new ExecutorError(`executor run failed: ${messageOf(error)}`, details);
  } finally {
    if (tracing) {
      await page.context().tracing.stop({ path: tracePath }).catch(() => {
        // A missing trace must not mask the run's own result.
      });
    }
    await session.close().catch(() => {
      // Closing is best-effort; the profile stays usable either way.
    });
  }
}

async function captureFailure(page: Page, artifactsDir: string, tracePath: string): Promise<string[]> {
  const screenshotPath = `${artifactsDir}/failure.png`;
  let screenshot = false;
  try {
    await page.screenshot({ path: screenshotPath });
    screenshot = true;
  } catch {
    screenshot = false;
  }

  const details: string[] = [
    screenshot ? `screenshot captured: ${screenshotPath}` : `screenshot could not be captured: ${screenshotPath}`,
    `trace: ${tracePath}`,
    `admin page url at failure: ${page.url()}`,
    'frames on the page:',
  ];
  for (const frame of page.frames()) {
    details.push(`  - ${frame.url() === '' ? '(no url yet)' : frame.url()}`);
  }
  return details;
}

function costPairs(request: ShipmentRequest, cost: CostReadback): FieldPair[] {
  const pairs: FieldPair[] = [
    { label: 'zipCode', expected: request.zipCode, actual: cost.zipCode },
    { label: 'box.height (cm)', expected: String(request.box.heightCm), actual: cost.height },
    { label: 'box.width (cm)', expected: String(request.box.widthCm), actual: cost.width },
    { label: 'box.depth (cm)', expected: String(request.box.depthCm), actual: cost.depth },
    { label: 'box.weight (g)', expected: String(request.box.weightG), actual: cost.weight },
    {
      label: 'declaredValue',
      expected: request.box.declaredValueArs === undefined ? '' : String(request.box.declaredValueArs),
      actual: cost.declaredValue,
    },
  ];
  return pairs;
}

function recipientPairs(request: ShipmentRequest, recipient: RecipientReadback): FieldPair[] {
  return [
    { label: 'address.province (code)', expected: request.address.province.code, actual: recipient.province.value },
    { label: 'address.province (text)', expected: request.address.province.name, actual: recipient.province.text },
    { label: 'address.city', expected: request.address.city, actual: recipient.city },
    { label: 'address.address', expected: request.address.address, actual: recipient.address },
    { label: 'address.number', expected: request.address.number, actual: recipient.number },
    { label: 'address.complement', expected: request.address.complement ?? '', actual: recipient.complement },
    { label: 'address.neighborhood', expected: request.address.neighborhood, actual: recipient.neighborhood },
    { label: 'customer.name', expected: request.customer.name, actual: recipient.name },
    { label: 'customer.lastName', expected: request.customer.lastName ?? '', actual: recipient.lastName },
  ];
}

/**
 * A field that was written and now reads empty is the signature of a reload or a
 * bot challenge clearing the form. That is a loud stop, not something to refill
 * blindly and not something to retry.
 */
function assertFormStillHolds(screen: string, pairs: readonly FieldPair[]): void {
  const cleared = pairs.filter((pair) => pair.expected !== '' && pair.actual === '');
  if (cleared.length === 0) return;
  throw new ExecutorError(`${screen}: the form no longer holds the values just written`, [
    ...cleared.map((pair) => `${pair.label} reads "" but ${JSON.stringify(pair.expected)} was written`),
    'this is what a Cloudflare challenge or a page reload does to a filled form; the run stops instead of retrying',
  ]);
}

function compareReadback(request: ShipmentRequest, journey: JourneyReadback): string[] {
  const mismatches: string[] = [];
  const record = (pair: FieldPair): void => {
    if (pair.expected !== pair.actual) {
      mismatches.push(
        `${pair.label}: expected ${JSON.stringify(pair.expected)}, the panel holds ${JSON.stringify(pair.actual)}`,
      );
    }
  };

  costPairs(request, journey.cost).forEach(record);
  recipientPairs(request, journey.recipient).forEach(record);

  if (journey.carrier.selectedName !== CARRIER_NAME) {
    mismatches.push(`carrier: expected ${JSON.stringify(CARRIER_NAME)}, the panel holds ${JSON.stringify(journey.carrier.selectedName)}`);
  }
  if (!journey.carrier.checked) {
    mismatches.push('carrier: the panel does not report the selected radio as checked');
  }

  const unitChecks: [string, string | null, string][] = [
    ['box.height unit', journey.cost.units.height, 'cm'],
    ['box.width unit', journey.cost.units.width, 'cm'],
    ['box.depth unit', journey.cost.units.depth, 'cm'],
    ['box.weight unit', journey.cost.units.weight, 'g'],
  ];
  for (const [label, actual, expected] of unitChecks) {
    if (actual !== expected) {
      mismatches.push(`${label}: expected ${JSON.stringify(expected)}, the panel holds ${JSON.stringify(actual)}`);
    }
  }

  return mismatches;
}

/** Screens 1 → 4, stopping on the summary. The only click targets are `Continuar` and one radio. */
async function walkToSummary(panel: EnvioNube, request: ShipmentRequest): Promise<JourneyReadback> {
  await panel.fillCost({ zipCode: request.zipCode, box: request.box });
  const cost = await panel.readCost();
  assertFormStillHolds('screen 1 (Calcular costo de envío)', costPairs(request, cost));

  await panel.continueFromCost();
  const carrier = await panel.selectCarrier();
  await panel.continueFromQuotation();

  await panel.fillRecipient({ address: request.address, customer: request.customer });
  const recipient = await panel.readRecipient();
  assertFormStillHolds('screen 3 (Completar datos del destinatario)', recipientPairs(request, recipient));

  await panel.openSummary();
  await panel.assertSummaryVisible();
  const summary = await panel.readSummary();

  return { cost, carrier, recipient, summary };
}

/**
 * Mode 1 — dry run (default). Dispatches by modality: domicilio walks screens
 * 1–4 and stops on the summary; sucursal walks screens P–Q and stops after the
 * branch is selected. `Crear envío` is only ever checked for visibility.
 */
export async function runDryRun(input: RunOptions): Promise<DryRunResult> {
  if (input.request.modality === 'sucursal') return runSucursalDryRun(input);
  return runDomicilioDryRun(input, input.request);
}

async function runDomicilioDryRun(input: RunOptions, request: ShipmentRequest): Promise<DryRunResult> {
  const startedAt = new Date().toISOString();

  return withPanel(input.artifactsDir, async ({ panel, artifactsDir }) => {
    const journey = await walkToSummary(panel, request);

    const formPayload: ApprovalPayload = approvalPayloadFromReadback(journey);
    const formPayloadHash = hashApprovalPayload(formPayload);
    const approvedPayloadHash = input.approvedPayloadHash.trim().toLowerCase();
    const mismatches = compareReadback(request, journey);
    const formMatchesApproval = approvedPayloadHash !== '' && formPayloadHash === approvedPayloadHash;

    const result: DryRunResult = {
      mode: 'dry-run',
      modality: 'domicilio',
      startedAt,
      finishedAt: new Date().toISOString(),
      approvedPayloadHash,
      formPayloadHash,
      formMatchesApproval,
      mismatches,
      journey,
      stoppedAt: 'summary',
      createButtonPresent: journey.summary.createButtonVisible,
      reportPath: `${artifactsDir}/dry-run.json`,
    };
    await writeFile(result.reportPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8' });
    return result;
  });
}

/**
 * Mode 2 — gated creation. Only legal with an approval hash that matches the
 * payload read back from the form; `EnvioNube.createShipment` enforces that and is
 * the single call site of the `Crear envío` click.
 *
 * Not wired to any npm script: until an approval artifact exists, the dry run is
 * the only journey this repository can execute.
 */
export async function runCreate(input: RunOptions): Promise<CreateRunResult> {
  if (input.request.modality === 'sucursal') return runSucursalCreate(input);
  return runDomicilioCreate(input, input.request);
}

async function runDomicilioCreate(input: RunOptions, request: ShipmentRequest): Promise<CreateRunResult> {
  const startedAt = new Date().toISOString();

  return withPanel(input.artifactsDir, async ({ panel, artifactsDir }) => {
    const journey = await walkToSummary(panel, request);

    const payload: ApprovalPayload = approvalPayloadFromReadback(journey);
    const formPayloadHash = hashApprovalPayload(payload);
    const approvedPayloadHash = input.approvedPayloadHash.trim().toLowerCase();
    const mismatches = compareReadback(request, journey);

    if (mismatches.length > 0) {
      throw new ExecutorError(
        'refusing to create the shipment: the panel does not hold the approved payload',
        mismatches,
      );
    }

    const base: CreateRunBase = {
      mode: 'create',
      modality: 'domicilio',
      startedAt,
      finishedAt: '',
      approvedPayloadHash,
      formPayloadHash,
      mismatches,
      journey,
      detailScreenshot: null,
      reportPath: `${artifactsDir}/create-run.json`,
    };

    try {
      const shipment = await panel.createShipment({ approvedHash: input.approvedPayloadHash, payload });

      // Proof of the terminal state (S12): the label exists and is unpaid.
      // `Comprar` is only inspected — there is no purchase action in the executor.
      await panel.assertLabelUnpaid();
      const screenshotPath = `${artifactsDir}/shipment-detail.png`;
      const captured = await panel.captureEvidence(screenshotPath);

      const result: CreateRunResult = {
        ...base,
        finishedAt: new Date().toISOString(),
        outcome: 'created',
        shipment,
        reconciliation: null,
        detailScreenshot: captured ? screenshotPath : null,
      };
      await writeFile(result.reportPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8' });
      return result;
    } catch (error) {
      if (!(error instanceof UnknownOutcomeError)) throw error;

      // The outcome is unknown: reconcile once against the shipments list and
      // never retry. The screenshot is evidence for the human decision.
      const evidencePath = `${artifactsDir}/unknown-outcome.png`;
      await panel.captureEvidence(evidencePath);
      const lastName = request.customer.lastName;
      const recipientName = [request.customer.name, ...(lastName === null ? [] : [lastName])]
        .map((part) => part.trim())
        .filter((part) => part !== '')
        .join(' ');
      const reconciliation = await panel.reconcileUnknownOutcome({
        zipCode: request.zipCode,
        recipientName,
      });

      const result: CreateRunResult = {
        ...base,
        finishedAt: new Date().toISOString(),
        outcome: 'unknown',
        shipment: null,
        reconciliation,
      };
      await writeFile(result.reportPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8' });
      return result;
    }
  });
}

// ----------------------------------------------------------------- sucursal

/** Screen-P field pairs for the form-still-holds check and the mismatch report. */
export function sucursalScreenPairs(
  request: SucursalShipmentRequest,
  screen: AgencyScreenReadback,
): FieldPair[] {
  return [
    { label: 'customer.name', expected: request.customer.name, actual: screen.name },
    // The request's `lastName` fills the panel's `customer.surname` anchor.
    { label: 'customer.surname', expected: request.customer.lastName ?? '', actual: screen.surname },
    { label: 'customer.email', expected: request.customer.email ?? '', actual: screen.email },
    { label: 'customer.phoneNumber', expected: request.customer.phone ?? '', actual: screen.phone },
    { label: 'box.height (cm)', expected: String(request.box.heightCm), actual: screen.height },
    { label: 'box.width (cm)', expected: String(request.box.widthCm), actual: screen.width },
    { label: 'box.depth (cm)', expected: String(request.box.depthCm), actual: screen.depth },
    { label: 'box.weight (g)', expected: String(request.box.weightG), actual: screen.weight },
    {
      label: 'declaredValue ($)',
      expected: String(request.box.declaredValueArs ?? ''),
      actual: screen.declaredValue,
      // The panel's currency mask renders `$ 100.000,00`; compare numerically.
      numeric: true,
    },
  ];
}

/**
 * The sucursal readback diff against the approved request. The branch is
 * compared by street+number identity (the physical address is the branch; the
 * panel's own option text may carry prefixes and city decoration the message
 * does not); the carrier name and every other field byte for byte.
 */
export function sucursalMismatches(request: SucursalShipmentRequest, journey: SucursalJourneyReadback): string[] {
  const mismatches: string[] = [];
  const record = (pair: FieldPair): void => {
    if (pair.numeric) {
      const expectedArs = parseArsAmount(pair.expected);
      const actualArs = parseArsAmount(pair.actual);
      const equal = expectedArs !== null && actualArs !== null && arsAmountsEqual(expectedArs, actualArs);
      if (!equal) {
        mismatches.push(
          `${pair.label}: expected ${JSON.stringify(pair.expected)}` +
            ` (${expectedArs === null ? 'unreadable' : `${expectedArs} ARS`}), the panel holds ${JSON.stringify(pair.actual)}` +
            ` (${actualArs === null ? 'unreadable' : `${actualArs} ARS`})`,
        );
      }
      return;
    }
    if (pair.expected !== pair.actual) {
      mismatches.push(
        `${pair.label}: expected ${JSON.stringify(pair.expected)}, the panel holds ${JSON.stringify(pair.actual)}`,
      );
    }
  };

  sucursalScreenPairs(request, journey.screen).forEach(record);
  record({ label: 'address.zipCode', expected: request.zipCode, actual: journey.quotation.zipCode });

  if (journey.carrier.selectedName !== SUCURSAL_CARRIER_NAME) {
    mismatches.push(
      `carrier: expected ${JSON.stringify(SUCURSAL_CARRIER_NAME)}, the panel holds ${JSON.stringify(journey.carrier.selectedName)}`,
    );
  }
  if (!journey.carrier.checked) {
    mismatches.push('carrier: the panel does not report the selected radio as checked');
  }
  if (
    journey.quotation.checkedCarrierName === null ||
    !textContains(journey.quotation.checkedCarrierName, SUCURSAL_CARRIER_NAME)
  ) {
    mismatches.push(
      `carrier re-read: expected a checked radio named ${JSON.stringify(SUCURSAL_CARRIER_NAME)}, the panel holds ${JSON.stringify(journey.quotation.checkedCarrierName)}`,
    );
  }
  if (branchIdentity(journey.branch.selectedText) !== branchIdentity(request.sucursal)) {
    mismatches.push(
      `branch: expected ${JSON.stringify(request.sucursal)} (matched by street+number identity), the panel holds ${JSON.stringify(journey.branch.selectedText)}`,
    );
  }
  if (journey.branch.selectedValue === '') {
    mismatches.push('branch: the sucursal dropdown reports no selected option');
  }

  const unitChecks: [string, string | null, string][] = [
    ['box.height unit', journey.screen.units.height, 'cm'],
    ['box.width unit', journey.screen.units.width, 'cm'],
    ['box.depth unit', journey.screen.units.depth, 'cm'],
    ['box.weight unit', journey.screen.units.weight, 'g'],
  ];
  for (const [label, actual, expected] of unitChecks) {
    if (actual !== expected) {
      mismatches.push(`${label}: expected ${JSON.stringify(expected)}, the panel holds ${JSON.stringify(actual)}`);
    }
  }

  return mismatches;
}

/**
 * Screens P → Q, stopping after the branch selection. The only click targets are `Continuar` and one carrier radio.
 *
 * The walk **starts by direct URL navigation** to the verified agency entry
 * (`EnvioNube.openAgencyEntry`): the session is loaded at `#/agency-shipment`, the
 * `/agency-shipment` route and the `Envío manual a sucursal` heading are asserted,
 * and only then is Screen P filled. Entering through the shared domicilio URL
 * instead would land on `#/create-single-shipment` with the modal branch never
 * selected — the failure the live dry run exposed.
 */
export async function walkSucursalToQuotation(
  panel: EnvioNube,
  request: SucursalShipmentRequest,
): Promise<SucursalJourneyReadback> {
  await panel.openAgencyEntry();
  await panel.fillAgencyRecipient({ customer: request.customer });
  await panel.fillAgencyPackage(request.box);
  const screen = await panel.readAgencyScreen();
  assertFormStillHolds('sucursal screen P (#/agency-shipment)', sucursalScreenPairs(request, screen));

  await panel.continueFromAgencyRecipient();
  await panel.fillAgencyDestination(request.zipCode);
  const carrier = await panel.selectCarrierSucursal();
  const branch = await panel.selectBranch(request.sucursal);
  const quotation = await panel.readAgencyQuotation();

  return { screen, carrier, branch, quotation };
}

function sucursalRecipientName(request: SucursalShipmentRequest): string {
  return [request.customer.name, ...(request.customer.lastName === null ? [] : [request.customer.lastName])]
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join(' ');
}

/** The sucursal approval payload as the panel actually holds it, after the walk. */
function sucursalPayloadFromJourney(journey: SucursalJourneyReadback): SucursalApprovalPayload {
  return sucursalApprovalPayloadFromReadback({
    screen: journey.screen,
    zipCode: journey.quotation.zipCode,
    sucursal: journey.quotation.branchSelectedText,
    carrier: journey.carrier.selectedName,
  });
}

async function writeReport(path: string, result: unknown): Promise<void> {
  if (path === '') return;
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8' });
}

/**
 * Mode 1 for sucursal, against a panel: walks both screens, asserts the branch
 * dropdown holds the approved name, and stops. `Crear envío` is only ever
 * checked for visibility. Exported so the fake-frame harness can run the exact
 * same dry run offline (R11); `runSucursalDryRun` wraps it with a real session.
 */
export async function sucursalDryRunAgainst(
  panel: EnvioNube,
  request: SucursalShipmentRequest,
  approvedPayloadHash: string,
  artifactsDir?: string,
): Promise<DryRunResult> {
  const startedAt = new Date().toISOString();
  const journey = await walkSucursalToQuotation(panel, request);

  const formPayload = sucursalPayloadFromJourney(journey);
  const formPayloadHash = hashSucursalApprovalPayload(formPayload);
  const approved = approvedPayloadHash.trim().toLowerCase();
  const mismatches = sucursalMismatches(request, journey);
  const formMatchesApproval = approved !== '' && formPayloadHash === approved;

  const result: DryRunResult = {
    mode: 'dry-run',
    modality: 'sucursal',
    startedAt,
    finishedAt: new Date().toISOString(),
    approvedPayloadHash: approved,
    formPayloadHash,
    formMatchesApproval,
    mismatches,
    journey,
    stoppedAt: 'agency-quotation',
    createButtonPresent: journey.quotation.createButtonVisible,
    reportPath: artifactsDir === undefined ? '' : `${artifactsDir}/dry-run.json`,
  };
  await writeReport(result.reportPath, result);
  return result;
}

async function runSucursalDryRun(input: RunOptions): Promise<DryRunResult> {
  const request = input.request as SucursalShipmentRequest; // the dispatcher guarantees this
  return withPanel(input.artifactsDir, ({ panel, artifactsDir }) =>
    sucursalDryRunAgainst(panel, request, input.approvedPayloadHash, artifactsDir),
  );
}

/**
 * Mode 2 for sucursal, against a panel: walks both screens, refuses on any
 * mismatch, then delegates the one gated click on screen Q to
 * `EnvioNube.createAgencyShipment`. Exported for the fake-frame harness (R11).
 */
export async function sucursalCreateAgainst(
  panel: EnvioNube,
  request: SucursalShipmentRequest,
  approvedPayloadHash: string,
  artifactsDir?: string,
): Promise<CreateRunResult> {
  const startedAt = new Date().toISOString();
  const journey = await walkSucursalToQuotation(panel, request);

  const payload = sucursalPayloadFromJourney(journey);
  const formPayloadHash = hashSucursalApprovalPayload(payload);
  const approved = approvedPayloadHash.trim().toLowerCase();
  const mismatches = sucursalMismatches(request, journey);

  if (mismatches.length > 0) {
    throw new ExecutorError('refusing to create the shipment: the panel does not hold the approved payload', mismatches);
  }

  const base: CreateRunBase = {
    mode: 'create',
    modality: 'sucursal',
    startedAt,
    finishedAt: '',
    approvedPayloadHash: approved,
    formPayloadHash,
    mismatches,
    journey,
    detailScreenshot: null,
    reportPath: artifactsDir === undefined ? '' : `${artifactsDir}/create-run.json`,
  };

  try {
    // `createAgencyShipment` itself proves the unpaid label before returning;
    // an unproven label is a loud stop, never a success report.
    const shipment = await panel.createAgencyShipment({ approvedHash: approvedPayloadHash, payload });

    const screenshotPath = artifactsDir === undefined ? null : `${artifactsDir}/shipment-detail.png`;
    const captured = screenshotPath === null ? false : await panel.captureEvidence(screenshotPath);

    const result: CreateRunResult = {
      ...base,
      finishedAt: new Date().toISOString(),
      outcome: 'created',
      shipment,
      reconciliation: null,
      detailScreenshot: captured ? (screenshotPath as string) : null,
    };
    await writeReport(result.reportPath, result);
    return result;
  } catch (error) {
    if (!(error instanceof UnknownOutcomeError)) throw error;

    // The outcome is unknown: reconcile once against the shipments list and
    // never retry. The screenshot is evidence for the human decision.
    const evidencePath = artifactsDir === undefined ? null : `${artifactsDir}/unknown-outcome.png`;
    if (evidencePath !== null) await panel.captureEvidence(evidencePath);
    const reconciliation = await panel.reconcileUnknownOutcome({
      zipCode: request.zipCode,
      recipientName: sucursalRecipientName(request),
    });

    const result: CreateRunResult = {
      ...base,
      finishedAt: new Date().toISOString(),
      outcome: 'unknown',
      shipment: null,
      reconciliation,
    };
    await writeReport(result.reportPath, result);
    return result;
  }
}

async function runSucursalCreate(input: RunOptions): Promise<CreateRunResult> {
  const request = input.request as SucursalShipmentRequest; // the dispatcher guarantees this
  return withPanel(input.artifactsDir, ({ panel, artifactsDir }) =>
    sucursalCreateAgainst(panel, request, input.approvedPayloadHash, artifactsDir),
  );
}
