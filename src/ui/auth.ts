/**
 * The operator's login: one password, one signed cookie, one in-memory attempt
 * budget.
 *
 * **Why this module exists.** Nginx used to answer with the browser's native
 * Basic Auth dialog before proxying to this server, and the page itself had no
 * authentication at all. A native dialog is not part of the interface: it cannot
 * be styled, it has no inline error, and it is the first thing the operator sees.
 * So the password check moves here, into the app, and Nginx stops enforcing it.
 *
 * The pieces, and the rules each one keeps:
 *
 * 1. **The stored hash** is a single string, `scrypt$N$r$p$salt$key`, with the
 *    salt *inside* it. Nothing ever derives a key without a salt, and no two
 *    deployments share one. `MDL_PASSWORD_HASH` carries it verbatim.
 * 2. **The comparison is constant time.** `scrypt` derives the candidate key and
 *    `timingSafeEqual` compares it with the stored one; a wrong password and a
 *    corrupt stored hash both answer the same generic sentence.
 * 3. **The session cookie** is `expiry.nonce.mac`: the expiry and a random nonce,
 *    signed with HMAC-SHA256 under `MDL_SESSION_SECRET`. The MAC covers both
 *    fields, so a cookie cannot be aged forward, replayed under another expiry or
 *    forged without the secret. A tampered, expired or malformed cookie is simply
 *    not a session — there is no partial state.
 * 4. **The attempt budget** is per client (see `clientAddress` in `server.ts`: the
 *    real client behind the loopback proxy, never the proxy itself), in memory.
 *    The login route *reserves* an attempt — checks the budget and records the
 *    attempt in one synchronous step — before it awaits anything, so a parallel
 *    burst cannot slip past the check while the first derivation is still
 *    running. Five attempts in fifteen minutes, then a `429` that says how long
 *    to wait. A correct password clears the client's budget; a wrong one leaves
 *    the reservation recorded.
 * 5. **One derivation at a time.** `createPasswordGate` admits a single
 *    verification per process: a second concurrent attempt is answered with a
 *    `429` carrying `Retry-After` (`LOGIN_BUSY_MESSAGE`) and its reservation is
 *    given back, because the busy slot is the server's limit and not that
 *    client's failure. The CPU cost is therefore at most one scrypt, even if an
 *    attacker rotates the bucket key.
 * 6. **Nothing here logs, returns or embeds a secret.** No error message quotes
 *    the password, the hash or the secret, and the configuration refusal names the
 *    *variable*, never a value and never a default: if `MDL_PASSWORD_HASH` or
 *    `MDL_SESSION_SECRET` is missing the process refuses to start rather than
 *    serving an unprotected page.
 *
 * The clock is injected everywhere (`nowMs`, `createAuthRuntime({ now })`) so the
 * tests can age a cookie without waiting thirty days.
 */
import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** The two variables the server refuses to run without. There is no default. */
export const PASSWORD_HASH_VARIABLE = 'MDL_PASSWORD_HASH';
export const SESSION_SECRET_VARIABLE = 'MDL_SESSION_SECRET';

/** The session cookie's name. No domain attribute is ever written. */
export const SESSION_COOKIE_NAME = 'mdl_session';

/** Thirty days, as required for the cookie's `Max-Age` and the token's expiry. */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Where the login page lives, and where a browser is sent when it has no session. */
export const LOGIN_PATH = '/login';
export const LOGIN_API_PATH = '/api/login';
export const LOGOUT_API_PATH = '/api/logout';

/** The only sentence a failed login gets: it reveals nothing about the config. */
export const LOGIN_FAILED_MESSAGE = 'No se pudo iniciar sesión: la contraseña no es correcta.';

/** Five attempts per client per window. Both numbers are asserted by tests. */
export const LOGIN_FAILURE_LIMIT = 5;
export const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;

/**
 * Bounds for the stored-hash parser. The documented generator writes
 * `N=16384, r=8, p=1` with a 16-byte salt and a 32-byte key; the parser accepts a
 * range around them so a stronger hash stays usable without a code change.
 */
const SCRYPT_SALT_BYTES = 16;
const MAX_SCRYPT_N = 1 << 20;
const MIN_SECRET_LENGTH = 32;

/**
 * The two documented commands, split into the script handed to `node -e` and the
 * shell line the operator copies. The split lets a test run the *exact* script
 * without a shell, and lets the shell line stay free of `$`: the separator is
 * written as `\x24`, which bash and PowerShell both pass through inside double
 * quotes, so the line works unquoted in either one.
 *
 * The password is read from `process.argv[1]`, never from the script text, and the
 * salt is fresh per invocation.
 */
export const PASSWORD_HASH_SCRIPT =
  'const c=require(\'node:crypto\'),s=\'\\x24\',pw=process.argv[1],salt=c.randomBytes(16),N=16384,r=8,p=1,key=c.scryptSync(pw,salt,32,{N,r,p});console.log([\'scrypt\',N,r,p,salt.toString(\'hex\'),key.toString(\'hex\')].join(s))';

export const SESSION_SECRET_SCRIPT = 'console.log(require(\'node:crypto\').randomBytes(32).toString(\'hex\'))';

/** `node -e "<script>" 'TU-CONTRASENA'` — quote the password for your shell. */
export const PASSWORD_HASH_COMMAND = `node -e "${PASSWORD_HASH_SCRIPT}" 'TU-CONTRASENA'`;

/** `node -e "<script>"` — 32 random bytes as 64 hex characters. */
export const SESSION_SECRET_COMMAND = `node -e "${SESSION_SECRET_SCRIPT}"`;

// --------------------------------------------------------------------- errors

/**
 * A configuration value the process cannot invent. The message names the
 * variable and says what shape it wants; it never quotes a value, and no caller
 * may substitute a default for one.
 */
export class AuthConfigError extends Error {
  readonly variable: string;

  constructor(variable: string, detail: string) {
    super(`${variable} ${detail}`);
    this.name = 'AuthConfigError';
    this.variable = variable;
  }
}

// ------------------------------------------------------------- stored password

/**
 * The parsed form of `scrypt$N$r$p$salt$key`. Hex, not buffers, so the value can
 * be compared and inspected without ever holding a live credential object.
 */
export interface StoredPasswordHash {
  readonly n: number;
  readonly r: number;
  readonly p: number;
  readonly saltHex: string;
  readonly keyHex: string;
}

export interface AuthConfig {
  readonly passwordHash: StoredPasswordHash;
  /** Hex or any string: at least 32 characters, never empty and never defaulted. */
  readonly sessionSecret: string;
}

function isHex(value: string, minChars: number, maxChars: number): boolean {
  return value.length >= minChars && value.length <= maxChars && value.length % 2 === 0 && /^[0-9a-f]+$/.test(value);
}

function isPowerOfTwo(value: number): boolean {
  return value >= 1024 && value <= MAX_SCRYPT_N && (value & (value - 1)) === 0;
}

function parsePositiveInt(text: string): number | null {
  if (!/^\d{1,7}$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Parses the one stored-hash format. Anything else is `null`: a hash we cannot
 * read is not a hash we may compare against, and there is no fallback format.
 */
export function parseStoredHash(value: string): StoredPasswordHash | null {
  // A `$` separator breaks `docker compose`, which interpolates it away from
  // `.env` and `env_file` values alike. `:` is accepted for deployments; the
  // derivation is identical, only the separator differs.
  const parts = value.split(value.includes('$') ? '$' : ':');
  if (parts.length !== 6) return null;

  const [prefix, nText, rText, pText, saltHex, keyHex] = parts as [string, string, string, string, string, string];
  if (prefix !== 'scrypt') return null;

  const n = parsePositiveInt(nText);
  const r = parsePositiveInt(rText);
  const p = parsePositiveInt(pText);
  if (n === null || r === null || p === null) return null;
  if (!isPowerOfTwo(n) || r > 32 || p > 16) return null;
  if (!isHex(saltHex, SCRYPT_SALT_BYTES * 2, SCRYPT_SALT_BYTES * 4)) return null;
  if (!isHex(keyHex, 32, 128)) return null;

  return { n, r, p, saltHex, keyHex };
}

function hexToBytes(value: string): Uint8Array | null {
  if (value.length % 2 !== 0 || !/^[0-9a-f]*$/.test(value)) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** Compares two hex strings without leaking where they differ. */
function constantTimeEqualHex(left: string, right: string): boolean {
  const a = hexToBytes(left);
  const b = hexToBytes(right);
  if (a === null || b === null || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function deriveKey(
  password: string,
  salt: Uint8Array,
  keyLength: number,
  params: { n: number; r: number; p: number },
): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    // `maxmem` is raised explicitly: N=16384, r=8 already needs 16 MiB, and the
    // default 32 MiB cap would refuse a legitimate, stronger hash.
    const maxmem = 256 * params.n * params.r + 1024 * 1024;
    scrypt(password, salt, keyLength, { N: params.n, r: params.r, p: params.p, maxmem }, (error, derived) => {
      if (error !== null && error !== undefined) {
        reject(error instanceof Error ? error : new Error('the password could not be derived'));
        return;
      }
      resolve(derived);
    });
  });
}

/**
 * True only when the candidate password derives the stored key under the stored
 * salt and parameters. Any failure — a malformed stored hash, a derivation error,
 * a length mismatch — is a plain `false`, never a distinct error the caller could
 * turn into a message that narrows the guess.
 */
export async function verifyPassword(password: string, stored: StoredPasswordHash | string): Promise<boolean> {
  const parsedHash = typeof stored === 'string' ? parseStoredHash(stored) : stored;
  if (parsedHash === null) return false;

  // The stored salt is hex because the whole hash is one text value; the bytes it
  // encodes are what scrypt hashes with, so the documented generator (a 16-byte
  // Buffer) and this verifier derive the same key.
  const salt = hexToBytes(parsedHash.saltHex);
  const expected = hexToBytes(parsedHash.keyHex);
  if (salt === null || expected === null || expected.length < 16) return false;

  let derived: Uint8Array;
  try {
    derived = await deriveKey(password, salt, expected.length, parsedHash);
  } catch {
    return false;
  }
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

// ---------------------------------------------------------------- session token

export type SessionFailure = 'missing' | 'malformed' | 'bad-signature' | 'expired';

export type SessionVerdict = { ok: true; expiry: number } | { ok: false; reason: SessionFailure };

export interface SessionToken {
  /** `expiry.nonce.mac` — exactly what goes in the cookie. */
  readonly value: string;
  /** Seconds since the epoch, as written in the cookie. */
  readonly expiry: number;
}

function sessionMac(secret: string, expiryText: string, nonce: string): string {
  return createHmac('sha256', secret).update(`${expiryText}.${nonce}`).digest('hex');
}

/** Mints a cookie value for `nowMs`, valid for `ttlSeconds` (30 days by default). */
export function createSessionToken(
  secret: string,
  nowMs: number,
  ttlSeconds: number = SESSION_TTL_SECONDS,
): SessionToken {
  const expiry = Math.floor(nowMs / 1000) + ttlSeconds;
  const expiryText = String(expiry);
  const nonce = randomBytes(16).toString('hex');
  return { value: `${expiryText}.${nonce}.${sessionMac(secret, expiryText, nonce)}`, expiry };
}

/**
 * Verifies one cookie value. Order matters for the report but not for the answer:
 * a value that is not exactly `digits.nonce.mac` is malformed before any crypto
 * runs; a value whose MAC does not match is not a session even if its expiry is in
 * the future; and an authentic value whose expiry has passed is expired.
 */
export function verifySessionToken(
  token: string | null | undefined,
  secret: string,
  nowMs: number,
): SessionVerdict {
  if (token === null || token === undefined || token === '') return { ok: false, reason: 'missing' };

  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };

  const [expiryText, nonce, mac] = parts as [string, string, string];
  if (!/^\d{1,12}$/.test(expiryText)) return { ok: false, reason: 'malformed' };
  if (!/^[0-9a-f]{32}$/.test(nonce)) return { ok: false, reason: 'malformed' };
  if (!/^[0-9a-f]{64}$/.test(mac)) return { ok: false, reason: 'malformed' };

  if (!constantTimeEqualHex(mac, sessionMac(secret, expiryText, nonce))) {
    return { ok: false, reason: 'bad-signature' };
  }

  const expiry = Number(expiryText);
  if (!Number.isSafeInteger(expiry) || expiry <= 0) return { ok: false, reason: 'malformed' };
  // Expiry is inclusive at the second it names: at `expiry` the session is over.
  if (expiry * 1000 <= nowMs) return { ok: false, reason: 'expired' };

  return { ok: true, expiry };
}

/**
 * The `Set-Cookie` value for a live session. Flags are exactly the required set,
 * and there is no `Domain`: the cookie belongs to the host that served it.
 * `Secure` is added only when the request arrived over TLS, because a browser
 * silently drops a `Secure` cookie set from plain `http://127.0.0.1`.
 */
export function sessionCookie(token: SessionToken, encrypted = false): string {
  return [
    `${SESSION_COOKIE_NAME}=${token.value}`,
    'Path=/',
    'HttpOnly',
    ...(encrypted ? ['Secure'] : []),
    'SameSite=Strict',
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ].join('; ');
}

/** The `Set-Cookie` value that clears it: same name, same path, zero age. */
export function expiredSessionCookie(encrypted = false): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    ...(encrypted ? ['Secure'] : []),
    'SameSite=Strict',
    'Max-Age=0',
  ].join('; ');
}

/** Reads one cookie out of a raw `cookie` request header, or `null`. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined || header === '') return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    return part.slice(index + 1).trim();
  }
  return null;
}

// ----------------------------------------------------------------- rate limit

export interface RateDecision {
  readonly allowed: boolean;
  /** Whole seconds the caller should wait; `0` when allowed. */
  readonly retryAfterSeconds: number;
}

/**
 * What `LoginRateLimiter.reserve` decided, plus the id of the attempt it recorded.
 * The id is how a caller gives the attempt back when it never got to compare the
 * password: the release removes *that* reservation, not whichever entry happens to
 * be newest.
 */
export interface RateReservation extends RateDecision {
  /** `null` when the budget refused the attempt and nothing was recorded. */
  readonly attemptId: number | null;
}

/** One recorded attempt. The id makes the entry addressable for a release. */
interface Attempt {
  readonly at: number;
  readonly id: number;
}

/**
 * The in-memory attempt budget for the login route: per bucket key, pruned by
 * time. Nothing is persisted — a restart forgets the counters, which is the right
 * trade for one operator on one box.
 *
 * **`reserve` is the entry point the login route uses**, because it checks the
 * budget and records the attempt in one synchronous call: there is no `await`
 * between "may this client try?" and "this client tried", so a parallel burst
 * cannot all pass the check while the first scrypt is still running. `check` and
 * `recordFailure` remain for callers that only need one half of that pair.
 */
export class LoginRateLimiter {
  private readonly attempts = new Map<string, Attempt[]>();
  private nextAttemptId = 1;
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: { limit?: number; windowMs?: number; now?: () => number } = {}) {
    this.limit = options.limit ?? LOGIN_FAILURE_LIMIT;
    this.windowMs = options.windowMs ?? LOGIN_FAILURE_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** Whether this key may try a password now. Does not record anything. */
  check(address: string): RateDecision {
    const recent = this.prune(address);
    if (recent.length < this.limit) return { allowed: true, retryAfterSeconds: 0 };

    const oldest = recent[0] ?? { at: this.now(), id: 0 };
    const remainingMs = oldest.at + this.windowMs - this.now();
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)) };
  }

  /**
   * Checks the budget and, when it allows the attempt, records it — one
   * synchronous step, so nothing can interleave between the check and the
   * increment. This is the reservation the login route makes before it awaits a
   * derivation.
   */
  reserve(address: string): RateReservation {
    const decision = this.check(address);
    if (!decision.allowed) return { ...decision, attemptId: null };
    return { ...decision, attemptId: this.push(address) };
  }

  /** Gives back exactly this reservation: the attempt never compared a password. */
  release(address: string, attemptId: number): void {
    const recent = this.prune(address).filter((attempt) => attempt.id !== attemptId);
    if (recent.length === 0) this.attempts.delete(address);
    else this.attempts.set(address, recent);
  }

  /** Records one wrong password for this key. */
  recordFailure(address: string): void {
    this.push(address);
  }

  /** Forgets this key entirely: a successful login resets its budget. */
  reset(address: string): void {
    this.attempts.delete(address);
  }

  private push(address: string): number {
    const id = this.nextAttemptId;
    this.nextAttemptId += 1;
    const recent = this.prune(address);
    recent.push({ at: this.now(), id });
    this.attempts.set(address, recent);
    return id;
  }

  private prune(address: string): Attempt[] {
    const cutoff = this.now() - this.windowMs;
    const recent = (this.attempts.get(address) ?? []).filter((attempt) => attempt.at > cutoff);
    if (recent.length === 0) this.attempts.delete(address);
    else this.attempts.set(address, recent);
    return recent;
  }
}

/** The one sentence a `429` carries: how long to wait, and nothing else. */
export function rateLimitMessage(retryAfterSeconds: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Demasiados intentos fallidos desde esta dirección. Esperá ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'} (${retryAfterSeconds} s) y volvé a intentar.`;
}

/**
 * The sentence a `429` carries when the budget was fine but another password is
 * already being derived. It is a different answer from a spent budget because it
 * is a different condition — the attempt was refused, not judged.
 */
export const LOGIN_BUSY_MESSAGE =
  'El servidor está verificando otra contraseña en este momento. Volvé a intentar en unos segundos.';

/** How long a `429` for a busy verification slot asks the caller to wait. */
export const LOGIN_BUSY_RETRY_AFTER_SECONDS = 1;

// ------------------------------------------------------- serialized verification

/** The result of one admission to the password gate. */
export type PasswordCheck =
  | { readonly busy: true }
  | { readonly busy: false; readonly matched: boolean };

/**
 * The one-slot gate around `verifyPassword`.
 *
 * scrypt is deliberately expensive, which is exactly why an unauthenticated
 * caller must not be able to run many derivations at once: the budget bounds how
 * many *keys* may try, not how much CPU one burst can consume. This gate bounds
 * the CPU: at most one derivation runs at a time in this process, and a request
 * that arrives while one is running is told so (`busy`) instead of queued behind
 * an unbounded attacker-driven queue.
 */
export interface PasswordGate {
  /** True while a derivation is in flight. A test seam and nothing else. */
  readonly running: boolean;
  /** Takes the slot and derives the candidate key, or reports that it is taken. */
  check(password: string): Promise<PasswordCheck>;
}

/**
 * Builds the gate. `verify` is injectable so a test can hold the slot open and
 * observe the refused request deterministically.
 */
export function createPasswordGate(
  stored: StoredPasswordHash,
  options: { verify?: (password: string, stored: StoredPasswordHash) => Promise<boolean> } = {},
): PasswordGate {
  const verify = options.verify ?? verifyPassword;
  let running = false;

  return {
    get running() {
      return running;
    },
    async check(password: string): Promise<PasswordCheck> {
      // Taken synchronously, before the first `await`: two requests cannot both
      // see a free slot. `finally` gives it back whatever the derivation does.
      if (running) return { busy: true };
      running = true;
      try {
        return { busy: false, matched: await verify(password, stored) };
      } finally {
        running = false;
      }
    },
  };
}

// ------------------------------------------------------------------ config

/**
 * Reads the two configuration values and refuses to invent either.
 *
 * A missing, empty, unparsable or too-short value throws `AuthConfigError` naming
 * the variable. The caller (`main.ts`) prints the reason and exits; nothing here
 * substitutes a default secret, because a default secret is no secret at all.
 */
export function readAuthConfig(env: Record<string, string | undefined>): AuthConfig {
  const rawHash = (env[PASSWORD_HASH_VARIABLE] ?? '').trim();
  if (rawHash === '') {
    throw new AuthConfigError(
      PASSWORD_HASH_VARIABLE,
      'no está definida: el servidor no arranca sin ella (no hay contraseña por defecto)',
    );
  }

  const passwordHash = parseStoredHash(rawHash);
  if (passwordHash === null) {
    throw new AuthConfigError(
      PASSWORD_HASH_VARIABLE,
      'no tiene el formato scrypt$N$r$p$salt$key ni scrypt:N:r:p:salt:key; generala con el comando documentado en env.example',
    );
  }

  const rawSecret = (env[SESSION_SECRET_VARIABLE] ?? '').trim();
  if (rawSecret === '') {
    throw new AuthConfigError(
      SESSION_SECRET_VARIABLE,
      'no está definida: el servidor no arranca sin ella (no hay secreto por defecto)',
    );
  }
  if (rawSecret.length < MIN_SECRET_LENGTH) {
    throw new AuthConfigError(
      SESSION_SECRET_VARIABLE,
      `es demasiado corta: se necesitan al menos ${MIN_SECRET_LENGTH} caracteres (32 bytes en hex)`,
    );
  }

  return { passwordHash, sessionSecret: rawSecret };
}

/** Everything the request path needs: the config, the attempt budget, the one
 * derivation slot and a clock. */
export interface AuthRuntime {
  readonly config: AuthConfig;
  readonly limiter: LoginRateLimiter;
  /** At most one `verifyPassword` runs at a time through this gate. */
  readonly gate: PasswordGate;
  now(): number;
}

export function createAuthRuntime(
  config: AuthConfig,
  options: {
    now?: () => number;
    limit?: number;
    windowMs?: number;
    limiter?: LoginRateLimiter;
    /** A test seam for the one-slot gate; production uses `verifyPassword`. */
    verify?: (password: string, stored: StoredPasswordHash) => Promise<boolean>;
  } = {},
): AuthRuntime {
  const now = options.now ?? (() => Date.now());
  const limiter =
    options.limiter ??
    new LoginRateLimiter({
      now,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.windowMs === undefined ? {} : { windowMs: options.windowMs }),
    });
  const gate = createPasswordGate(
    config.passwordHash,
    options.verify === undefined ? {} : { verify: options.verify },
  );

  return { config, limiter, gate, now };
}
