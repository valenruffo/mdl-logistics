/**
 * Ambient declarations for the few runtime globals the executor needs.
 *
 * tsconfig.json compiles with `lib: ["ES2022"]` and `types: []`, so neither
 * `lib.dom` nor `@types/node` is in scope. Rather than widening either (a
 * change outside this task's edit surface), the executor declares exactly what
 * it uses. Keep this list minimal: every entry weakens type safety for one
 * call, so it must earn its place.
 */

/** Used by `sleep()` in wait.ts. Timers exist at runtime in Node. */
declare function setTimeout(callback: () => void, milliseconds?: number): unknown;

/** Used to add a small buffer to a timeout deadline. */
declare function clearTimeout(handle: unknown): void;

/** `env` for the executor; `argv`/`stdin`/`stdout`/`exitCode` for the CLI entry point. */
interface NodeProcess {
  env: Record<string, string | undefined>;
  argv: string[];
  stdin: unknown;
  stdout: unknown;
  exitCode: number;
}

declare const process: NodeProcess;

/** Text output of the CLI. Declared here because `lib.dom` is out of scope. */
declare const console: {
  log(message?: unknown): void;
  error(message?: unknown): void;
};

declare module 'node:fs/promises' {
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
  export function writeFile(path: string, data: string, options?: { encoding?: string }): Promise<void>;
  export function readFile(path: string, options: { encoding: 'utf8' }): Promise<string>;
  export function readdir(path: string): Promise<string[]>;
}

/**
 * Used by `session.ts` to refuse a `MDL_STORAGE_STATE` path that is not a real
 * file before Playwright is launched. `statSync` throws on a missing path, which
 * is exactly the refusal being reported.
 */
declare module 'node:fs' {
  export interface Stats {
    size: number;
    isFile(): boolean;
    isDirectory(): boolean;
  }
  export function statSync(path: string): Stats;
}

/** Used only by the CLI to read the confirmation token the operator types. */
declare module 'node:readline/promises' {
  export interface Interface {
    question(query: string): Promise<string>;
    close(): void;
  }
  export function createInterface(options: { input: unknown; output: unknown }): Interface;
}

/** Used only to hash the approved payload (approval.ts). */
declare module 'node:crypto' {
  export interface NodeHash {
    update(data: string, inputEncoding?: string): NodeHash;
    digest(encoding: 'hex'): string;
  }
  export function createHash(algorithm: string): NodeHash;
}

/** Used to parse panel URLs into pathnames without lib.dom. */
declare class URL {
  constructor(input: string, base?: string);
  readonly pathname: string;
  readonly href: string;
}
