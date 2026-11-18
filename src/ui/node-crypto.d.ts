/**
 * The rest of `node:crypto` the login path needs, declared here because
 * `src/executor/globals.d.ts` declares only `createHash` and that file is outside
 * this task's edit surface.
 *
 * Ambient module declarations merge, so this adds `scrypt`, `randomBytes`,
 * `createHmac` and `timingSafeEqual` to the same `node:crypto` module: nothing is
 * redeclared and `createHash` keeps its single definition.
 *
 * Keep this list minimal: every entry weakens type safety for one call, so it must
 * earn its place.
 */
declare module 'node:crypto' {
  export interface ScryptOptions {
    /** CPU/memory cost; must be a power of two. */
    N?: number;
    /** Block size. */
    r?: number;
    /** Parallelization. */
    p?: number;
    /** Memory cap in bytes; raised explicitly for the documented parameters. */
    maxmem?: number;
  }

  /** Derives a key asynchronously, so the login route never blocks the loop. */
  export function scrypt(
    password: string,
    salt: string | Uint8Array,
    keylen: number,
    options: ScryptOptions,
    callback: (error: unknown, derivedKey: Uint8Array) => void,
  ): void;

  /** Used for the session cookie's nonce. */
  export function randomBytes(size: number): { toString(encoding: 'hex'): string };

  export interface NodeHmac {
    update(data: string, inputEncoding?: string): NodeHmac;
    digest(encoding: 'hex'): string;
  }

  /** Signs `expiry.nonce` with HMAC-SHA256. */
  export function createHmac(algorithm: string, key: string): NodeHmac;

  /** Compares two equal-length byte sequences without leaking the first difference. */
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}
