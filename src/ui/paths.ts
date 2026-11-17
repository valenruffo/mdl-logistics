/**
 * Plain path arithmetic for the console's readers.
 *
 * This module used to guard an artifact **download** route. That route is gone
 * (see `server.ts`), so nothing here turns a request path into a file any more:
 * the console only *locates* files it already knows about, from values the run
 * records carry.
 *
 * What remains is the small, portable subset the readers need:
 *
 * - `relativeSegments()` validates a repository-relative path before it is joined:
 *   absolute paths, drive letters, backslashes, NUL and `.`/`..` segments are all
 *   refused, so a record cannot point a reader outside the artifacts root;
 * - `joinPath()` joins an absolute root with already-validated segments using `/`,
 *   which Node's `fs` accepts on every platform;
 * - `parentOf()` and `baseNameOf()` for display and to create a directory before
 *   writing next to a file;
 * - `isAbsolutePath()` to tell "as configured" from "relative to the working
 *   directory".
 *
 * There is no content type, no byte cap and no href builder: the page never
 * serves a file, so a URL for one must not exist even as a helper.
 */

/** `\` is not a separator here: paths are normalized to `/` before use. */
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
 *
 * The refusal of `.`/`..` is what keeps a path a run record names from becoming a
 * read outside the artifacts root, now that the console reads those paths itself.
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
