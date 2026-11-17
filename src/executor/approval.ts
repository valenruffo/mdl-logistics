import { createHash } from 'node:crypto';
import type { ShipmentRequest } from '../core/types';
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
