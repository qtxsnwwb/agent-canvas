// Path helpers for file touches. Pure and platform-independent (they run in the browser too): no node:path.
//
// Three absolute forms are recognised after separators are unified to '/':
//   - drive:  `C:/...`  (Windows; the drive letter is upper-cased)
//   - UNC:    `//server/share/...` (Windows; `..` never climbs above the share)
//   - POSIX:  `/...`
// Win32 namespace prefixes (`\\?\C:\…`, `\\.\C:\…`, `\\?\UNC\server\share\…`) are reduced to the plain forms.
// Windows-style paths (drive or UNC) compare case-insensitively; POSIX paths case-sensitively.

interface Parsed {
  /** 'C:/', '//server/share/' or '/'. */
  root: string;
  segments: string[];
}

const DRIVE_ABS = /^([A-Za-z]):\//;
const DRIVE_ANY = /^[A-Za-z]:/;

/** Separators unified to '/', Win32 namespace prefixes removed. */
function unify(raw: string): string {
  const p = raw.replace(/\\/g, '/');
  const unc = /^\/\/[?.]\/UNC\//i.exec(p);
  if (unc) return `//${p.slice(unc[0].length)}`;
  if (/^\/\/[?.]\/[A-Za-z]:/.test(p)) return p.slice(4);
  return p;
}

function resolveSegments(parts: string[], into: string[] = []): string[] {
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') into.pop();
    else into.push(part);
  }
  return into;
}

/** Parses an already-unified absolute path; null when it is not absolute. */
function parseAbsolute(p: string): Parsed | null {
  const drive = DRIVE_ABS.exec(p);
  if (drive) return { root: `${drive[1]!.toUpperCase()}:/`, segments: resolveSegments(p.slice(3).split('/')) };
  if (p.startsWith('//') && p.length > 2 && p[2] !== '/') {
    const parts = p.slice(2).split('/');
    const server = parts[0]!;
    const share = parts[1] ?? '';
    // A missing, '.' or '..' share is no share: the rest resolves under the server.
    if (share === '' || share === '.' || share === '..') return { root: `//${server}/`, segments: resolveSegments(parts.slice(2)) };
    return { root: `//${server}/${share}/`, segments: resolveSegments(parts.slice(2)) };
  }
  if (p.startsWith('/')) return { root: '/', segments: resolveSegments(p.split('/')) };
  return null;
}

function format(parsed: Parsed): string {
  if (parsed.segments.length === 0) {
    // A drive or POSIX root keeps its slash; a UNC share root does not ('//server/share').
    return parsed.root.startsWith('//') ? parsed.root.slice(0, -1) : parsed.root;
  }
  return parsed.root + parsed.segments.join('/');
}

/** A drive-letter or UNC path (raw or normalized): compared case-insensitively. */
export function isWindowsStylePath(path: string): boolean {
  if (typeof path !== 'string') return false;
  const p = path.replace(/\\/g, '/');
  return DRIVE_ANY.test(p) || p.startsWith('//');
}

/** Identity key of a normalized path: lower-cased for Windows-style paths, as is for POSIX ones. */
export function pathKey(path: string): string {
  return isWindowsStylePath(path) ? path.toLowerCase() : path;
}

/**
 * The canonical form of a file path. Surrounding whitespace is trimmed. Absolute input: separators unified to '/',
 * Win32 namespace prefixes removed, drive letter upper-cased, '.' and '..' resolved, duplicate slashes collapsed,
 * trailing slash stripped. Relative input with an absolute cwd: joined to it, then normalized. Relative input without a
 * usable cwd, a drive-relative path (`C:foo`) or a home-relative one (`~`, `~/…`): returned with separators unified. A
 * `file://` URL is returned as given. Empty, whitespace-only or non-string input gives ''. Never throws.
 */
export function normalizeFilePath(raw: string, cwd: string | null): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  if (/^file:\/\//i.test(trimmed)) return trimmed;
  const p = unify(trimmed);
  const abs = parseAbsolute(p);
  if (abs) return format(abs);
  if (DRIVE_ANY.test(p) || p === '~' || p.startsWith('~/')) return p;
  if (typeof cwd === 'string' && cwd.trim() !== '') {
    const base = parseAbsolute(unify(cwd.trim()));
    if (base) return format({ ...base, segments: resolveSegments(p.split('/'), [...base.segments]) });
  }
  return p;
}

/** Whether a (raw or normalized) path is absolute in one of the three forms. */
function isAbsolute(p: string): boolean {
  return parseAbsolute(unify(p.trim())) !== null;
}

/**
 * `path` relative to `dir` when it lies inside it (both normalized; case-insensitive for Windows-style paths),
 * otherwise `path` in full, as given. The dir itself, a sibling sharing a prefix, a relative or missing dir: the full
 * path.
 */
export function relativeToDir(path: string, dir: string | null): string {
  if (typeof path !== 'string' || typeof dir !== 'string' || dir.trim() === '' || !isAbsolute(dir)) return path;
  const d = normalizeFilePath(dir, null);
  const p = normalizeFilePath(path, null);
  const prefix = d.endsWith('/') ? d : `${d}/`;
  const insensitive = isWindowsStylePath(p) || isWindowsStylePath(d);
  const head = p.slice(0, prefix.length);
  const matches = insensitive ? head.toLowerCase() === prefix.toLowerCase() : head === prefix;
  if (!matches || p.length === prefix.length) return path;
  return p.slice(prefix.length);
}

/** Whether two paths name the same file after normalization; case-insensitive when either is Windows-style. */
export function samePath(a: string, b: string): boolean {
  const na = normalizeFilePath(a, null);
  const nb = normalizeFilePath(b, null);
  if (na === '' || nb === '') return false;
  if (isWindowsStylePath(na) || isWindowsStylePath(nb)) return na.toLowerCase() === nb.toLowerCase();
  return na === nb;
}
