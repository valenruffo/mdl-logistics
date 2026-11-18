/**
 * Ambient declaration for the one `node:net` function the login budget uses.
 *
 * `clientAddress` has to decide whether `X-Real-IP` carries an IP address or
 * something a caller made up. A hand-written parser would be a guess; Node's own
 * `isIP` is the answer, so it is declared here — and only it. `src/ui/node-http.d.ts`
 * keeps its promise of declaring only `node:http`.
 */
declare module 'node:net' {
  /** `0` when the text is not an IP address, `4` or `6` when it is. */
  export function isIP(input: string): number;
}
