/**
 * Ambient declaration for the one Node module the UI serves itself with.
 *
 * `tsconfig.json` compiles with `lib: ["ES2022"]` and `types: []`, so neither
 * `lib.dom` nor `@types/node` is in scope — `src/executor/globals.d.ts` declares
 * exactly what the executor needs, and this file declares exactly what the local
 * HTTP server needs. Keep it minimal: every entry weakens type safety for one
 * call, so it must earn its place.
 *
 * Only `node:http` is declared here. `node:fs/promises`, `node:crypto` and
 * `node:readline/promises` are already declared by `src/executor/globals.d.ts`;
 * redeclaring them would collide.
 */
declare module 'node:http' {
  export interface HttpChunk {
    toString(encoding?: string): string;
  }

  export interface IncomingMessage {
    method?: string;
    url?: string;
    /** The request headers, lower-cased by Node. `cookie` is the one auth reads. */
    readonly headers: Record<string, string | string[] | undefined>;
    /** The peer socket. `clientAddress` in `server.ts` turns it into the login
     * budget's key: the real client when the peer is the loopback proxy. */
    readonly socket?: {
      readonly remoteAddress?: string | null;
      /** `true` when this very socket is TLS. A proxied request is plain HTTP. */
      readonly encrypted?: boolean;
    };
    on(event: 'data', listener: (chunk: HttpChunk) => void): unknown;
    on(event: 'end', listener: () => void): unknown;
    on(event: 'error', listener: (error: unknown) => void): unknown;
  }

  export interface ServerResponse {
    statusCode: number;
    setHeader(name: string, value: string): void;
    /** Always text: no route answers with file bytes. */
    end(body?: string): void;
  }

  export interface AddressInfo {
    address: string;
    family: string;
    port: number;
  }

  export interface Server {
    listen(port: number, host: string, callback?: () => void): Server;
    close(callback?: (error?: unknown) => void): Server;
    address(): AddressInfo | string | null;
  }

  export function createServer(
    handler: (request: IncomingMessage, response: ServerResponse) => void,
  ): Server;
}
