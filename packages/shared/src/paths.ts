// Path helpers for file touches. Pure and platform-independent (they run in the browser too): no node:path.
//
// Three absolute forms are recognised after separators are unified to '/':
//   - drive:  `C:/...`  (Windows; the drive letter is upper-cased)
//   - UNC:    `//server/share/...` (Windows; `..` never climbs above the share)
//   - POSIX:  `/...`
// Windows-style paths (drive or UNC) compare case-insensitively; POSIX paths case-sensitively.

interface Parsed {
  /** 'C:/', '//server/share/' or '/'. */
  root: string;
  segments: string[];
  windows: boolean;
}

const DRIVE_ABS = /^([A-Za-z]):\//;
const DRIVE_ANY = /^[A-Za-z]:/;

function unify(raw: string): string {
  return raw.replace(/\\/g, '/');
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
  if (drive) {
    return { root: `${drive[1]!.toUpperCase()}:/`, segments: resolveSegments(p.slice(3).split('/')), windows: true };
  }
  if (p.startsWith('//') && p.length > 2 && p[2] !== '/') {
    const parts = p.slice(2).split('/');
    const server = parts[0]!;
    const share = parts[1] ?? '';
    if (share === '') return { root: `//${server}/`, segments: resolveSegments(parts.slice(2)), windows: true };
    return { root: `//${server}/${share}/`, segments: resolveSegments(parts.slice(2)), windows: true };
  }
  if (p.startsWith('/')) return { root: '/', segments: resolveSegments(p.split('/')), windows: false };
  return null;
}

function format(parsed: Parsed): string {
  if (parsed.segments.length === 0) {
    // A drive or POSIX root keeps its slash; a UNC share root does not ('//server/share').
    return parsed.root.startsWith('//') ? parsed.root.slice(0, -1) : parsed.root;
  }
  return parsed.root + parsed.segments.join('/');
}

/**
 * The canonical form of a file path. Absolute input: separators unified to '/', drive letter upper-cased, '.' and '..'
 * resolved, duplicate slashes collapsed, trailing slash stripped. Relative input with an absolute cwd: joined to it,
 * then normalized. Relative input without a usable cwd: returned with separators unified. A `file://` URL is returned
 * as given. Empty, whitespace-only or non-string input gives ''. Never throws.
 */
export function normalizeFilePath(raw: string, cwd: string | null): string {
  if (typeof raw !== 'string' || raw.trim() === '') return '';
  if (/^file:\/\//i.test(raw)) return raw;
  const p = unify(raw);
  const abs = parseAbsolute(p);
  if (abs) return format(abs);
  if (typeof cwd === 'string' && cwd.trim() !== '' && !DRIVE_ANY.test(p)) {
    const base = parseAbsolute(unify(cwd));
    if (base) {
      return format({ ...base, segments: resolveSegments(p.split('/'), [...base.segments]) });
    }
  }
  return p;
}

function isWindowsStyle(p: string): boolean {
  return DRIVE_ANY.test(p) || p.startsWith('//');
}

/**
 * `path` relative to `dir` when it lies inside it (case-insensitive for Windows-style paths), otherwise `path` in full.
 * The dir itself, a sibling sharing a prefix, or no dir: the full path. `dir` may be un-normalized.
 */
export function relativeToDir(path: string, dir: string | null): string {
  if (typeof path !== 'string' || dir === null || typeof dir !== 'string' || dir.trim() === '') return path;
  const d = normalizeFilePath(dir, null);
  const prefix = d.endsWith('/') ? d : `${d}/`;
  const insensitive = isWindowsStyle(path) || isWindowsStyle(d);
  const head = path.slice(0, prefix.length);
  const matches = insensitive ? head.toLowerCase() === prefix.toLowerCase() : head === prefix;
  if (!matches || path.length === prefix.length) return path;
  return path.slice(prefix.length);
}

/** Whether two paths name the same file after normalization; case-insensitive when either is Windows-style. */
export function samePath(a: string, b: string): boolean {
  const na = normalizeFilePath(a, null);
  const nb = normalizeFilePath(b, null);
  if (na === '' || nb === '') return false;
  if (isWindowsStyle(na) || isWindowsStyle(nb)) return na.toLowerCase() === nb.toLowerCase();
  return na === nb;
}
