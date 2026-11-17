/**
 * SINGLE SOURCE OF TRUTH for every literal label of the pasted message format
 * (docs/plans/mvp-01-manual-shipment.md §7, B1).
 *
 * The parser never compares against a scattered string literal: it keys off
 * this table only. Fixing a label the operator reports differently (for example
 * the still-unconfirmed "Código postal" wording) is a one-line change here.
 *
 * Matching is accent-, case-, dot- and whitespace-insensitive, and WhatsApp
 * formatting markers (`*`, `_`, `~`, `` ` ``) are stripped from the edges of a
 * label or heading before lookup, so `*Código postal*`, `codigo postal` and
 * `CÓDIGO POSTAL` all resolve to the same field. The values below keep the
 * operator's own spelling.
 */
export const MESSAGE_LABELS = {
  /** Optional document title line, tolerated anywhere but never required. */
  title: 'MDL - Datos de envío',
  sections: {
    destination: 'Destino',
    recipient: 'Datos del destinatario',
  },
  fields: {
    province: 'Provincia',
    zipCode: 'Código postal',
    city: 'Ciudad',
    address: 'Calle',
    number: 'Número',
    complement: 'Departamento',
    neighborhood: 'Barrio',
    fullName: 'Nombre completo',
  },
} as const;

export type MessageLabels = typeof MESSAGE_LABELS;
