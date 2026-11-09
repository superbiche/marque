import { dirname, normalizePosixPath } from "./links";

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const FILE_URL = /^file:\/\/(?:localhost)?(?=\/)/i;

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Drop a `?query` or `#fragment` suffix from a relative or absolute file reference. */
function stripSuffix(value: string): string {
  const cut = value.search(/[?#]/);
  return cut < 0 ? value : value.slice(0, cut);
}

/**
 * Resolve an image `src` found in a document to an absolute filesystem path.
 *
 * Returns the normalized absolute path for `file://` URLs, absolute POSIX
 * paths and document-relative paths (resolved against the directory of
 * `documentPath`). Returns `null` for anything the filesystem cannot serve:
 * remote URLs, `data:`/`blob:` URIs, other schemes, empty values, and
 * relative paths when the document location is unknown.
 */
export function resolveLocalImagePath(src: string, documentPath?: string): string | null {
  const trimmed = src.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) return null;

  let pathPart: string;
  if (FILE_URL.test(trimmed)) {
    pathPart = decode(stripSuffix(trimmed.replace(FILE_URL, "")));
  } else if (SCHEME.test(trimmed)) {
    return null;
  } else {
    pathPart = decode(stripSuffix(trimmed));
  }
  if (!pathPart) return null;

  if (pathPart.startsWith("/")) return normalizePosixPath(pathPart);
  if (!documentPath || !documentPath.startsWith("/")) return null;
  return normalizePosixPath(`${dirname(documentPath)}/${pathPart}`);
}
