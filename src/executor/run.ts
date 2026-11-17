import { mkdir, writeFile } from 'node:fs/promises';
import type { Page } from 'playwright';
import { CARRIER_NAME } from '../core/carrier';
import type { ShipmentRequest } from '../core/types';
import { approvalPayloadFromReadback, hashApprovalPayload, type ApprovalPayload } from './approval';
import {
  EnvioNube,
  type CarrierReadback,
  type CostReadback,
  type RecipientReadback,
  type ReconciliationReport,
  type ShipmentDetailReadback,
  type SummaryReadback,
} from './envioNube';
import { ExecutorError, UnknownOutcomeError, detailsOf, messageOf } from './errors';
import { openSession } from './session';

/**
 * The journey driver.
 *
 * `runDryRun` walks screens 1–4 and **stops on the summary**: it never clicks
 * `Crear envío`, so nothing is created and no label is involved. It returns every
 * value read back from the panel, plus the diff against the requested payload.
 *
 * `runCreate` walks the same journey and then delegates the one irreversible
 * click to `EnvioNube.createShipment`, which refuses unless the hash of the payload
 * read back from the form equals the approved hash. After a creation it reads the
 * shipment id, asserts the label is still unpaid (the `Comprar` button is visible;
 * it is never clicked) and stops. An unknown outcome is reconciled against the
 * shipments list once, and never retried.
 */

export interface RunOptions {
  request: ShipmentRequest;
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

export interface DryRunResult {
  mode: 'dry-run';
  startedAt: string;
  finishedAt: string;
  approvedPayloadHash: string;
  formPayloadHash: string;
  formMatchesApproval: boolean;
  mismatches: string[];
  journey: JourneyReadback;
  /** The dry run's terminal state. Nothing was created. */
  stoppedAt: 'summary';
  /** Visibility only: `Crear envío` was never clicked. */
  createButtonPresent: boolean;
  reportPath: string;
}

interface CreateRunBase {
  mode: 'create';
  startedAt: string;
  finishedAt: string;
  approvedPayloadHash: string;
  formPayloadHash: string;
  mismatches: string[];
  journey: JourneyReadback;
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
 * Mode 1 — dry run (default). Walks the real journey and stops on the summary.
 * `Crear envío` is only ever checked for visibility.
 */
export async function runDryRun(input: RunOptions): Promise<DryRunResult> {
  const startedAt = new Date().toISOString();

  return withPanel(input.artifactsDir, async ({ panel, artifactsDir }) => {
    const journey = await walkToSummary(panel, input.request);

    const formPayload: ApprovalPayload = approvalPayloadFromReadback(journey);
    const formPayloadHash = hashApprovalPayload(formPayload);
    const approvedPayloadHash = input.approvedPayloadHash.trim().toLowerCase();
    const mismatches = compareReadback(input.request, journey);
    const formMatchesApproval = approvedPayloadHash !== '' && formPayloadHash === approvedPayloadHash;

    const result: DryRunResult = {
      mode: 'dry-run',
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
  const startedAt = new Date().toISOString();

  return withPanel(input.artifactsDir, async ({ panel, artifactsDir }) => {
    const journey = await walkToSummary(panel, input.request);

    const payload: ApprovalPayload = approvalPayloadFromReadback(journey);
    const formPayloadHash = hashApprovalPayload(payload);
    const approvedPayloadHash = input.approvedPayloadHash.trim().toLowerCase();
    const mismatches = compareReadback(input.request, journey);

    if (mismatches.length > 0) {
      throw new ExecutorError(
        'refusing to create the shipment: the panel does not hold the approved payload',
        mismatches,
      );
    }

    const base: CreateRunBase = {
      mode: 'create',
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
      const lastName = input.request.customer.lastName;
      const recipientName = [input.request.customer.name, ...(lastName === null ? [] : [lastName])]
        .map((part) => part.trim())
        .filter((part) => part !== '')
        .join(' ');
      const reconciliation = await panel.reconcileUnknownOutcome({
        zipCode: input.request.zipCode,
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
