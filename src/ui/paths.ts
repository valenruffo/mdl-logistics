/**
 * Path arithmetic for the console's artifact route.
 *
 * The one job of this module is to make "serve a file under `artifacts/`" safe
 * without pretending to be a general-purpose path library:
 *
 * - a request path is percent-decoded **once**, then split on `/`, and every
 *   segment is checked (`''`, `.`, `..`, `\`, `:`, NUL are all refused) before
 *   anything is joined. Refusing `:` also refuses Windows drive letters and
 *   alternate data streams;
 * - the joined path is resolved through `realpathSync` and must stay inside the
 *   real artifacts root, so a symlink inside `artifacts/` cannot walk out of it;
 * - only regular files are served; a directory is not a listing route.
 *
 * There is no glob, no wildcard and no ".. allowed when it stays inside": a
 * refused request is refused with a reason the operator can read.
 */
import { realpathSync, statSync } from 'node:fs';

/** Every artifact download lives under this prefix, and nowhere else. */
export const ARTIFACT_ROUTE_PREFIX = '/artifacts/';

/**
 * Refusal threshold for one download. A trace is a few megabytes; anything past
 * this is refused instead of being buffered into the UI's memory.
 */
export const MAX_SERVED_ARTIFACT_BYTES = 200 * 1024 * 1024;

export interface RefusedArtifact {
  ok: false;
  /** HTTP status to answer with. */
  status: number;
  reason: string;
}

export interface ResolvedArtifact {
  ok: true;
  /** The real file, symlinks resolved. */
  file: string;
  /** The validated segments, relative to the artifacts root. */
  segments: string[];
}

export type ArtifactTarget = ResolvedArtifact | RefusedArtifact;

function refuse(status: number, reason: string): RefusedArtifact {
  return { ok: false, status, reason };
}

/** `\` is not a separator here: URL paths use `/`, and a backslash is refused. */
function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

export function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}

/** `'artifacts/ui/x.json'` → `'artifacts/ui'`; `''` when there is no parent. */
export function parentOf(filePath: string): string {
  const normalized = normalizeSlashes(filePath);
  const index = normalized.lastIndexOf('/');
  if (index < 0) return '';
  if (index === 0) return '/';
  return normalized.slice(0, index);
}

export function baseNameOf(filePath: string): string {
  const normalized = normalizeSlashes(filePath);
  const index = normalized.lastIndexOf('/');
  return index < 0 ? normalized : normalized.slice(index + 1);
}

/**
 * Joins an absolute root with already-validated relative segments. Node's `fs`
 * accepts `/` on every platform, so the joined path is portable.
 */
export function joinPath(root: string, pathSegments: readonly string[]): string {
  const base = normalizeSlashes(root).replace(/\/+$/, '');
  return `${base}/${pathSegments.join('/')}`;
}

/**
 * Splits a repository-relative path into segments, or `null` when it is not a
 * plain relative path (parent segments, drive letters, backslashes, NUL).
 */
export function relativeSegments(relativePath: string): string[] | null {
  const normalized = normalizeSlashes(relativePath).replace(/^\.\//, '').replace(/\/+$/, '');
  if (normalized === '' || normalized.startsWith('/')) return null;

  const parts = normalized.split('/').filter((part) => part !== '');
  if (parts.length === 0) return null;

  for (const part of parts) {
    if (part === '.' || part === '..') return null;
    if (part.includes(':') || part.includes('\u0000')) return null;
  }
  return parts;
}

/** The download link for an already-validated file. */
export function hrefForFile(pathSegments: readonly string[]): string {
  return `${ARTIFACT_ROUTE_PREFIX}${pathSegments.map((segment) => encodeURIComponent(segment)).join('/')}`;
}

/** True when `target` is `root` itself or sits below it. */
export function isInside(root: string, target: string): boolean {
  const normalRoot = normalizeSlashes(root).replace(/\/+$/, '');
  const normalTarget = normalizeSlashes(target);
  const caseInsensitive = process.platform === 'win32';
  const left = caseInsensitive ? normalRoot.toLowerCase() : normalRoot;
  const right = caseInsensitive ? normalTarget.toLowerCase() : normalTarget;
  return right === left || right.startsWith(`${left}/`);
}

function segmentsOrRefusal(path: string): { ok: true; segments: string[] } | RefusedArtifact {
  if (path === '') return refuse(404, 'la ruta no nombra ningún archivo');
  if (path.startsWith('/')) return refuse(403, 'la ruta es absoluta');
  if (path.includes('\\')) return refuse(403, 'la ruta trae una barra invertida');
  if (path.includes('\u0000')) return refuse(400, 'la ruta trae un byte nulo');

  const segments = path.split('/');
  for (const segment of segments) {
    if (segment === '') return refuse(404, 'la ruta trae un segmento vacío');
    if (segment === '.' || segment === '..') {
      return refuse(403, `el segmento ${JSON.stringify(segment)} no se sirve: el recorrido de rutas está rechazado`);
    }
    if (segment.includes(':')) return refuse(403, 'la ruta trae dos puntos');
  }
  return { ok: true, segments };
}

/**
 * Turns one request path into a real file under `root`, or a refusal.
 *
 * Decoding happens before splitting on purpose: `%2e%2e%2f` must be refused as
 * `../`, not treated as a filename.
 */
export function resolveArtifactTarget(root: string, requestPath: string): ArtifactTarget {
  if (!requestPath.startsWith(ARTIFACT_ROUTE_PREFIX)) {
    return refuse(404, `solo se sirve la ruta ${ARTIFACT_ROUTE_PREFIX}`);
  }

  const raw = requestPath.slice(ARTIFACT_ROUTE_PREFIX.length);

  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return refuse(400, 'la ruta no es percent-encoding válido');
  }

  const split = segmentsOrRefusal(decoded);
  if (!split.ok) return split;

  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch (error) {
    return refuse(
      404,
      `el directorio de artefactos no se pudo leer (${root}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const candidate = joinPath(realRoot, split.segments);

  let realFile: string;
  try {
    realFile = realpathSync(candidate);
  } catch {
    return refuse(404, `el archivo no existe: ${split.segments.join('/')}`);
  }

  if (!isInside(realRoot, realFile)) {
    return refuse(403, 'la ruta sale del directorio de artefactos');
  }

  let stats: { isFile(): boolean };
  try {
    stats = statSync(realFile);
  } catch (error) {
    return refuse(404, `el archivo no se pudo leer: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!stats.isFile()) return refuse(404, `${split.segments.join('/')} no es un archivo`);

  return { ok: true, file: realFile, segments: split.segments };
}

const CONTENT_TYPES: readonly { suffix: string; type: string }[] = [
  { suffix: '.json', type: 'application/json; charset=utf-8' },
  { suffix: '.har', type: 'application/json; charset=utf-8' },
  { suffix: '.txt', type: 'text/plain; charset=utf-8' },
  { suffix: '.log', type: 'text/plain; charset=utf-8' },
  { suffix: '.md', type: 'text/plain; charset=utf-8' },
  { suffix: '.png', type: 'image/png' },
  { suffix: '.jpg', type: 'image/jpeg' },
  { suffix: '.jpeg', type: 'image/jpeg' },
  { suffix: '.webm', type: 'video/webm' },
  { suffix: '.zip', type: 'application/zip' },
];

/** By suffix only: nothing is sniffed, and an unknown suffix is an opaque download. */
export function contentTypeFor(fileName: string): string {
  const lower = fileName.toLowerCase();
  const match = CONTENT_TYPES.find((candidate) => lower.endsWith(candidate.suffix));
  return match === undefined ? 'application/octet-stream' : match.type;
}
