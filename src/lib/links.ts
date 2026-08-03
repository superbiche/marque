export type LinkTarget =
  | { kind: "anchor"; slug: string }
  | { kind: "external"; url: string }
  | { kind: "markdown"; path: string; fragment?: string }
  | { kind: "path"; path: string }
  | { kind: "unresolved" };

const MARKDOWN_EXTENSION = /\.(?:md|markdown|mdown|mkd|mdx)$/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function decodeHref(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  if (slash < 0) return ".";
  if (slash === 0) return "/";
  return path.slice(0, slash);
}

/** Normalize a POSIX path without using Node APIs in the webview bundle. */
export function normalizePosixPath(path: string): string {
  const absolute = path.startsWith("/");
  const segments: string[] = [];

  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") {
        segments.pop();
      } else if (!absolute) {
        segments.push(segment);
      }
      continue;
    }
    segments.push(segment);
  }

  const normalized = segments.join("/");
  if (absolute) return normalized ? `/${normalized}` : "/";
  return normalized || ".";
}

/** Classify a raw markdown href for in-app navigation or system opening. */
export function classifyLink(href: string, currentFilePath?: string): LinkTarget {
  const decoded = decodeHref(href);

  if (decoded.startsWith("#")) {
    return { kind: "anchor", slug: decoded.slice(1) };
  }

  if (SCHEME.test(decoded)) {
    return { kind: "external", url: decoded };
  }

  const hash = decoded.indexOf("#");
  const pathPart = hash < 0 ? decoded : decoded.slice(0, hash);
  const fragment = hash < 0 ? undefined : decoded.slice(hash + 1);
  const absolute = pathPart.startsWith("/");

  if (!absolute && !currentFilePath) return { kind: "unresolved" };

  const path = absolute
    ? normalizePosixPath(pathPart)
    : normalizePosixPath(`${dirname(currentFilePath!)}${pathPart ? `/${pathPart}` : ""}`);

  if (MARKDOWN_EXTENSION.test(path)) {
    return fragment === undefined
      ? { kind: "markdown", path }
      : { kind: "markdown", path, fragment };
  }

  return { kind: "path", path };
}
