/**
 * The app's own front door.
 *
 * Nginx used to answer with the browser's native Basic Auth dialog; the page
 * itself had no authentication. These tests pin the replacement:
 *
 *  1. the exception list is exactly `GET /login`, `GET /app.js` and
 *     `POST /api/login`, declared as data and asserted against the route table;
 *  2. a correct password sets one signed cookie with the required flags, and that
 *     cookie opens the page, the console and every action;
 *  3. a wrong password is a generic `401` with no cookie and no hint about the
 *     configuration;
 *  4. a tampered, expired or malformed cookie is not a session — same `302`/`401`;
 *  5. five failures per client per fifteen minutes, then a `429` with
 *     `Retry-After`, and a successful login clears the client's budget;
 *  6. the budget cannot be bypassed by concurrency: the attempt is reserved before
 *     any `await`, at most one scrypt runs at a time and a concurrent attempt gets
 *     the documented `429` and gives its reservation back;
 *  7. the bucket is keyed on the real client, not on the loopback proxy:
 *     `X-Real-IP` is honoured only when the peer is loopback and only when it
 *     parses as an IP, and `X-Forwarded-For` is never read;
 *  8. the password, the hash and the secret appear in no response body, no header
 *     and no log line;
 *  9. startup refuses to run without `MDL_PASSWORD_HASH` and
 *     `MDL_SESSION_SECRET`, names the missing variable, and substitutes no default.
 *
 * Everything is loopback, fictional and offline: a temporary record directory, an
 * executor that refuses to run and an injected session-check runner.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  AuthConfigError,
  LOGIN_API_PATH,
  LOGIN_BUSY_MESSAGE,
  LOGIN_BUSY_RETRY_AFTER_SECONDS,
  LOGIN_FAILED_MESSAGE,
  LOGIN_FAILURE_LIMIT,
  LOGIN_FAILURE_WINDOW_MS,
  LOGIN_PATH,
  LOGOUT_API_PATH,
  LoginRateLimiter,
  PASSWORD_HASH_COMMAND,
  PASSWORD_HASH_SCRIPT,
  PASSWORD_HASH_VARIABLE,
  SESSION_COOKIE_NAME,
  SESSION_SECRET_COMMAND,
  SESSION_SECRET_SCRIPT,
  SESSION_SECRET_VARIABLE,
  SESSION_TTL_SECONDS,
  createPasswordGate,
  createSessionToken,
  expiredSessionCookie,
  parseStoredHash,
  readAuthConfig,
  readCookie,
  sessionCookie,
  verifyPassword,
  verifySessionToken,
  type StoredPasswordHash,
} from '../../src/ui/auth';
import { LOGIN_HTML, LOGIN_ERROR_FALLBACK } from '../../src/ui/login';
import {
  PUBLIC_ROUTE_KEYS,
  UNAUTHORIZED_MESSAGE,
  clientAddress,
  createRoutes,
  startUiServer,
  type UiServerOptions,
} from '../../src/ui/server';
import type { ActionDeps } from '../../src/ui/actions';
import { HAPPY_MESSAGE } from './fixtures';
import {
  TEST_AUTH,
  TEST_PASSWORD,
  TEST_PASSWORD_HASH,
  TEST_SESSION_SECRET,
  passwordHashFor,
  sessionCookieHeader,
} from './auth-fixtures';

// ------------------------------------------------------------------ fixtures

interface Box {
  root: string;
  recordDir: string;
  artifactsDir: string;
  historyPath: string;
}

async function box(name: string): Promise<Box> {
  const root = await mkdtemp(path.join(tmpdir(), `mdl-auth-${name}-`));
  return {
    root,
    recordDir: path.join(root, 'run-records'),
    artifactsDir: path.join(root, 'artifacts'),
    historyPath: path.join(root, 'ui', 'session-checks.json'),
  };
}

function serverDeps(target: Box): ActionDeps {
  return {
    executor: {
      runDryRun: async () => {
        throw new Error('the panel is not a test dependency');
      },
      runCreate: async () => {
        throw new Error('the panel is not a test dependency');
      },
    },
    recordDir: target.recordDir,
    console: {
      artifactsDir: target.artifactsDir,
      sessionCheckHistoryPath: target.historyPath,
      sessionCheckRunner: async () => ({
        exitCode: 0,
        stdout: 'OK: la sesión es utilizable.',
        stderr: '',
        spawnProblem: null,
        durationMs: 2,
      }),
      processInfo: { pid: 4242, nodeVersion: 'v22.0.0', uptimeSeconds: 1, platform: 'linux', cwd: target.root },
    },
  };
}

async function start(target: Box, extra: Partial<UiServerOptions> = {}) {
  return await startUiServer({ port: 0, deps: serverDeps(target), auth: TEST_AUTH, ...extra });
}

function login(url: string, password: string): Promise<Response> {
  return fetch(`${url}${LOGIN_API_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
}

/** The same POST, with the headers a proxied request carries. */
function loginFrom(url: string, headers: Record<string, string>, password: string): Promise<Response> {
  return fetch(`${url}${LOGIN_API_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ password }),
  });
}

function rawCookie(response: Response): string | null {
  return response.headers.get('set-cookie');
}

/** `mdl_session=<value>` out of a `Set-Cookie` header. */
function cookiePair(response: Response): string {
  const raw = rawCookie(response);
  assert.ok(raw, 'the response must set a cookie');
  return raw.slice(0, raw.indexOf(';'));
}

function withCookie(cookie: string): { cookie: string } {
  return { cookie };
}

/** Every header value of a response, joined, for the leak checks. */
function headerText(response: Response): string {
  const parts: string[] = [];
  response.headers.forEach((value, name) => {
    parts.push(`${name}: ${value}`);
  });
  return parts.join('\n');
}

const PROTECTED: readonly { method: 'GET' | 'POST'; path: string; api: boolean }[] = [
  { method: 'GET', path: '/', api: false },
  { method: 'GET', path: '/api/console', api: true },
  { method: 'POST', path: '/api/analyze', api: true },
  { method: 'POST', path: '/api/run', api: true },
  { method: 'POST', path: '/api/session-check', api: true },
  { method: 'POST', path: LOGOUT_API_PATH, api: true },
];

// ------------------------------------------------ 1. the exception list is data

test('the exception list is exactly the login card, its script and the login POST', async () => {
  const target = await box('public');
  try {
    const routes = createRoutes(serverDeps(target));
    const declaredPublic = routes
      .filter((route) => route.public)
      .map((route) => `${route.method} ${route.path}`)
      .sort();

    assert.deepEqual(declaredPublic, [...PUBLIC_ROUTE_KEYS].sort());
    assert.deepEqual(declaredPublic, ['GET /app.js', 'GET /login', 'POST /api/login']);

    const started = await start(target);
    try {
      const card = await fetch(`${started.url}${LOGIN_PATH}`);
      assert.equal(card.status, 200);
      assert.match(card.headers.get('content-type') ?? '', /text\/html/);
      const html = await card.text();
      assert.equal(html, LOGIN_HTML);

      const script = await fetch(`${started.url}/app.js`);
      assert.equal(script.status, 200);
      assert.match(script.headers.get('content-type') ?? '', /javascript/);

      // The login POST is reachable with no cookie at all: this is the only route
      // that can turn a password into a session.
      const attempt = await login(started.url, 'no-es-la-contrasena');
      assert.equal(attempt.status, 401);
    } finally {
      await started.close();
    }
  } finally {
    await rm(target.root, { recursive: true, force: true });
  }
});

// --------------------------------------------- 2. a correct password opens it

test('a correct password sets one usable cookie with the required flags', async () => {
  const target = await box('login-ok');
  try {
    const started = await start(target);
    try {
      // Behind the TLS proxy this is what a browser receives, so the flag is here.
      const response = await loginFrom(started.url, { 'x-forwarded-proto': 'https' }, TEST_PASSWORD);
      assert.equal(response.status, 200);

      const raw = rawCookie(response);
      assert.ok(raw, 'a successful login sets a cookie');
      assert.match(raw, new RegExp(`^${SESSION_COOKIE_NAME}=\\d{1,12}\\.[0-9a-f]{32}\\.[0-9a-f]{64}(;|$)`));
      assert.match(raw, /HttpOnly/);
      assert.match(raw, /Secure/);
      assert.match(raw, /SameSite=Strict/);
      assert.match(raw, /Path=\//);
      assert.match(raw, new RegExp(`Max-Age=${SESSION_TTL_SECONDS}`));
      assert.doesNotMatch(raw, /Domain=/i, 'the cookie belongs to the host that served it');

      const cookie = cookiePair(response);

      const page = await fetch(`${started.url}/`, { headers: withCookie(cookie) });
      assert.equal(page.status, 200, 'the cookie opens the page');
      assert.match(await page.text(), /<textarea/);

      const console = await fetch(`${started.url}/api/console`, { headers: withCookie(cookie) });
      assert.equal(console.status, 200, 'the cookie opens the console snapshot');
      const snapshot = (await console.json()) as { readAt: string };
      assert.equal(typeof snapshot.readAt, 'string');

      // The script the page needs is public on purpose: the login card is the only
      // page that exists before a session, and it loads no external script.
      assert.equal((await fetch(`${started.url}/app.js`)).status, 200);

      // Over plain `http://127.0.0.1` the same login must send the cookie without
      // `Secure`: a browser drops it and the login loops with no error at all.
      assert.doesNotMatch(rawCookie(await login(started.url, TEST_PASSWORD)) ?? '', /Secure/);
    } finally {
      await started.close();
    }
  } finally {
    await rm(target.root, { recursive: true, force: true });
  }
});

test('the token is scrypt-verified, expires in thirty days and survives the store round trip', async () => {
  const token = createSessionToken(TEST_SESSION_SECRET, 1_800_000_000_000);
  assert.match(token.value, /^\d{1,12}\.[0-9a-f]{32}\.[0-9a-f]{64}$/);
  assert.equal(token.expiry, 1_800_000_000 + SESSION_TTL_SECONDS);

  const verdict = verifySessionToken(token.value, TEST_SESSION_SECRET, 1_800_000_000_000);
  assert.deepEqual(verdict, { ok: true, expiry: token.expiry });

  const stored = parseStoredHash(TEST_PASSWORD_HASH);
  assert.ok(stored, 'the documented format parses');
  assert.equal(await verifyPassword(TEST_PASSWORD, stored), true);
  assert.equal(await verifyPassword(`${TEST_PASSWORD} `, stored), false);
  assert.equal(await verifyPassword('', stored), false);
});

// ------------------------------------------------ 3. a wrong password is mute

test('a wrong password is a 401 with no cookie and one generic sentence', async () => {
  const target = await box('login-bad');
  try {
    const started = await start(target);
    try {
      for (const attempt of [
        await login(started.url, 'no-es-la-contrasena'),
        await login(started.url, ''),
        await fetch(`${started.url}${LOGIN_API_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' }),
        await fetch(`${started.url}${LOGIN_API_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) }),
      ]) {
        assert.equal(attempt.status, 401);
        assert.equal(rawCookie(attempt), null, 'a failed login sets nothing');

        const text = await attempt.text();
        const body = JSON.parse(text) as { status: string; reason: string };
        assert.deepEqual(Object.keys(body).sort(), ['reason', 'status']);
        assert.equal(body.status, 'unauthorized');
        assert.equal(body.reason, LOGIN_FAILED_MESSAGE, 'every failure reads the same');
        assert.doesNotMatch(text, new RegExp(PASSWORD_HASH_VARIABLE));
        assert.doesNotMatch(text, /scrypt/i);
        assert.doesNotMatch(text, /configur/i);
      }
    } finally {
      await started.close();
    }
  } finally {
    await rm(target.root, { recursive: true, force: true });
  }
});

// ------------------------------- 4. tampered, expired and malformed are not sessions

test('a tampered, expired or malformed cookie is unauthenticated on every protected route', async () => {
  const target = await box('cookie-shapes');
  try {
    const started = await start(target);
    try {
      const now = Date.now();
      const valid = createSessionToken(TEST_SESSION_SECRET, now).value;
      const [expiry, nonce, mac] = valid.split('.') as [string, string, string];

      const forgedSecret = createSessionToken('f'.repeat(64), now).value;
      const expired = createSessionToken(TEST_SESSION_SECRET, now, -1).value;

      const bad: readonly [string, string][] = [
        ['tampered mac', `${expiry}.${nonce}.${mac.slice(0, -1)}${mac.endsWith('a') ? 'b' : 'a'}`],
        ['tampered expiry', `${Number(expiry) + 60}.${nonce}.${mac}`],
        ['tampered nonce', `${expiry}.${'0'.repeat(32)}.${mac}`],
        ['signed with another secret', forgedSecret],
        ['expired', expired],
        ['empty', ''],
        ['no dots', 'not-a-session'],
        ['two parts', `${expiry}.${nonce}`],
        ['four parts', `${valid}.extra`],
        ['non-numeric expiry', `soon.${nonce}.${mac}`],
        ['short mac', `${expiry}.${nonce}.${mac.slice(0, 32)}`],
        ['non-hex mac', `${expiry}.${nonce}.${'z'.repeat(64)}`],
      ];

      for (const [name, value] of bad) {
        const cookie = `${SESSION_COOKIE_NAME}=${value}`;
        for (const route of PROTECTED) {
          const response = await fetch(`${started.url}${route.path}`, {
            method: route.method,
            headers: { cookie },
            redirect: 'manual',
            ...(route.method === 'POST' ? { body: '{}' } : {}),
          });
          assert.equal(response.status, route.api ? 401 : 302, `${name} must not open ${route.path}`);
          assert.equal(response.ok, false, `${name} must not render ${route.path}`);
        }
      }

      // And the reasons, so a future edit cannot turn "malformed" into "ok".
      assert.deepEqual(verifySessionToken('', TEST_SESSION_SECRET, now), { ok: false, reason: 'missing' });
      assert.deepEqual(verifySessionToken(undefined, TEST_SESSION_SECRET, now), { ok: false, reason: 'missing' });
      assert.equal(verifySessionToken('nope', TEST_SESSION_SECRET, now).ok, false);
      assert.deepEqual(verifySessionToken(expired, TEST_SESSION_SECRET, now), { ok: false, reason: 'expired' });
      assert.deepEqual(verifySessionToken(forgedSecret, TEST_SESSION_SECRET, now), {
        ok: false,
        reason: 'bad-signature',
      });
      assert.equal(verifySessionToken(valid, TEST_SESSION_SECRET, now).ok, true);
    } finally {
      await started.close();
    }
  } finally {
    await rm(target.root, { recursive: true, force: true });
  }
});

// ------------------------------------------------- 5. the whole route matrix

test('every protected route is a 302 or a 401 without a session and works with one', async () => {
  const target = await box('matrix');
  try {
    const started = await start(target);
    try {
      // Without a session: a browser gets the card, an API caller gets one shape.
      for (const route of PROTECTED) {
        const response = await fetch(`${started.url}${route.path}`, {
          method: route.method,
          redirect: 'manual',
          ...(route.method === 'POST' ? { body: '{}' } : {}),
        });

        if (route.api) {
          assert.equal(response.status, 401, `${route.method} ${route.path} must be a 401`);
          assert.match(response.headers.get('content-type') ?? '', /application\/json/);
          const body = (await response.json()) as { status: string; reason: string };
          assert.deepEqual(Object.keys(body).sort(), ['reason', 'status']);
          assert.equal(body.status, 'unauthorized');
          assert.equal(body.reason, UNAUTHORIZED_MESSAGE);
        } else {
          assert.equal(response.status, 302, `${route.method} ${route.path} must be a 302`);
          assert.equal(response.headers.get('location'), LOGIN_PATH);
        }
      }

      // An unknown path is not a way to learn the surface either.
      const unknown = await fetch(`${started.url}/artifacts/executor-fixture/trace.zip`, { redirect: 'manual' });
      assert.equal(unknown.status, 302);
      assert.equal(unknown.headers.get('location'), LOGIN_PATH);

      const cookie = sessionCookieHeader();

      const page = await fetch(`${started.url}/`, { headers: { cookie } });
      assert.equal(page.status, 200);

      const snapshot = await fetch(`${started.url}/api/console`, { headers: { cookie } });
      assert.equal(snapshot.status, 200);
      const parsed = (await snapshot.json()) as { runs: unknown; session: unknown };
      assert.ok(parsed.runs, 'the console snapshot is the real one');
      assert.ok(parsed.session);

      const analyzed = await fetch(`${started.url}/api/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ message: HAPPY_MESSAGE }),
      });
      assert.equal(analyzed.status, 200);
      assert.equal(((await analyzed.json()) as { status: string }).status, 'parsed');

      // The run route answers: an empty form is an invalid form, so nothing is
      // written and the panel is never touched.
      const ran = await fetch(`${started.url}/api/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ mode: 'dry-run' }),
      });
      assert.equal(ran.status, 200);
      assert.equal(((await ran.json()) as { status: string }).status, 'invalid-form');

      const check = await fetch(`${started.url}/api/session-check`, { method: 'POST', headers: { cookie } });
      assert.equal(check.status, 200);
      assert.equal(((await check.json()) as { check: { result: string } }).check.result, 'usable');

      // The one deliberate exception to "no session, no answer": a method that
      // does not exist on a protected path is still a 405 once authenticated.
      const wrongMethod = await fetch(`${started.url}/`, { method: 'POST', headers: { cookie }, body: '{}' });
      assert.equal(wrongMethod.status, 405);
      const missing = await fetch(`${started.url}/artifacts/x`, { headers: { cookie } });
      assert.equal(missing.status, 404);

      const logout = await fetch(`${started.url}${LOGOUT_API_PATH}`, {
        method: 'POST',
        headers: { cookie, 'x-forwarded-proto': 'https' },
        redirect: 'manual',
      });
      assert.equal(logout.status, 303);
      assert.equal(logout.headers.get('location'), LOGIN_PATH);
      const cleared = rawCookie(logout);
      assert.ok(cleared, 'logout sets the cookie again, expired');
      assert.match(cleared, new RegExp(`^${SESSION_COOKIE_NAME}=;`));
      assert.match(cleared, /Max-Age=0/);
      assert.match(cleared, /Path=\//);
      assert.match(cleared, /HttpOnly/);
      assert.match(cleared, /Secure/);
      assert.match(cleared, /SameSite=Strict/);
      assert.doesNotMatch(cleared, /Domain=/i);
    } finally {
      await started.close();
    }
  } finally {
    await rm(target.root, { recursive: true, force: true });
  }
});

test('the console routes and the run route keep their behaviour once authenticated', async () => {
  const target = await box('lock');
  try {
    const { browserLock } = await import('../../src/ui/lock');
    assert.equal(browserLock.free, true);

    const started = await start(target);
    const cookie = sessionCookieHeader();
    try {
      // Two browser-taking routes still collide on the one lock: the 409 is the
      // lock's, not the auth layer's, so an authenticated request is never turned
      // into a 401 by the new gate.
      const holder = await import('../../src/ui/lock');
      const lease = holder.browserLock.tryAcquire('session-check');
      assert.equal(lease.ok, true);

      const busyRun = await fetch(`${started.url}/api/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ mode: 'dry-run' }),
      });
      assert.equal(busyRun.status, 409);
      const busyBody = (await busyRun.json()) as { status: string };
      assert.equal(busyBody.status, 'busy');

      if (lease.ok) lease.release();
      assert.equal(browserLock.free, true);
    } finally {
      await started.close();
      assert.equal(browserLock.free, true);
    }
  } finally {
    await rm(target.root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ 6. the rate limit

test('five wrong passwords per address, then a 429 with Retry-After', async () => {
  const target = await box('rate');
  try {
    const started = await start(target);
    try {
      for (let attempt = 1; attempt <= LOGIN_FAILURE_LIMIT; attempt += 1) {
        const response = await login(started.url, `intento-${attempt}`);
        assert.equal(response.status, 401, `failure ${attempt} is still a 401`);
      }

      // The sixth attempt is refused before the password is even compared: the
      // correct password gets the same 429, so the answer cannot confirm a guess.
      const blocked = await login(started.url, TEST_PASSWORD);
      assert.equal(blocked.status, 429);
      const retryAfter = blocked.headers.get('retry-after');
      assert.ok(retryAfter, 'the 429 says when to come back');
      const seconds = Number(retryAfter);
      assert.ok(Number.isInteger(seconds) && seconds > 0 && seconds <= LOGIN_FAILURE_WINDOW_MS / 1000);

      const text = await blocked.text();
      const body = JSON.parse(text) as { status: string; reason: string };
      assert.equal(body.status, 'rate-limited');
      assert.match(body.reason, /Demasiados intentos fallidos/);
      assert.match(body.reason, /\d+ s/);
      assert.doesNotMatch(text, new RegExp(TEST_SESSION_SECRET));
      assert.equal(rawCookie(blocked), null);
    } finally {
      await started.close();
    }
  } finally {
    await rm(target.root, { recursive: true, force: true });
  }
});

test('a successful login resets the address budget, and success is never a failure', async () => {
  const target = await box('rate-reset');
  try {
    const started = await start(target);
    try {
      for (let attempt = 1; attempt <= LOGIN_FAILURE_LIMIT - 1; attempt += 1) {
        assert.equal((await login(started.url, `fallo-${attempt}`)).status, 401);
      }

      const ok = await login(started.url, TEST_PASSWORD);
      assert.equal(ok.status, 200, 'a success below the limit always works');
      assert.ok(rawCookie(ok));

      // Without the reset, the next failure would already be the sixth and a 429.
      for (let attempt = 1; attempt <= LOGIN_FAILURE_LIMIT; attempt += 1) {
        assert.equal((await login(started.url, `otra-vez-${attempt}`)).status, 401, `failure ${attempt} after the reset`);
      }
      assert.equal((await login(started.url, 'una-mas')).status, 429);
    } finally {
      await started.close();
    }
  } finally {
    await rm(target.root, { recursive: true, force: true });
  }
});

test('the failure budget is per address and forgets a window that has passed', () => {
  let clock = 1_800_000_000_000;
  const limiter = new LoginRateLimiter({ now: () => clock, limit: 3, windowMs: 60_000 });

  for (let attempt = 0; attempt < 3; attempt += 1) limiter.recordFailure('10.0.0.1');
  assert.equal(limiter.check('10.0.0.1').allowed, false);
  assert.equal(limiter.check('10.0.0.1').retryAfterSeconds, 60);
  assert.equal(limiter.check('10.0.0.2').allowed, true, 'another address has its own budget');

  clock += 59_000;
  assert.equal(limiter.check('10.0.0.1').allowed, false);
  clock += 2_000;
  assert.equal(limiter.check('10.0.0.1').allowed, true, 'the window slides, nothing is sticky');

  limiter.recordFailure('10.0.0.1');
  limiter.recordFailure('10.0.0.1');
  limiter.recordFailure('10.0.0.1');
  assert.equal(limiter.check('10.0.0.1').allowed, false);
  limiter.reset('10.0.0.1');
  assert.equal(limiter.check('10.0.0.1').allowed, true, 'a reset clears the address');
});

// ------------------------------------------------------------- 7. nothing leaks

test('no password, hash or secret appears in any response body, header or log line', async () => {
  const target = await box('leaks');
  try {
    const started = await start(target);
    try {
      const cookie = sessionCookieHeader();
      const bodies: [string, string][] = [];
      const headers: [string, string][] = [];

      const remember = async (name: string, response: Response): Promise<void> => {
        bodies.push([name, await response.text()]);
        headers.push([name, headerText(response)]);
      };

      await remember('GET /login', await fetch(`${started.url}${LOGIN_PATH}`));
      await remember('GET /app.js', await fetch(`${started.url}/app.js`));
      await remember('GET / unauthenticated', await fetch(`${started.url}/`, { redirect: 'manual' }));
      await remember('GET /api/console unauthenticated', await fetch(`${started.url}/api/console`));
      await remember('POST /api/login wrong', await login(started.url, 'intento-fallido'));
      const success = await login(started.url, TEST_PASSWORD);
      await remember('POST /api/login right', success.clone());
      await remember('POST /api/analyze', await fetch(`${started.url}/api/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ message: HAPPY_MESSAGE }),
      }));
      await remember('GET /api/console', await fetch(`${started.url}/api/console`, { headers: { cookie } }));
      await remember('POST /api/logout', await fetch(`${started.url}${LOGOUT_API_PATH}`, {
        method: 'POST',
        headers: { cookie },
        redirect: 'manual',
      }));

      for (let attempt = 0; attempt < LOGIN_FAILURE_LIMIT; attempt += 1) {
        await login(started.url, 'golpe');
      }
      await remember('POST /api/login rate limited', await login(started.url, TEST_PASSWORD));

      const secrets = [TEST_PASSWORD, TEST_PASSWORD_HASH, TEST_SESSION_SECRET];
      for (const [name, body] of bodies) {
        for (const secret of secrets) {
          assert.equal(body.includes(secret), false, `${name} must not carry a secret`);
        }
        assert.doesNotMatch(body, /scrypt\$/, `${name} must not describe the stored hash`);
        assert.doesNotMatch(body, /MDL_PASSWORD_HASH|MDL_SESSION_SECRET/, `${name} must not name the config`);
      }
      for (const [name, text] of headers) {
        for (const secret of secrets) {
          assert.equal(text.includes(secret), false, `${name} headers must not carry a secret`);
        }
      }

      // The cookie carries a MAC, which is derived from the secret but is not it.
      const set = rawCookie(success);
      assert.ok(set);
      assert.equal(set.includes(TEST_SESSION_SECRET), false);

      // And the module cannot log: comments aside, the only `console.` in the file
      // is inside the pair of one-line generator scripts the operator runs by
      // hand, whose whole job is to print the value they just generated.
      const source = readFileSync(path.resolve('src/ui/auth.ts'), 'utf8');
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
        .split('\n')
        // The two generator scripts are the exception: printing their result is
        // their whole purpose, and they run by hand, never on a request.
        .filter((line) => !(line.includes('console.log') && (line.includes('scryptSync') || line.includes('SESSION_SECRET_SCRIPT'))))
        .join('\n');
      assert.equal(code.includes('console.'), false, 'the request path must not log anything');
    } finally {
      await started.close();
    }
  } finally {
    await rm(target.root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------ 8. the login page itself

test('the login card uses the artboard tokens and opens no native dialog', () => {
  for (const call of ['alert(', 'confirm(', 'prompt(']) {
    assert.equal(LOGIN_HTML.includes(call), false, `the login card must not contain ${call}`);
  }
  assert.equal(LOGIN_HTML.includes('window.'), false, 'the login card must not reach through window');

  // The form is a real form: one password field, one submit button.
  assert.match(LOGIN_HTML, /<form[^>]+id="login-form"[^>]+method="post"[^>]+action="\/api\/login"/);
  assert.match(LOGIN_HTML, /<input[^>]+id="password"[^>]+type="password"/);
  assert.match(LOGIN_HTML, /autocomplete="current-password"/);
  assert.match(LOGIN_HTML, /<button[^>]+type="submit"/);
  // The error is inline and announced, never a dialog.
  assert.match(LOGIN_HTML, /id="login-error"[^>]+role="alert"/);
  assert.equal(LOGIN_HTML.includes(LOGIN_ERROR_FALLBACK), true);

  // Same tokens as the operator's desk.
  assert.match(LOGIN_HTML, /--bg:#f6f5f2/);
  assert.match(LOGIN_HTML, /--accent:#1f5c4a/);
  assert.match(LOGIN_HTML, /--bad:#c9614f/);
  assert.match(LOGIN_HTML, /--sans:-apple-system/);
  assert.match(LOGIN_HTML, /:focus-visible\s*\{[^}]*outline:2px solid var\(--accent\)/);
  assert.match(LOGIN_HTML, /prefers-reduced-motion:reduce/);

  // The card asks for nothing else: no external script, no stylesheet, no image.
  assert.doesNotMatch(LOGIN_HTML, /<script[^>]+src=/);
  assert.doesNotMatch(LOGIN_HTML, /<link[^>]+href=/);
});

// --------------------------------------------------------- 9. startup refuses

test('startup refuses without the two variables, names the missing one and has no default', () => {
  assert.throws(
    () => readAuthConfig({}),
    (error: unknown) => {
      assert.ok(error instanceof AuthConfigError);
      assert.equal(error.variable, PASSWORD_HASH_VARIABLE);
      assert.match(error.message, new RegExp(PASSWORD_HASH_VARIABLE));
      assert.match(error.message, /no hay contraseña por defecto/);
      return true;
    },
  );

  assert.throws(
    () => readAuthConfig({ [PASSWORD_HASH_VARIABLE]: TEST_PASSWORD_HASH }),
    (error: unknown) => {
      assert.ok(error instanceof AuthConfigError);
      assert.equal(error.variable, SESSION_SECRET_VARIABLE);
      assert.match(error.message, new RegExp(SESSION_SECRET_VARIABLE));
      assert.match(error.message, /no hay secreto por defecto/);
      return true;
    },
  );

  // A value that is not the documented format is refused, not silently accepted.
  for (const bad of ['', '   ', 'hunter2', 'scrypt$16384$8$1$abcd$ef01', `md5$${TEST_PASSWORD_HASH}`]) {
    assert.throws(
      () => readAuthConfig({ [PASSWORD_HASH_VARIABLE]: bad, [SESSION_SECRET_VARIABLE]: TEST_SESSION_SECRET }),
      AuthConfigError,
      `${JSON.stringify(bad)} must not be accepted as a password hash`,
    );
  }

  // A short secret is refused too: 32 characters is the floor the docs promise.
  assert.throws(
    () => readAuthConfig({ [PASSWORD_HASH_VARIABLE]: TEST_PASSWORD_HASH, [SESSION_SECRET_VARIABLE]: 'corto' }),
    AuthConfigError,
  );

  const config = readAuthConfig({
    [PASSWORD_HASH_VARIABLE]: TEST_PASSWORD_HASH,
    [SESSION_SECRET_VARIABLE]: TEST_SESSION_SECRET,
  });
  assert.equal(config.sessionSecret, TEST_SESSION_SECRET);
  assert.ok(config.passwordHash);
});

test('the process exits before listening when the variables are missing', () => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (name === PASSWORD_HASH_VARIABLE || name === SESSION_SECRET_VARIABLE) continue;
    env[name] = value;
  }

  let failed: { status?: number; stderr?: string; stdout?: string } | null = null;
  try {
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', 'src/ui/main.ts'], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    assert.fail(`the server must not start without its configuration: ${stdout}`);
  } catch (error) {
    failed = error as { status?: number; stderr?: string; stdout?: string };
  }

  assert.ok(failed, 'the process must fail');
  assert.equal(failed.status, 2, 'a configuration refusal is a usage exit, not a crash');
  const stderr = failed.stderr ?? '';
  assert.match(stderr, new RegExp(PASSWORD_HASH_VARIABLE));
  assert.match(stderr, /No se puede arrancar la consola/);
  assert.match(stderr, /no sirve nada sin ellos/);
  assert.doesNotMatch(stderr, /127\.0\.0\.1:4319/, 'it never got as far as listening');
  assert.doesNotMatch(failed.stdout ?? '', /consola de mantenimiento/, 'it printed no banner');
});

// -------------------------------------------- 10. the documented commands work

test('the documented generator commands produce values this server accepts', async () => {
  const generated = execFileSync(process.execPath, ['-e', PASSWORD_HASH_SCRIPT, 'contrasena-generada'], {
    encoding: 'utf8',
  }).trim();

  const stored = parseStoredHash(generated);
  assert.ok(stored, 'the generated hash uses the documented format');
  assert.equal(stored.n, 16_384);
  assert.equal(stored.r, 8);
  assert.equal(stored.p, 1);
  assert.equal(await verifyPassword('contrasena-generada', stored), true);
  assert.equal(await verifyPassword('otra', stored), false);

  const secret = execFileSync(process.execPath, ['-e', SESSION_SECRET_SCRIPT], { encoding: 'utf8' }).trim();
  assert.match(secret, /^[0-9a-f]{64}$/);

  // And the two values together are exactly what the process reads.
  const config = readAuthConfig({
    [PASSWORD_HASH_VARIABLE]: generated,
    [SESSION_SECRET_VARIABLE]: secret,
  });
  assert.equal(await verifyPassword('contrasena-generada', config.passwordHash), true);

  // The copy-paste line is the same script, and carries no `$` for a shell to
  // expand: the separator is written as \x24.
  assert.equal(PASSWORD_HASH_COMMAND.includes(PASSWORD_HASH_SCRIPT), true);
  assert.equal(PASSWORD_HASH_COMMAND.includes('$'), false);
  assert.equal(PASSWORD_HASH_COMMAND.includes("'TU-CONTRASENA'"), true);
  assert.equal(SESSION_SECRET_COMMAND.includes(SESSION_SECRET_SCRIPT), true);
  assert.equal(SESSION_SECRET_COMMAND.includes('$'), false);
});

// ------------------------------------------------------ 11. the cookie helpers

test('the cookie helpers agree on one name, one path and one expiry', () => {
  const token = createSessionToken(TEST_SESSION_SECRET, 1_800_000_000_000);
  const live = sessionCookie(token, true);
  const cleared = expiredSessionCookie(true);

  for (const value of [live, cleared]) {
    assert.match(value, new RegExp(`^${SESSION_COOKIE_NAME}=`));
    assert.match(value, /Path=\//);
    assert.match(value, /HttpOnly/);
    assert.match(value, /Secure/);
    assert.match(value, /SameSite=Strict/);
    assert.doesNotMatch(value, /Domain=/i);
  }

  assert.equal(readCookie(`otra=1; ${SESSION_COOKIE_NAME}=${token.value}; x=2`, SESSION_COOKIE_NAME), token.value);
  assert.equal(readCookie(`otra=1`, SESSION_COOKIE_NAME), null);
  assert.equal(readCookie(undefined, SESSION_COOKIE_NAME), null);
  assert.equal(readCookie(`${SESSION_COOKIE_NAME}=`, SESSION_COOKIE_NAME), '');

  // The hash the fixtures build is the format the server parses, with a salt that
  // is fresh per call and therefore not shared between deployments.
  const one = passwordHashFor('x');
  const two = passwordHashFor('x');
  assert.notEqual(one, two, 'the salt must be per password, not global');
  assert.equal(parseStoredHash(one)?.n, 16_384);
});

// ----------------------------- 12. the budget cannot be bypassed by concurrency

test('a parallel burst of wrong passwords cannot exceed the budget or run two scrypts at once', async () => {
  const target = await box('burst');
  try {
    // Every derivation is counted, and the one-slot gate is observed from inside:
    // `peak` is the largest number of verifications that were ever in flight.
    let derivations = 0;
    let inFlight = 0;
    let peak = 0;
    const slowVerifier = async (password: string, stored: StoredPasswordHash): Promise<boolean> => {
      derivations += 1;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25);
      });
      inFlight -= 1;
      return await verifyPassword(password, stored);
    };

    const started = await start(target, { loginVerifier: slowVerifier });
    try {
      let lastStatuses: number[] = [];
      // Five rounds of a fully parallel burst, then a sixth with the budget gone.
      for (let round = 1; round <= LOGIN_FAILURE_LIMIT + 1; round += 1) {
        const burst = Array.from({ length: 20 }, (_, index) => login(started.url, `golpe-${round}-${index}`));
        const responses = await Promise.all(burst);
        lastStatuses = responses.map((response) => response.status);
        for (const response of responses) {
          assert.equal(response.ok, false, 'no parallel wrong password may open a session');
          assert.equal(rawCookie(response), null, 'a wrong password sets no cookie');
        }
      }

      // Every derivation leaves its reservation recorded, so the number of
      // derivations inside the window can never exceed the budget.
      assert.ok(
        derivations <= LOGIN_FAILURE_LIMIT,
        `at most ${LOGIN_FAILURE_LIMIT} derivations per window; observed ${derivations}`,
      );
      assert.equal(peak, 1, 'at most one scrypt verification runs at a time');
      // The last burst runs with the budget spent: every request is a 429,
      // refused before any CPU is spent.
      assert.deepEqual([...new Set(lastStatuses)].sort(), [429], 'a spent budget refuses the whole burst');
    } finally {
      await started.close();
    }
  } finally {
    await rm(target.root, { recursive: true, force: true });
  }
});

test('the reservation is one synchronous step, and a busy slot gives the attempt back', () => {
  let clock = 1_800_000_000_000;
  const limiter = new LoginRateLimiter({ now: () => clock, limit: 2, windowMs: 60_000 });

  const first = limiter.reserve('10.0.0.9');
  assert.equal(first.allowed, true);
  assert.equal(first.retryAfterSeconds, 0);
  assert.equal(typeof first.attemptId, 'number', 'an allowed attempt is recorded and addressable');
  assert.equal(limiter.check('10.0.0.9').allowed, true, 'one of the two is spent');

  const second = limiter.reserve('10.0.0.9');
  assert.equal(second.allowed, true);
  assert.equal(limiter.check('10.0.0.9').allowed, false, 'the second reservation spends the budget');
  assert.equal(limiter.check('10.0.0.11').allowed, true, 'another key keeps its own budget');

  const third = limiter.reserve('10.0.0.9');
  assert.equal(third.allowed, false);
  assert.equal(third.attemptId, null, 'a refused attempt records nothing');
  assert.ok(third.retryAfterSeconds > 0 && third.retryAfterSeconds <= 60);

  // Giving the second back re-opens exactly one slot, never the whole window.
  limiter.release('10.0.0.9', second.attemptId as number);
  assert.equal(limiter.check('10.0.0.9').allowed, true);
  assert.equal(limiter.reserve('10.0.0.9').allowed, true);
  assert.equal(limiter.check('10.0.0.9').allowed, false);

  // A release removes the named attempt, not whichever entry happens to be
  // newest: both ids are given back out of order and the key returns to empty.
  const otherFirst = limiter.reserve('10.0.0.10');
  const otherSecond = limiter.reserve('10.0.0.10');
  assert.equal(limiter.check('10.0.0.10').allowed, false);
  limiter.release('10.0.0.10', otherSecond.attemptId as number);
  limiter.release('10.0.0.10', otherFirst.attemptId as number);
  assert.equal(limiter.check('10.0.0.10').allowed, true);
  assert.equal(limiter.reserve('10.0.0.10').allowed, true);
  assert.equal(limiter.reserve('10.0.0.10').allowed, true);
  assert.equal(limiter.reserve('10.0.0.10').allowed, false, 'both reservations really were removed');
});

test('the gate admits one derivation at a time and reports the busy slot', async () => {
  const stored = parseStoredHash(TEST_PASSWORD_HASH);
  assert.ok(stored);

  let open = (): void => {};
  const held = new Promise<void>((resolve) => {
    open = resolve;
  });
  let calls = 0;
  const gate = createPasswordGate(stored, {
    verify: async (password, hash) => {
      calls += 1;
      await held;
      return await verifyPassword(password, hash);
    },
  });

  const first = gate.check(TEST_PASSWORD);
  assert.equal(gate.running, true, 'the slot is taken before the first await');

  const refused = await gate.check('otra-contrasena');
  assert.deepEqual(refused, { busy: true });
  assert.equal(calls, 1, 'the refused attempt never derived anything');

  open();
  assert.deepEqual(await first, { busy: false, matched: true });
  assert.equal(gate.running, false, 'the slot is given back');

  assert.deepEqual(await gate.check(TEST_PASSWORD), { busy: false, matched: true });
  assert.equal(gate.running, false);
});

test('a derivation that throws still gives the slot back', async () => {
  const stored = parseStoredHash(TEST_PASSWORD_HASH);
  assert.ok(stored);

  const gate = createPasswordGate(stored, {
    verify: async () => {
      throw new Error('the derivation failed');
    },
  });

  assert.equal(gate.running, false);
  await assert.rejects(gate.check(TEST_PASSWORD), /the derivation failed/);
  assert.equal(gate.running, false, 'a failure is not a held slot');
  await assert.rejects(gate.check(TEST_PASSWORD), /the derivation failed/);
});

// -------------------------------------------- 13. the bucket key is the client

test('the budget key is the real client, from X-Real-IP only behind a loopback peer', () => {
  const peer = '127.0.0.1';

  // The proxy case: the header is the client.
  assert.equal(clientAddress(peer, { 'x-real-ip': '203.0.113.9' }), '203.0.113.9');
  assert.equal(clientAddress('::1', { 'x-real-ip': '203.0.113.9' }), '203.0.113.9');
  assert.equal(clientAddress('::ffff:127.0.0.1', { 'x-real-ip': '2001:db8::1' }), '2001:db8::1');
  // An IPv4-mapped client is the same bucket as its plain form.
  assert.equal(clientAddress(peer, { 'x-real-ip': '::ffff:203.0.113.9' }), '203.0.113.9');

  // Not an IP: the peer is all the process can honestly say.
  const junk = ['', '   ', 'not-an-ip', '203.0.113.9, 10.0.0.1', 'http://evil.test', '203.0.113.9:1234', '999.999.999.999', '0x7f.1'];
  for (const value of junk) {
    assert.equal(clientAddress(peer, { 'x-real-ip': value }), peer, `${JSON.stringify(value)} must fall back to the peer`);
  }

  // A header is never consulted when the peer is not the proxy.
  assert.equal(clientAddress('10.0.0.5', { 'x-real-ip': '203.0.113.9' }), '10.0.0.5');
  assert.equal(clientAddress('2001:db8::5', { 'x-real-ip': '203.0.113.9' }), '2001:db8::5');
  assert.equal(clientAddress('10.0.0.5', {}), '10.0.0.5');
  assert.equal(clientAddress('unknown', {}), 'unknown');

  // X-Forwarded-For is never read, alone or next to a real (or junk) X-Real-IP.
  assert.equal(clientAddress(peer, { 'x-forwarded-for': '203.0.113.9' }), peer);
  assert.equal(clientAddress(peer, { 'x-forwarded-for': '203.0.113.9', 'x-real-ip': 'garbage' }), peer);
  assert.equal(clientAddress(peer, { 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '198.51.100.7' }), '198.51.100.7');
  // A repeated header is not a candidate either.
  assert.equal(clientAddress(peer, { 'x-real-ip': ['203.0.113.9', '198.51.100.7'] }), peer);
  assert.equal(clientAddress(peer, {}), peer);
});

test('failures from one client leave another client able to log in, and X-Forwarded-For is never trusted', async () => {
  const target = await box('per-client');
  try {
    const started = await start(target);
    try {
      const attacker = '203.0.113.9';
      const operator = '198.51.100.7';

      // One client burns the whole budget. Everything is proxied from 127.0.0.1,
      // so if the bucket keyed on the peer this would be the operator's budget too.
      for (let attempt = 1; attempt <= LOGIN_FAILURE_LIMIT; attempt += 1) {
        assert.equal((await loginFrom(started.url, { 'x-real-ip': attacker }, `golpe-${attempt}`)).status, 401);
      }
      assert.equal(
        (await loginFrom(started.url, { 'x-real-ip': attacker }, TEST_PASSWORD)).status,
        429,
        'the client that spent its budget is locked out',
      );

      // A different client still logs in, with the same correct password.
      const ok = await loginFrom(started.url, { 'x-real-ip': operator, 'x-forwarded-proto': 'https' }, TEST_PASSWORD);
      assert.equal(ok.status, 200, 'a flood from one client must not prevent another from logging in');
      assert.match(rawCookie(ok) ?? '', /Secure/);
      const cookie = cookiePair(ok);
      assert.equal((await fetch(`${started.url}/`, { headers: withCookie(cookie) })).status, 200);

      // A rotating X-Forwarded-For cannot mint buckets: it is never read, so all
      // of these share the loopback peer's bucket, which is untouched so far.
      for (let attempt = 1; attempt <= LOGIN_FAILURE_LIMIT; attempt += 1) {
        assert.equal(
          (await loginFrom(started.url, { 'x-forwarded-for': `203.0.113.${100 + attempt}` }, `rotado-${attempt}`)).status,
          401,
          `attempt ${attempt} with a fresh X-Forwarded-For shares the peer bucket`,
        );
      }
      assert.equal(
        (await loginFrom(started.url, { 'x-forwarded-for': '203.0.113.200' }, TEST_PASSWORD)).status,
        429,
        'a fresh X-Forwarded-For must not open a fresh budget',
      );
    } finally {
      await started.close();
    }
  } finally {
    await rm(target.root, { recursive: true, force: true });
  }
});

test('a concurrent verification answers 429 with Retry-After and says so in the body', async () => {
  const target = await box('serialized');
  try {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = (): void => {};
    const enteredSignal = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const heldVerifier = async (password: string, stored: StoredPasswordHash): Promise<boolean> => {
      entered();
      await held;
      return await verifyPassword(password, stored);
    };

    const started = await start(target, { loginVerifier: heldVerifier });
    try {
      // The first request takes the one derivation slot and stays in it.
      const first = login(started.url, 'primera');
      await enteredSignal;

      const second = await login(started.url, TEST_PASSWORD);
      assert.equal(second.status, 429, 'the second attempt is refused while the slot is taken');
      assert.equal(second.headers.get('retry-after'), String(LOGIN_BUSY_RETRY_AFTER_SECONDS));
      const body = (await second.json()) as {
        status: string;
        cause: string;
        reason: string;
        retryAfterSeconds: number;
      };
      assert.equal(body.status, 'rate-limited');
      assert.equal(body.cause, 'verification-busy');
      assert.equal(body.reason, LOGIN_BUSY_MESSAGE);
      assert.equal(body.retryAfterSeconds, LOGIN_BUSY_RETRY_AFTER_SECONDS);
      assert.equal(rawCookie(second), null);

      release();
      assert.equal((await first).status, 401, 'the first attempt was compared, and was wrong');

      // The refused attempt gave its reservation back: the client's budget is not
      // spent by a "server is busy" answer, so the correct password works now.
      const third = await login(started.url, TEST_PASSWORD);
      assert.equal(third.status, 200, 'a refused busy attempt does not spend the client budget');
      assert.ok(rawCookie(third));
    } finally {
      await started.close();
    }
  } finally {
    await rm(target.root, { recursive: true, force: true });
  }
});

