/**
 * Ambient declarations for the maintenance console.
 *
 * `tsconfig.json` compiles with `lib: ["ES2022"]` and `types: []`, so neither
 * `lib.dom` nor `@types/node` is in scope. `src/executor/globals.d.ts` already
 * declares the globals the executor uses and `src/ui/node-http.d.ts` declares
 * `node:http`; neither may be widened by this task, so everything the console
 * needs beyond them is declared here, and nothing more.
 *
 * Two entries are *merges* of declarations that already exist:
 *
 * - `interface NodeProcess` gains the process facts the runtime panel prints;
 * - `interface Stats` in `node:fs` gains `mtimeMs`, so the existing `statSync`
 *   reports the modification time the session and artifact panels show.
 *
 * Keep this list minimal: every entry weakens type safety for one call.
 */

interface NodeProcess {
  /** OS process id, printed by the runtime panel. */
  pid: number;
  /** `process.version`, printed by the runtime panel. */
  version: string;
  /** `process.platform`, used to compare paths case-insensitively on Windows. */
  platform: string;
  /** The Node binary the UI runs on; the session check is spawned with it. */
  execPath: string;
  /** Seconds since this process started. */
  uptime(): number;
  cwd(): string;
}

declare module 'node:fs' {
  export interface Stats {
    /** Milliseconds since the epoch: the modification time the panels print. */
    mtimeMs: number;
  }

  export const constants: {
    readonly F_OK: number;
    readonly R_OK: number;
    readonly W_OK: number;
  };

  /** Used to derive whether the artifacts directory is writable. */
  export function accessSync(path: string, mode?: number): void;

  /** Used to keep an artifact download inside the real artifacts root. */
  export function realpathSync(path: string): string;

  /** Artifact downloads are binary (screenshots, traces), so bytes are read here. */
  export function readFileSync(path: string): Uint8Array;

  /** Report files are read as text; this overload returns the decoded string. */
  export function readFileSync(path: string, options: { encoding: 'utf8' }): string;
}

declare module 'node:child_process' {
  export interface ChildOutput {
    setEncoding(encoding: string): void;
    on(event: 'data', listener: (chunk: string) => void): unknown;
  }

  export interface ChildProcessHandle {
    stdout: ChildOutput | null;
    stderr: ChildOutput | null;
    /** Overloads are declared as separate members, which TypeScript accepts. */
    on(event: 'close', listener: (code: number | null) => void): unknown;
    on(event: 'error', listener: (error: unknown) => void): unknown;
    kill(signal?: string): boolean;
  }

  export function spawn(
    command: string,
    args: readonly string[],
    options?: { cwd?: string; env?: Record<string, string | undefined> },
  ): ChildProcessHandle;
}
