/**
 * The login fixtures every UI test shares.
 *
 * The server no longer serves anything without a session, so a test that talks to
 * it needs three things: a configuration (`TEST_AUTH`), a way to send a valid
 * cookie (`authFetch`, `sessionCookieHeader`) and, for the pure dispatcher, a
 * request context (`testContext`).
 *
 * Everything here is fictional and offline: a throwaway password, a throwaway
 * secret and a hash built with the same documented format the operator generates.
 * Nothing in this file is a credential for a real deployment.
 */
import { scryptSync, randomBytes } from 'node:crypto';

import {
  SESSION_COOKIE_NAME,
  createAuthRuntime,
  createSessionToken,
  readAuthConfig,
  sessionCookie,
  type AuthConfig,
  type AuthRuntime,
} from '../../src/ui/auth';
import type { RouteContext } from '../../src/ui/server';

/** A throwaway password. Never used outside tests. */
export const TEST_PASSWORD = 'contrasena-ficticia-de-prueba';

/** A throwaway secret: 64 hex characters, the documented shape. */
export const TEST_SESSION_SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

/**
 * Builds a stored hash in the documented `scrypt$N$r$p$salt$key` format. This is
 * the same arithmetic the operator's generator command runs; a test asserts that
 * the command and this helper agree.
 */
export function passwordHashFor(password: string, saltHex?: string): string {
  const salt = saltHex === undefined ? randomBytes(16) : Buffer.from(saltHex, 'hex');
  const n = 16_384;
  const r = 8;
  const p = 1;
  // The salt *bytes* are hashed with, exactly as the documented generator does;
  // the hex is only how those bytes are stored in the hash string.
  const key = scryptSync(password, salt, 32, { N: n, r, p, maxmem: 64 * 1024 * 1024 });
  return ['scrypt', n, r, p, salt.toString('hex'), key.toString('hex')].join('$');
}

/** The configuration every test server starts with. */
export const TEST_PASSWORD_HASH = passwordHashFor(TEST_PASSWORD);
export const TEST_AUTH: AuthConfig = readAuthConfig({
  MDL_PASSWORD_HASH: TEST_PASSWORD_HASH,
  MDL_SESSION_SECRET: TEST_SESSION_SECRET,
});

/** A runtime with no request in flight, for the pure dispatcher tests. */
export const TEST_RUNTIME: AuthRuntime = createAuthRuntime(TEST_AUTH);

/** `mdl_session=<value>`: exactly what a browser would put in its `cookie` header. */
export function sessionCookieHeader(now: number = Date.now(), secret: string = TEST_SESSION_SECRET): string {
  const value = sessionCookie(createSessionToken(secret, now));
  return value.slice(0, value.indexOf(';'));
}

/** A dispatcher context that is authenticated, from the loopback address. */
export function testContext(overrides: Partial<RouteContext> = {}): RouteContext {
  return {
    auth: TEST_RUNTIME,
    cookieHeader: sessionCookieHeader(),
    address: '127.0.0.1',
    now: Date.now(),
    ...overrides,
  };
}

/** `fetch` with a fresh session cookie. The expiry is 30 days, so it is usable. */
export function authFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = { ...((init.headers as Record<string, string> | undefined) ?? {}) };
  headers['cookie'] = sessionCookieHeader();
  return fetch(url, { ...init, headers });
}

/** `fetch` with an explicitly chosen cookie header (including a broken one). */
export function fetchWithCookie(url: string, cookie: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = { ...((init.headers as Record<string, string> | undefined) ?? {}) };
  headers['cookie'] = cookie;
  return fetch(url, { ...init, headers });
}

/** The cookie name, re-exported so a test does not repeat the literal. */
export const COOKIE_NAME = SESSION_COOKIE_NAME;
