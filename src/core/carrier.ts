/**
 * The single carrier of MVP 01 (plan §4b, S8: `Andreani a domicilio`).
 *
 * It is a **leaf module on purpose**: three different processes need this one
 * string — the CLI gates (which hash the approved payload), the local UI (which
 * prints it in the preview) and the browser page object (which selects the radio
 * with that accessible name). Getting the string must not cost the browser
 * stack, so this file imports nothing at all.
 *
 * Never substitute another carrier silently: choosing a different service is a
 * product decision and, at that point, a wrong shipment (R12).
 */
export const CARRIER_NAME = 'Andreani a domicilio';
