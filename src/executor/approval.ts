import { createHash } from 'node:crypto';
import { normalizeText } from '../core/normalize';
import type { ShipmentRequest, SucursalShipmentRequest } from '../core/types';
import type { AgencyScreenReadback } from './envioNube';
import type { CarrierReadback, CostReadback, RecipientReadback } from './envioNube';

/**
 * The approval artifact, as a hash.
 *
 * The human approves a payload in the preview (R10); the executor never trusts
 * that the panel holds what was approved — it hashes *the values read back from
 * the form* and compares them with the approved hash. A drift of one character
 * in any panel field changes the digest, so the gated `createShipment(approval)`
 * refuses to act on a form that no longer matches the approval.
 *
 * The payload contains only fields the panel holds, formatted exactly as the
 * panel holds them (text values), so the same canonical form can be produced
 * from the `ShipmentRequest` (the preview) and from the readback (the form).
 */
export interface ApprovalPayload {
  zipCode: string;
  height: string;
  width: string;
  depth: string;
  weight: string;
  declaredValue: string;
  carrier: string;
  province: { code: string; name: string };
  city: string;
  address: string;
  number: string;
  complement: string;
  neighborhood: string;
  customer: { name: string; lastName: string };
}

function text(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

/** The payload the preview would show, before the panel is touched. */
export function approvalPayloadFromRequest(request: ShipmentRequest, carrier: string): ApprovalPayload {
  return {
    zipCode: request.zipCode,
    height: text(request.box.heightCm),
    width: text(request.box.widthCm),
    depth: text(request.box.depthCm),
    weight: text(request.box.weightG),
    declaredValue: text(request.box.declaredValueArs),
    carrier,
    province: { code: request.address.province.code, name: request.address.province.name },
    city: request.address.city,
    address: request.address.address,
    number: request.address.number,
    complement: request.address.complement ?? '',
    neighborhood: request.address.neighborhood,
    customer: {
      name: request.customer.name,
      lastName: request.customer.lastName ?? '',
    },
  };
}

/** The same payload, built from what the panel actually holds. */
export function approvalPayloadFromReadback(readback: {
  cost: CostReadback;
  carrier: CarrierReadback;
  recipient: RecipientReadback;
}): ApprovalPayload {
  return {
    zipCode: readback.cost.zipCode,
    height: readback.cost.height,
    width: readback.cost.width,
    depth: readback.cost.depth,
    weight: readback.cost.weight,
    declaredValue: readback.cost.declaredValue,
    carrier: readback.carrier.selectedName,
    province: { code: readback.recipient.province.value, name: readback.recipient.province.text },
    city: readback.recipient.city,
    address: readback.recipient.address,
    number: readback.recipient.number,
    complement: readback.recipient.complement,
    neighborhood: readback.recipient.neighborhood,
    customer: {
      name: readback.recipient.name,
      lastName: readback.recipient.lastName,
    },
  };
}

/**
 * Deterministic serialization: an explicit field order, never
 * `JSON.stringify(object)` on an object whose key order could drift.
 */
export function canonicalApprovalPayload(payload: ApprovalPayload): string {
  return JSON.stringify([
    payload.zipCode,
    payload.height,
    payload.width,
    payload.depth,
    payload.weight,
    payload.declaredValue,
    payload.carrier,
    payload.province.code,
    payload.province.name,
    payload.city,
    payload.address,
    payload.number,
    payload.complement,
    payload.neighborhood,
    payload.customer.name,
    payload.customer.lastName,
  ]);
}

/** Lower-case sha-256 hex digest of the canonical payload. */
export function hashApprovalPayload(payload: ApprovalPayload): string {
  return createHash('sha256').update(canonicalApprovalPayload(payload), 'utf8').digest('hex');
}

// --------------------------------------------------------------- sucursal

/**
 * The sucursal approval artifact. The shape mirrors what the two sucursal
 * screens actually hold: no address group (the destination is only a postal
 * code on screen Q), a branch instead of a province, and the panel's
 * `customer.surname` anchor in place of domicilio's `customer.lastName`.
 */
export interface SucursalApprovalPayload {
  /** Screen Q's `address.zipCode` readback. */
  zipCode: string;
  /** The branch: the request name on the request side, the selected option text on the readback side. */
  sucursal: string;
  /** The approved carrier name (SUCURSAL_CARRIER_NAME), never the panel's decoration. */
  carrier: string;
  height: string;
  width: string;
  depth: string;
  weight: string;
  declaredValue: string;
  customer: { name: string; surname: string; email: string; phone: string };
}

/** The sucursal payload the preview would show, before the panel is touched. */
export function sucursalApprovalPayloadFromRequest(
  request: SucursalShipmentRequest,
  carrier: string,
): SucursalApprovalPayload {
  return {
    zipCode: request.zipCode,
    sucursal: request.sucursal,
    carrier,
    height: text(request.box.heightCm),
    width: text(request.box.widthCm),
    depth: text(request.box.depthCm),
    weight: text(request.box.weightG),
    declaredValue: text(request.box.declaredValueArs),
    customer: {
      name: request.customer.name,
      surname: request.customer.lastName ?? '',
      email: request.customer.email ?? '',
      phone: request.customer.phone ?? '',
    },
  };
}

/**
 * The same payload, built from what the panel actually holds after the walk.
 *
 * `sucursal` carries the **selected option text** as the panel shows it; the
 * branch is matched by normalized option text, so the request name and this
 * text can differ in case/accents/whitespace while naming the same branch.
 * `carrier` is the approved carrier name the caller verified against the
 * readback (same trust model as domicilio's `carrier.selectedName`).
 */
export function sucursalApprovalPayloadFromReadback(readback: {
  screen: AgencyScreenReadback;
  zipCode: string;
  sucursal: string;
  carrier: string;
}): SucursalApprovalPayload {
  return {
    zipCode: readback.zipCode,
    sucursal: readback.sucursal,
    carrier: readback.carrier,
    height: readback.screen.height,
    width: readback.screen.width,
    depth: readback.screen.depth,
    weight: readback.screen.weight,
    declaredValue: readback.screen.declaredValue,
    customer: {
      name: readback.screen.name,
      surname: readback.screen.surname,
      email: readback.screen.email,
      phone: readback.screen.phone,
    },
  };
}

/**
 * Deterministic serialization for the sucursal payload, with a literal
 * `sucursal` tag first so it can never collide with the domicilio canonical form.
 *
 * The branch field is hashed by **identity, not spelling**: the panel's own
 * option text is authoritative and the request name is matched against it after
 * normalization (case/accent/whitespace), so the same normalization runs on both
 * sides before hashing. The operator approves a branch identity, not its
 * spelling. Every other field must match byte for byte.
 */
export function canonicalSucursalApprovalPayload(payload: SucursalApprovalPayload): string {
  return JSON.stringify([
    'sucursal',
    payload.zipCode,
    normalizeText(payload.sucursal),
    payload.carrier,
    payload.height,
    payload.width,
    payload.depth,
    payload.weight,
    payload.declaredValue,
    payload.customer.name,
    payload.customer.surname,
    payload.customer.email,
    payload.customer.phone,
  ]);
}

/** Lower-case sha-256 hex digest of the canonical sucursal payload. */
export function hashSucursalApprovalPayload(payload: SucursalApprovalPayload): string {
  return createHash('sha256').update(canonicalSucursalApprovalPayload(payload), 'utf8').digest('hex');
}
