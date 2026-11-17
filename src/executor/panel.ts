/**
 * Panel facts that both the session and the page object need.
 *
 * Verified by DOM inspection (docs/plans/mvp-01-manual-shipment.md §4c): the
 * Envío Nube UI is a cross-origin iframe inside the store admin, and the app is
 * hash-routed. The frame is located by `src` substring, never by index: the page
 * also hosts the Tiendanube validator, Google reCAPTCHA, Cloudflare Turnstile and
 * two `about:blank` frames.
 *
 * The store admin origin is **configuration, not a fact**: it comes from
 * `MDL_STORE_ORIGIN` and is resolved lazily, so importing this module never
 * requires the variable. There is deliberately no default: a committed default
 * would publish one operator's store and make the tool unusable for any other.
 */

import { readEnv } from './env';
import { ExecutorError } from './errors';

/** Substring of the Envío Nube iframe `src`. Never locate the frame by index. */
export const ENVIO_NUBE_FRAME_HOST = 'services-ne-app-front-ar.nuvemshop.com.br';

/** Host of the bot-protection frames that must never be automated. */
export const BOT_CHALLENGE_FRAME_HOST = 'challenges.cloudflare.com';

/** Variable that supplies the operator's store admin origin. */
export const STORE_ORIGIN_VARIABLE = 'MDL_STORE_ORIGIN';

/** Expected shape, shown verbatim whenever the variable is missing or unusable. */
export const STORE_ORIGIN_EXPECTED_SHAPE = 'https://<store>.mitiendanube.com';

/** Envío Nube app root inside the store admin; the rest of the URL is the hash route. */
const ENVIO_NUBE_APP_PATH = '/admin/apps/envionube/ar';

/** A bare host, optionally with a port. No userinfo, path, query or fragment. */
const STORE_ORIGIN_HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d{1,5})?$/;

const HTTPS_SCHEME = 'https://';

function storeOriginRefusal(problem: string, details: readonly string[] = []): ExecutorError {
  return new ExecutorError(`the store admin origin is not usable: ${problem}`, [
    `variable: ${STORE_ORIGIN_VARIABLE}`,
    `expected shape: ${STORE_ORIGIN_EXPECTED_SHAPE} — the https:// scheme plus a bare host, nothing else`,
    ...details,
  ]);
}

/**
 * Reads and validates `MDL_STORE_ORIGIN`, returning `https://host` with any
 * trailing slash removed so composed URLs never double up.
 *
 * Refuses, loudly, when the variable is absent, empty, not `https://`, a bare
 * host with no scheme, or anything that is not exactly scheme + host.
 */
export function resolveStoreOrigin(): string {
  const raw = readEnv(STORE_ORIGIN_VARIABLE);
  if (raw === undefined) {
    throw storeOriginRefusal('the variable is missing or empty', [
      'there is no default: the store belongs to whoever runs this tool, so it is never committed',
    ]);
  }

  const withoutTrailingSlashes = raw.replace(/\/+$/, '');
  if (!withoutTrailingSlashes.toLowerCase().startsWith(HTTPS_SCHEME)) {
    throw storeOriginRefusal(`"${raw}" does not start with ${HTTPS_SCHEME}`, [
      'a bare host with no scheme and a plain http:// URL are both rejected',
    ]);
  }

  const host = withoutTrailingSlashes.slice(HTTPS_SCHEME.length);
  if (!STORE_ORIGIN_HOST_PATTERN.test(host)) {
    throw storeOriginRefusal(`"${raw}" is not ${HTTPS_SCHEME} plus a bare host`, [
      'a host with a path, query, fragment or userinfo is rejected',
    ]);
  }

  return `${HTTPS_SCHEME}${host}`;
}

/** Manual-shipment entry point inside the store admin. Resolved on demand. */
export function storeAdminUrl(): string {
  return `${resolveStoreOrigin()}${ENVIO_NUBE_APP_PATH}#/create-single-shipment`;
}

/**
 * Envío Nube dashboard (`#/dashboard`, plan §4c). Used read-only, and only to
 * reconcile an unknown creation outcome. Resolved on demand.
 */
export function adminAppDashboardUrl(): string {
  return `${resolveStoreOrigin()}${ENVIO_NUBE_APP_PATH}#/dashboard`;
}
