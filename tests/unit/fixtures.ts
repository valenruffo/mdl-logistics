/**
 * Fictional message fixtures (R11: invented data only — never a real customer
 * name, address or postal code).
 *
 * Shape mirrors docs/plans/mvp-01-manual-shipment.md §7 (B1) plus the
 * `Código postal:` line that the operator confirmed is now part of the message.
 */

export const HAPPY_MESSAGE = [
  'MDL - Datos de envío',
  '',
  'Destino',
  'Provincia: Ciudad Autónoma de Buenos Aires (CABA)',
  'Código postal: 1901',
  'Ciudad: Villa Ejemplo',
  'Calle: Calle Falsa',
  'Número: 742',
  'Departamento: 2b',
  'Barrio: Villa Ejemplo',
  '',
  'Datos del destinatario',
  'Nombre completo: juan perez',
].join('\n');

/** Same message, CRLF line endings. */
export const HAPPY_MESSAGE_CRLF = HAPPY_MESSAGE.replaceAll('\n', '\r\n');

/** Helper: drop one line that starts with the given prefix. */
export function withoutLine(message: string, linePrefix: string): string {
  return message
    .split('\n')
    .filter((line) => !line.toLowerCase().startsWith(linePrefix.toLowerCase()))
    .join('\n');
}

/** Helper: append raw lines to a message. */
export function withLines(message: string, lines: readonly string[]): string {
  return [message, '', ...lines].join('\n');
}

/**
 * The same message as it actually arrives from WhatsApp: every label and both
 * headings wrapped in bold markers, plus the postal code line.
 *
 * Postal code `1419` and the name are the ones the operator's sample used; the
 * remaining values stay invented.
 */
export const WHATSAPP_MESSAGE = [
  '*MDL - Datos de envío*',
  '',
  '*Destino*',
  '*Código postal*: 1419',
  '*Provincia*: Ciudad Autónoma de Buenos Aires (CABA)',
  '*Ciudad*: Villa Ejemplo',
  '*Calle*: Calle Falsa',
  '*Número*: 742',
  '*Departamento*: 2b',
  '*Barrio*: Villa Ejemplo',
  '',
  '*Datos del destinatario*',
  '*Nombre completo*: juan perez',
].join('\n');

/**
 * The new (v2) domicilio format: the same v1 message with the `Modalidad` line
 * the updated client form now emits.
 */
export const MODALITY_DOMICILE_MESSAGE = [
  '*MDL - Datos de envío*',
  '',
  'Modalidad: domicilio',
  '',
  '*Destino*',
  '*Código postal*: 1901',
  '*Provincia*: Ciudad Autónoma de Buenos Aires (CABA)',
  '*Ciudad*: Villa Ejemplo',
  '*Calle*: Calle Falsa',
  '*Número*: 742',
  '*Departamento*: 2b',
  '*Barrio*: Villa Ejemplo',
  '',
  '*Datos del destinatario*',
  '*Nombre completo*: juan perez',
].join('\n');

/**
 * The frozen sucursal format: `Nombre`/`Apellido` separated, `Email` and
 * `Teléfono` optional, no destination address group. Every value is fictional
 * (R11).
 */
export const SUCURSAL_MESSAGE = [
  '*MDL - Datos de envío*',
  '',
  'Modalidad: sucursal',
  'Sucursal (nombre): Sucursal Villa Ejemplo - Av. Falsa 123',
  '*Código postal*: 1419',
  '',
  '*Datos del destinatario*',
  '*Nombre*: Juan',
  '*Apellido*: Pérez',
  '*Email*: juan@ejemplo.com',
  '*Teléfono*: 1122334455',
].join('\n');
