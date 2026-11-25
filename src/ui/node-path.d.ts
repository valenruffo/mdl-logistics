/**
 * Ambient declaration for the one path helper the queue gets from `node:path`.
 *
 * `tsconfig.json` compiles with `lib: ["ES2022"]` and `types: []`, so
 * `@types/node` is not in scope; `src/executor/globals.d.ts` declares the
 * modules the executor needs and `node-http.d.ts` the one the server needs.
 * The queue joins its directory out of the run-record directory's own parent,
 * which is exactly `dirname` + `join`: nothing more is declared, because every
 * extra entry weakens type safety for one call.
 */
declare module 'node:path' {
  export function dirname(path: string): string;
  export function join(...segments: string[]): string;
}
