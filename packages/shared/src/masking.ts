/**
 * Secret masking (spec 2026-11-13-export-and-masking-design.md, section 3): pure functions shared by the server's export
 * and the web page's masking switch. No Node or DOM APIs.
 *
 * - Rules are grouped in four categories (MaskCategory); each match has a type (MaskType) with a Chinese label.
 * - One left-to-right selection over every rule's matches: the earliest start wins, then the longest, then the rule
 *   priority credential > assignment > custom > personal. A match overlapping an already selected one is not dropped
 *   when it reaches past it: the part beyond is masked too (as its own value), so every character any rule matched is
 *   masked (fail closed). Replaced text never takes part in matching again (one pass over the original text).
 * - Every rule is written to run in linear time: candidate starts are found with literal searches or simple global
 *   expressions without nested quantifiers, then validated by hand over bounded or non-overlapping runs.
 * - A matched value is replaced by `‹已遮蔽·<label>#<n>›` (n: per masker, by type and exact value, in first-seen order;
 *   without `#<n>` when numbering is off); a home-directory user name by `~`.
 * - mask() never throws: when anything inside fails, the whole text becomes MASK_FAILED_TEXT (counted as `failed`).
 */

export type MaskCategory = 'credential' | 'assignment' | 'personal' | 'custom';
export const MASK_CATEGORIES: readonly MaskCategory[] = ['credential', 'assignment', 'personal', 'custom'];

export type MaskType =
  | 'openai-key'
  | 'anthropic-key'
  | 'github-token'
  | 'aws-key'
  | 'google-key'
  | 'slack-token'
  | 'npm-token'
  | 'jwt'
  | 'bearer'
  | 'private-key'
  | 'url-password'
  | 'assignment'
  | 'email'
  | 'home-user'
  | 'custom'
  | 'failed';

/** Every type, in the order reports list them. */
export const MASK_TYPES: readonly MaskType[] = [
  'openai-key',
  'anthropic-key',
  'github-token',
  'aws-key',
  'google-key',
  'slack-token',
  'npm-token',
  'jwt',
  'bearer',
  'private-key',
  'url-password',
  'assignment',
  'email',
  'home-user',
  'custom',
  'failed',
];

export const MASK_TYPE_LABELS: Record<MaskType, string> = {
  'openai-key': 'OpenAI key',
  'anthropic-key': 'Anthropic key',
  'github-token': 'GitHub token',
  'aws-key': 'AWS key',
  'google-key': 'Google API key',
  'slack-token': 'Slack token',
  'npm-token': 'npm token',
  jwt: 'JWT',
  bearer: 'Bearer 令牌',
  'private-key': '私钥',
  'url-password': '网址里的密码',
  assignment: '密钥/密码',
  email: '邮箱',
  'home-user': '用户名',
  custom: '自定义词',
  failed: '处理失败',
};

/** The category a type belongs to; `failed` belongs to none (it is counted whatever the categories). */
export const MASK_TYPE_CATEGORY: Record<MaskType, MaskCategory | null> = {
  'openai-key': 'credential',
  'anthropic-key': 'credential',
  'github-token': 'credential',
  'aws-key': 'credential',
  'google-key': 'credential',
  'slack-token': 'credential',
  'npm-token': 'credential',
  jwt: 'credential',
  bearer: 'credential',
  'private-key': 'credential',
  'url-password': 'credential',
  assignment: 'assignment',
  email: 'personal',
  'home-user': 'personal',
  custom: 'custom',
  failed: null,
};

/**
 * categories: the rules to apply. customTerms: literal terms for `custom` (ASCII-case-insensitive; terms shorter than
 * CUSTOM_TERM_MIN_CHARS or longer than CUSTOM_TERM_MAX_CHARS are ignored, at most CUSTOM_TERMS_MAX are used).
 * homeUsers: user names whose home-directory path segment `personal` replaces with `~`. numbered (default true): add
 * `#<n>` to placeholders.
 */
export interface MaskOptions {
  categories: MaskCategory[];
  customTerms?: string[];
  homeUsers?: string[];
  numbered?: boolean;
}

export interface MaskTypeCount {
  occurrences: number;
  distinct: number;
}

/**
 * What a masker replaced so far: per type, how many places and how many different values (`failed`: places only,
 * distinct 0). Never the values. numberingCapped: some type reached MASK_DISTINCT_CAP different values; later new values
 * of that type are masked without a number (and no longer counted in `distinct`).
 */
export interface MaskReport {
  total: number;
  byType: Partial<Record<MaskType, MaskTypeCount>>;
  numberingCapped?: true;
}

export interface Masker {
  mask(text: string): string;
  /** A copy of a JSON-like value with every string masked; see createMasker. */
  maskValue(value: unknown): unknown;
  report(): MaskReport;
}

export const MASK_FAILED_TEXT = '‹已遮蔽·处理失败›';
/** Different values remembered per type for numbering. */
export const MASK_DISTINCT_CAP = 100_000;
/** The longest assignment value considered (characters); a longer unquoted value is masked up to here. */
export const MASK_ASSIGNMENT_VALUE_MAX = 4096;
export const CUSTOM_TERM_MIN_CHARS = 3;
export const CUSTOM_TERM_MAX_CHARS = 200;
export const CUSTOM_TERMS_MAX = 100;
/** maskValue: values nested deeper than this are replaced by MASK_FAILED_TEXT as a whole. */
const MAX_VALUE_DEPTH = 100;

export function maskPlaceholder(type: MaskType, n: number | null): string {
  return `‹已遮蔽·${MASK_TYPE_LABELS[type]}${n === null ? '' : `#${n}`}›`;
}

// ---------------------------------------------------------------------------------------------------------------------
// character classes (char codes)

const isDigit = (c: number): boolean => c >= 48 && c <= 57;
const isUpper = (c: number): boolean => c >= 65 && c <= 90;
const isLower = (c: number): boolean => c >= 97 && c <= 122;
const isAlnum = (c: number): boolean => isDigit(c) || isUpper(c) || isLower(c);
/** [A-Za-z0-9_-] */
const isKeyChar = (c: number): boolean => isAlnum(c) || c === 95 || c === 45;
/** [A-Za-z0-9_] */
const isWordChar = (c: number): boolean => isAlnum(c) || c === 95;
/** [A-Za-z0-9-] */
const isAlnumDash = (c: number): boolean => isAlnum(c) || c === 45;
/** Base64url: [A-Za-z0-9_-] */
const isB64Url = isKeyChar;
/** Bearer token characters: [A-Za-z0-9._~+/=-] */
const isBearerChar = (c: number): boolean => isKeyChar(c) || c === 46 || c === 126 || c === 43 || c === 47 || c === 61;
/** Identifier characters of an assignment's key name: [A-Za-z0-9_.-] */
const isNameChar = (c: number): boolean => isKeyChar(c) || c === 46;
const isSpaceOrTab = (c: number): boolean => c === 32 || c === 9;
const isWhitespace = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11 || c === 0xa0;
/** E-mail local part: [A-Za-z0-9._%+-] */
const isEmailLocal = (c: number): boolean => isKeyChar(c) || c === 46 || c === 37 || c === 43;
/** A user name character (for the "not followed by another name character" check): [A-Za-z0-9._-] */
const isUserChar = isNameChar;

/** The end of the run of `pred` characters starting at `from` (bounded by `limit`). */
function runEnd(text: string, from: number, pred: (c: number) => boolean, limit = text.length): number {
  let i = from;
  while (i < limit && pred(text.charCodeAt(i))) i++;
  return i;
}

const before = (text: string, at: number): number => (at > 0 ? text.charCodeAt(at - 1) : -1);
const charAt = (text: string, at: number): number => (at < text.length ? text.charCodeAt(at) : -1);

// ---------------------------------------------------------------------------------------------------------------------
// candidates

/** A span to mask: [s, e) of the text, its type and priority (lower wins at equal start and length). */
interface Cand {
  s: number;
  e: number;
  type: MaskType;
  p: number;
}

const PRIORITY: Record<MaskCategory, number> = { credential: 0, assignment: 1, custom: 2, personal: 3 };
const cand = (s: number, e: number, type: MaskType): Cand => ({ s, e, type, p: PRIORITY[MASK_TYPE_CATEGORY[type] ?? 'credential'] });

type Out = Cand[];

/** All starts of `needle` in `text`, non-overlapping searches from each start + 1. */
function* starts(text: string, needle: string): Generator<number> {
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) yield at;
}

// ---- credential rules --------------------------------------------------------------------------------------------

/** `sk-…`: Anthropic when it begins `sk-ant-`, else OpenAI. At least 20 key characters after `sk-`. */
function ruleSk(text: string, out: Out): void {
  for (const at of starts(text, 'sk-')) {
    if (isKeyChar(before(text, at))) continue;
    const end = runEnd(text, at + 3, isKeyChar);
    if (end - (at + 3) < 20) continue;
    out.push(cand(at, end, text.startsWith('sk-ant-', at) ? 'anthropic-key' : 'openai-key'));
  }
}

const GITHUB_START = /gh[pousr]_|github_pat_/g;
function ruleGithub(text: string, out: Out): void {
  GITHUB_START.lastIndex = 0;
  for (let m = GITHUB_START.exec(text); m !== null; m = GITHUB_START.exec(text)) {
    const at = m.index;
    const bodyAt = at + m[0].length;
    GITHUB_START.lastIndex = at + 1;
    if (isWordChar(before(text, at))) continue;
    if (m[0] === 'github_pat_') {
      const end = runEnd(text, bodyAt, isWordChar);
      if (end - bodyAt >= 22) out.push(cand(at, end, 'github-token'));
    } else {
      const end = runEnd(text, bodyAt, isAlnum);
      if (end - bodyAt >= 30 && !isWordChar(charAt(text, end))) out.push(cand(at, end, 'github-token'));
    }
  }
}

const AWS_START = /AKIA|ASIA/g;
function ruleAws(text: string, out: Out): void {
  AWS_START.lastIndex = 0;
  for (let m = AWS_START.exec(text); m !== null; m = AWS_START.exec(text)) {
    const at = m.index;
    AWS_START.lastIndex = at + 1;
    if (isAlnum(before(text, at))) continue;
    const isBody = (c: number): boolean => isDigit(c) || isUpper(c);
    const end = runEnd(text, at + 4, isBody, Math.min(text.length, at + 4 + 16));
    if (end === at + 20 && !isAlnum(charAt(text, end))) out.push(cand(at, end, 'aws-key'));
  }
}

function ruleGoogle(text: string, out: Out): void {
  for (const at of starts(text, 'AIza')) {
    if (isKeyChar(before(text, at))) continue;
    const end = runEnd(text, at + 4, isKeyChar, Math.min(text.length, at + 4 + 35));
    if (end === at + 39 && !isKeyChar(charAt(text, end))) out.push(cand(at, end, 'google-key'));
  }
}

const SLACK_START = /xox[abprse]-/g;
function ruleSlack(text: string, out: Out): void {
  SLACK_START.lastIndex = 0;
  for (let m = SLACK_START.exec(text); m !== null; m = SLACK_START.exec(text)) {
    const at = m.index;
    SLACK_START.lastIndex = at + 1;
    if (isAlnumDash(before(text, at))) continue;
    const end = runEnd(text, at + 5, isAlnumDash);
    if (end - (at + 5) >= 10) out.push(cand(at, end, 'slack-token'));
  }
}

function ruleNpm(text: string, out: Out): void {
  for (const at of starts(text, 'npm_')) {
    if (isWordChar(before(text, at))) continue;
    const end = runEnd(text, at + 4, isAlnum, Math.min(text.length, at + 4 + 36));
    if (end === at + 40 && !isAlnum(charAt(text, end))) out.push(cand(at, end, 'npm-token'));
  }
}

/** JWT: `eyJ` header (≥ 10), `.`, payload (≥ 10), `.`, signature (possibly empty), all base64url. */
function ruleJwt(text: string, out: Out): void {
  for (const at of starts(text, 'eyJ')) {
    if (isB64Url(before(text, at))) continue;
    const h = runEnd(text, at, isB64Url);
    if (h - at < 10 || charAt(text, h) !== 46) continue;
    const p = runEnd(text, h + 1, isB64Url);
    if (p - (h + 1) < 10 || charAt(text, p) !== 46) continue;
    const s = runEnd(text, p + 1, isB64Url);
    out.push(cand(at, s, 'jwt'));
  }
}

const BEARER_START = /bearer[ \t]{1,8}/gi;
/** The token after `Bearer ` (8 or more token characters, passing the value filter's "word" test). */
function ruleBearer(text: string, out: Out): void {
  BEARER_START.lastIndex = 0;
  for (let m = BEARER_START.exec(text); m !== null; m = BEARER_START.exec(text)) {
    const at = m.index;
    const tokenAt = at + m[0].length;
    BEARER_START.lastIndex = at + 1;
    const b = before(text, at);
    if (isAlnum(b)) continue;
    const end = runEnd(text, tokenAt, isBearerChar);
    if (end - tokenAt < 8) continue;
    if (!hasDigitOrMixedCase(text, tokenAt, end)) continue;
    out.push(cand(tokenAt, end, 'bearer'));
  }
}

/** PEM private key blocks: from `-----BEGIN <label>-----` (label containing PRIVATE KEY) to its END line, else to the end. */
function rulePrivateKey(text: string, out: Out): void {
  let from = 0;
  for (;;) {
    const at = text.indexOf('-----BEGIN ', from);
    if (at < 0) return;
    const labelAt = at + 11;
    const isLabel = (c: number): boolean => isUpper(c) || isDigit(c) || c === 32;
    const labelEnd = runEnd(text, labelAt, isLabel, Math.min(text.length, labelAt + 80));
    const label = text.slice(labelAt, labelEnd);
    if (!text.startsWith('-----', labelEnd) || !label.includes('PRIVATE KEY')) {
      from = labelAt;
      continue;
    }
    const endMarker = `-----END ${label}-----`;
    const endAt = text.indexOf(endMarker, labelEnd + 5);
    const end = endAt < 0 ? text.length : endAt + endMarker.length;
    out.push(cand(at, end, 'private-key'));
    from = end;
  }
}

/** `scheme://user:password@host`: only the password. Returns the positions of the `@` it used. */
function ruleUrlPassword(text: string, out: Out, usedAt: Set<number>): void {
  let from = 0;
  for (;;) {
    const at = text.indexOf('://', from);
    if (at < 0) return;
    from = at + 3;
    // scheme: a letter then [A-Za-z0-9+.-], directly before
    let s = at;
    while (s > 0 && at - s < 32) {
      const c = text.charCodeAt(s - 1);
      if (isAlnum(c) || c === 43 || c === 46 || c === 45) s--;
      else break;
    }
    if (s === at || !(isUpper(text.charCodeAt(s)) || isLower(text.charCodeAt(s)))) continue;
    const isUserinfo = (c: number): boolean => !(isWhitespace(c) || c === 47 || c === 63 || c === 35 || c === 64);
    const infoEnd = runEnd(text, from, isUserinfo);
    if (charAt(text, infoEnd) !== 64) continue;
    let colon = from;
    while (colon < infoEnd && text.charCodeAt(colon) !== 58) colon++;
    if (colon >= infoEnd) continue;
    const passAt = colon + 1;
    if (passAt >= infoEnd) continue;
    const c0 = text.charCodeAt(passAt);
    if (c0 === 36 || c0 === 60 || c0 === 123) continue; // $ < { : a variable or template
    if (isOneCharRepeated(text, passAt, infoEnd)) continue;
    out.push(cand(passAt, infoEnd, 'url-password'));
    usedAt.add(infoEnd);
    from = infoEnd + 1;
  }
}

// ---- personal ----------------------------------------------------------------------------------------------------

/** E-mail addresses: local part (1–64) @ domain (two or more labels, top-level label of 2–24 letters). */
function ruleEmail(text: string, out: Out, skipAt: Set<number>): void {
  for (const at of starts(text, '@')) {
    if (skipAt.has(at)) continue;
    let s = at;
    while (s > 0 && at - s <= 64 && isEmailLocal(text.charCodeAt(s - 1))) s--;
    if (at - s > 64 || s === at) continue; // too long or empty
    if (s > 0 && isEmailLocal(text.charCodeAt(s - 1))) continue;
    while (s < at && text.charCodeAt(s) === 46) s++; // no leading dot
    if (s === at || text.charCodeAt(at - 1) === 46) continue;
    // domain labels
    let i = at + 1;
    let lastLabelStart = -1;
    let lastLabelEnd = -1;
    let labels = 0;
    for (;;) {
      const e = runEnd(text, i, isAlnumDash, Math.min(text.length, i + 64));
      if (e === i || e - i > 63) break;
      labels++;
      lastLabelStart = i;
      lastLabelEnd = e;
      if (charAt(text, e) === 46 && isAlnumDash(charAt(text, e + 1)) && e + 1 - (at + 1) < 253) i = e + 1;
      else break;
    }
    if (labels < 2) continue;
    const tldLen = lastLabelEnd - lastLabelStart;
    if (tldLen < 2 || tldLen > 24) continue;
    let letters = true;
    for (let k = lastLabelStart; k < lastLabelEnd; k++) {
      const c = text.charCodeAt(k);
      if (!(isUpper(c) || isLower(c))) letters = false;
    }
    if (!letters || isAlnumDash(charAt(text, lastLabelEnd))) continue;
    out.push(cand(s, lastLabelEnd, 'email'));
  }
}

const HOME_START = /[\\/]{1,2}(users|home)[\\/]{1,2}/gi;
/** Home-directory user names in paths (`C:\Users\<name>`, `/Users/<name>`, `/home/<name>`). */
function ruleHomeUsers(text: string, out: Out, names: string[]): void {
  if (names.length === 0) return;
  HOME_START.lastIndex = 0;
  for (let m = HOME_START.exec(text); m !== null; m = HOME_START.exec(text)) {
    const at = m.index;
    const nameAt = at + m[0].length;
    HOME_START.lastIndex = at + 1;
    const segment = m[1]!;
    const windowsStyle = m[0].includes('\\') || (at >= 2 && text.charCodeAt(at - 1) === 58 && (isUpper(text.charCodeAt(at - 2)) || isLower(text.charCodeAt(at - 2))));
    if (!windowsStyle) {
      if (segment !== 'home' && segment !== 'Users') continue;
    }
    for (const name of names) {
      if (nameAt + name.length > text.length) continue;
      const got = text.slice(nameAt, nameAt + name.length);
      const same = windowsStyle ? asciiLower(got) === asciiLower(name) : got === name;
      if (!same || isUserChar(charAt(text, nameAt + name.length))) continue;
      out.push(cand(nameAt, nameAt + name.length, 'home-user'));
      break;
    }
  }
}

// ---- custom ------------------------------------------------------------------------------------------------------

function asciiLower(s: string): string {
  return s.replace(/[A-Z]+/g, (x) => x.toLowerCase());
}

/** Custom terms (already lower-cased, longest first): at each start the longest term; non-overlapping among themselves. */
function ruleCustom(text: string, out: Out, terms: string[]): void {
  if (terms.length === 0) return;
  const lower = asciiLower(text);
  let best: Int32Array | null = null;
  for (const term of terms) {
    for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, at + 1)) {
      best ??= new Int32Array(text.length);
      const end = at + term.length;
      if (best[at]! < end) best[at] = end;
    }
  }
  if (best === null) return;
  for (let i = 0; i < best.length; i++) {
    const end = best[i]!;
    if (end > 0) {
      out.push(cand(i, end, 'custom'));
      i = end - 1;
    }
  }
}

// ---- assignment --------------------------------------------------------------------------------------------------

const NAME_WORDS = ['password', 'passwd', 'pwd', 'secret', 'token', 'apikey', 'accesskey', 'privatekey'];
const NAME_PAIRS: [string, string][] = [
  ['api', 'key'],
  ['access', 'key'],
  ['private', 'key'],
  ['client', 'secret'],
];

/** The lower-cased segments of a name: split at non-alphanumerics and camelCase boundaries (`APIKey` → api, key). */
function nameSegments(name: string): string[] {
  const out: string[] = [];
  for (const part of name.split(/[^A-Za-z0-9]+/)) {
    if (part === '') continue;
    let start = 0;
    for (let i = 1; i < part.length; i++) {
      const prev = part.charCodeAt(i - 1);
      const c = part.charCodeAt(i);
      const next = i + 1 < part.length ? part.charCodeAt(i + 1) : -1;
      if ((isLower(prev) || isDigit(prev)) && isUpper(c)) {
        out.push(part.slice(start, i));
        start = i;
      } else if (isUpper(prev) && isUpper(c) && isLower(next)) {
        out.push(part.slice(start, i));
        start = i;
      }
    }
    out.push(part.slice(start));
  }
  return out.map((s) => s.toLowerCase());
}

/**
 * Whether a key name names a secret (spec 3.2): case-insensitive, a segment (split at `_`, `-`, `.` and camelCase)
 * containing password, passwd, pwd, secret, token, apikey (also access/private key run together), consecutive segments
 * api+key, access+key, private+key, client+secret, or a segment that is exactly `auth`.
 */
export function isAssignmentKeyName(name: string): boolean {
  if (name.length === 0 || name.length > 128) return false;
  const segs = nameSegments(name);
  for (const seg of segs) {
    if (seg === 'auth') return true;
    for (const w of NAME_WORDS) if (seg.includes(w)) return true;
  }
  for (let i = 0; i + 1 < segs.length; i++) {
    for (const [a, b] of NAME_PAIRS) if (segs[i] === a && segs[i + 1] === b) return true;
  }
  return false;
}

function hasDigitOrMixedCase(text: string, from: number, to: number): boolean {
  let upper = false;
  let lower = false;
  for (let i = from; i < to; i++) {
    const c = text.charCodeAt(i);
    if (isDigit(c)) return true;
    if (isUpper(c)) upper = true;
    else if (isLower(c)) lower = true;
  }
  return upper && lower;
}

function isOneCharRepeated(text: string, from: number, to: number): boolean {
  for (let i = from + 1; i < to; i++) if (text.charCodeAt(i) !== text.charCodeAt(from)) return false;
  return true;
}

function atLeastCodePoints(value: string, n: number): boolean {
  if (value.length < n) return false;
  let count = 0;
  for (let i = 0; i < value.length && count < n; i++) {
    const c = value.charCodeAt(i);
    if (!(c >= 0xdc00 && c <= 0xdfff && i > 0 && value.charCodeAt(i - 1) >= 0xd800 && value.charCodeAt(i - 1) <= 0xdbff)) count++;
  }
  return count >= n;
}

/** `ident(.ident | [ … ])+` optionally followed by a call: process.env.X, os.environ["X"], config.x. */
const IDENTIFIER_CHAIN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^\]\n]{0,200}\])+(?:\([^\n]*)?$/;
const PLACEHOLDER_ONLY = /^[xX*._-]+$/;
const PLACEHOLDER_WORDS = /changeme|example|placeholder/i;
const PLACEHOLDER_EXACT = /^(?:null|undefined|true|false|none)$/i;

/**
 * The assignment value filter (spec 3.2): false ("not a real value", do not mask) when the value is shorter than 8
 * characters; begins with `$`, `${`, `%`, `{{` or `<`; is an identifier followed by dots or brackets (process.env.X,
 * os.environ[…], config.x); is an obvious placeholder (one character repeated, only x / * (and separators), `your-…`,
 * containing changeme / example / placeholder, or exactly null / undefined / true / false / none); or contains neither a
 * digit nor both upper- and lower-case letters.
 */
export function isMaskableAssignmentValue(value: string): boolean {
  if (typeof value !== 'string') return false;
  if (!atLeastCodePoints(value, 8)) return false;
  const c0 = value.charCodeAt(0);
  if (c0 === 36 || c0 === 37 || c0 === 60 || value.startsWith('{{')) return false;
  if (IDENTIFIER_CHAIN.test(value)) return false;
  if (isOneCharRepeated(value, 0, value.length) || PLACEHOLDER_ONLY.test(value)) return false;
  if (/^your[-_]/i.test(value) || PLACEHOLDER_WORDS.test(value) || PLACEHOLDER_EXACT.test(value)) return false;
  return hasDigitOrMixedCase(value, 0, value.length);
}

/** Characters ending an unquoted assignment value: whitespace , ; ) } */
const isValueTerminator = (c: number): boolean => isWhitespace(c) || c === 44 || c === 59 || c === 41 || c === 125;

/** The value span starting at `at` (after the operator and spaces): [s, e) of the value, [.., end) of what it covers. */
function valueSpan(text: string, at: number): { s: number; e: number; end: number } | null {
  const max = Math.min(text.length, at + 1 + MASK_ASSIGNMENT_VALUE_MAX);
  const c = charAt(text, at);
  if (c === 34 || c === 39 || c === 96) {
    // "…", '…', `…`: up to the closing quote (not preceded by a backslash)
    for (let i = at + 1; i < max; i++) {
      const d = text.charCodeAt(i);
      if (d === 10) break;
      if (d === c && text.charCodeAt(i - 1) !== 92) return { s: at + 1, e: i, end: i + 1 };
    }
  } else if (c === 92 && charAt(text, at + 1) === 34) {
    // \"…\" (JSON inside a JSON string)
    for (let i = at + 2; i + 1 < max; i++) {
      const d = text.charCodeAt(i);
      if (d === 10) break;
      if (d === 92 && text.charCodeAt(i + 1) === 34) return { s: at + 2, e: i, end: i + 2 };
    }
  }
  if (c < 0 || isValueTerminator(c)) return null;
  const e = runEnd(text, at, (d) => !isValueTerminator(d), Math.min(text.length, at + MASK_ASSIGNMENT_VALUE_MAX));
  return { s: at, e, end: e };
}

const ASSIGNMENT_OPS = /[=:]|--[A-Za-z]/g;

/** `KEY=value`, `KEY: value`, `"key": "value"`, `--key value`, `--key=value` (spec 3.2). */
function ruleAssignment(text: string, out: Out): void {
  let skipTo = 0;
  ASSIGNMENT_OPS.lastIndex = 0;
  for (let m = ASSIGNMENT_OPS.exec(text); m !== null; m = ASSIGNMENT_OPS.exec(text)) {
    const at = m.index;
    ASSIGNMENT_OPS.lastIndex = at + 1;
    if (at < skipTo) continue;
    let valueAt: number;
    if (m[0].startsWith('--')) {
      // --name value (the --name=value form is found at its '=')
      if (isKeyChar(before(text, at))) continue;
      const nameEnd = runEnd(text, at + 2, isKeyChar, Math.min(text.length, at + 2 + 64));
      if (!isAssignmentKeyName(text.slice(at + 2, nameEnd))) continue;
      const sp = runEnd(text, nameEnd, isSpaceOrTab, Math.min(text.length, nameEnd + 8));
      if (sp === nameEnd) continue;
      if (charAt(text, sp) === 45) continue; // another option
      valueAt = sp;
    } else {
      const op = m[0].charCodeAt(0);
      const next = charAt(text, at + 1);
      const prev = before(text, at);
      if (op === 61 && (next === 61 || next === 62 || prev === 61 || prev === 33 || prev === 60 || prev === 62)) continue; // == => != <= >=
      if (op === 58 && (next === 58 || prev === 58 || next === 47)) continue; // :: and ://
      // key: [spaces] [\"|"|'] name, directly before the operator
      let k = at;
      let spaces = 0;
      while (k > 0 && isSpaceOrTab(text.charCodeAt(k - 1)) && spaces < 4) {
        k--;
        spaces++;
      }
      const q = before(text, k);
      if (q === 34 || q === 39) {
        k--;
        if (before(text, k) === 92) k--;
      }
      let n = k;
      while (n > 0 && k - n < 128 && isNameChar(text.charCodeAt(n - 1))) n--;
      if (n === k || (n > 0 && isNameChar(text.charCodeAt(n - 1)))) continue;
      let name = text.slice(n, k);
      name = name.replace(/^[-.]+/, '');
      if (!isAssignmentKeyName(name)) continue;
      valueAt = runEnd(text, at + 1, isSpaceOrTab, Math.min(text.length, at + 1 + 16));
    }
    const span = valueSpan(text, valueAt);
    if (span === null) continue;
    skipTo = span.end;
    if (span.e <= span.s) continue;
    if (!isMaskableAssignmentValue(text.slice(span.s, span.e))) continue;
    out.push(cand(span.s, span.e, 'assignment'));
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// selection

const cmpCand = (a: Cand, b: Cand): number => a.s - b.s || b.e - b.s - (a.e - a.s) || a.p - b.p;

class CandHeap {
  private readonly items: Cand[] = [];
  get size(): number {
    return this.items.length;
  }
  peek(): Cand | undefined {
    return this.items[0];
  }
  push(c: Cand): void {
    const a = this.items;
    a.push(c);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (cmpCand(a[i]!, a[p]!) >= 0) break;
      [a[i], a[p]] = [a[p]!, a[i]!];
      i = p;
    }
  }
  pop(): Cand | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && cmpCand(a[l]!, a[m]!) < 0) m = l;
        if (r < a.length && cmpCand(a[r]!, a[m]!) < 0) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m]!, a[i]!];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Non-overlapping spans, left to right: the earliest start, then the longest, then the priority. A candidate that
 * overlaps the last selected span but reaches past it continues as a candidate for the part beyond.
 */
function selectSpans(cands: Cand[]): Cand[] {
  cands.sort(cmpCand);
  const heap = new CandHeap();
  const out: Cand[] = [];
  let lastEnd = 0;
  let i = 0;
  while (i < cands.length || heap.size > 0) {
    let c: Cand;
    const top = heap.peek();
    if (top !== undefined && (i >= cands.length || cmpCand(top, cands[i]!) <= 0)) c = heap.pop()!;
    else c = cands[i++]!;
    if (c.s >= lastEnd) {
      out.push(c);
      lastEnd = c.e;
    } else if (c.e > lastEnd) heap.push({ ...c, s: lastEnd });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// masker

/** A short key standing for a long value in the numbering map (two 32-bit FNV-1a variants and the length). */
function valueKey(value: string): string {
  if (value.length <= 256) return value;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c ^ (i & 0xff), 0x5bd1e995) >>> 0;
  }
  return `\u0000${value.length}:${h1.toString(36)}:${h2.toString(36)}`;
}

function normalizeTerms(terms: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(terms)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of terms) {
    if (typeof t !== 'string') continue;
    const n = [...t].length;
    if (n < CUSTOM_TERM_MIN_CHARS || n > CUSTOM_TERM_MAX_CHARS) continue;
    const lower = asciiLower(t);
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(lower);
    if (out.length >= CUSTOM_TERMS_MAX) break;
  }
  return out.sort((a, b) => b.length - a.length);
}

function normalizeUsers(users: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(users)) return [];
  const out = new Set<string>();
  for (const u of users) {
    if (typeof u !== 'string' || u === '' || u.length > 100 || /[\\/\s:]/.test(u) || u === '.' || u === '..') continue;
    out.add(u);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/**
 * A masker with its own numbering and report (see the module comment).
 * - mask(text): the text with every match replaced; a non-string is taken as ''.
 * - maskValue(value): a copy of a JSON-like value: strings masked; object keys masked as text too (a collision after
 *   masking keeps both, the later one with ` (2)`… appended); a string under a key that names a secret
 *   (isAssignmentKeyName) is masked as a whole as `assignment` when the value filter lets it (a credential covering the
 *   whole string keeps its own type), else like any string. Other values are copied as they are. Deeper than
 *   MAX_VALUE_DEPTH, or anything failing: MASK_FAILED_TEXT in its place.
 */
export function createMasker(options: MaskOptions): Masker {
  const categories = new Set(Array.isArray(options.categories) ? options.categories : []);
  const credential = categories.has('credential');
  const assignment = categories.has('assignment');
  const personal = categories.has('personal');
  const terms = categories.has('custom') ? normalizeTerms(options.customTerms) : [];
  const users = personal ? normalizeUsers(options.homeUsers) : [];
  const numbered = options.numbered !== false;

  const numbers = new Map<MaskType, Map<string, number>>();
  const counts = new Map<MaskType, MaskTypeCount>();
  let total = 0;
  let capped = false;

  const count = (type: MaskType): MaskTypeCount => {
    let c = counts.get(type);
    if (!c) counts.set(type, (c = { occurrences: 0, distinct: 0 }));
    return c;
  };

  const replacement = (type: MaskType, value: string): string => {
    const c = count(type);
    c.occurrences++;
    total++;
    if (type === 'failed') return MASK_FAILED_TEXT;
    let map = numbers.get(type);
    if (!map) numbers.set(type, (map = new Map()));
    // A user name is one value however a Windows path spells its case.
    const key = valueKey(type === 'home-user' ? asciiLower(value) : value);
    let n = map.get(key);
    if (n === undefined) {
      if (map.size >= MASK_DISTINCT_CAP) {
        capped = true;
        return type === 'home-user' ? '~' : maskPlaceholder(type, null);
      }
      n = map.size + 1;
      map.set(key, n);
      c.distinct++;
    }
    if (type === 'home-user') return '~';
    return maskPlaceholder(type, numbered ? n : null);
  };

  const candidates = (text: string): Cand[] => {
    const out: Cand[] = [];
    const urlAt = new Set<number>();
    if (credential) {
      ruleSk(text, out);
      ruleGithub(text, out);
      ruleAws(text, out);
      ruleGoogle(text, out);
      ruleSlack(text, out);
      ruleNpm(text, out);
      ruleJwt(text, out);
      ruleBearer(text, out);
      rulePrivateKey(text, out);
      ruleUrlPassword(text, out, urlAt);
    }
    if (assignment) ruleAssignment(text, out);
    if (terms.length > 0) ruleCustom(text, out, terms);
    if (personal) {
      ruleEmail(text, out, urlAt);
      ruleHomeUsers(text, out, users);
    }
    return out;
  };

  const apply = (text: string, extra: Cand | null): string => {
    const cands = candidates(text);
    if (extra !== null) cands.push(extra);
    if (cands.length === 0) return text;
    const spans = selectSpans(cands);
    let out = '';
    let at = 0;
    for (const c of spans) {
      out += text.slice(at, c.s);
      out += replacement(c.type, text.slice(c.s, c.e));
      at = c.e;
    }
    return out + text.slice(at);
  };

  const failed = (): string => replacement('failed', '');

  const mask = (text: string): string => {
    if (typeof text !== 'string' || text === '') return '';
    try {
      return apply(text, null);
    } catch {
      return failed();
    }
  };

  const maskKeyed = (text: string): string => {
    if (text === '') return text;
    try {
      // The whole string as an assignment value, competing with the other rules (a credential spanning it all wins).
      const extra = assignment && isMaskableAssignmentValue(text) ? cand(0, text.length, 'assignment') : null;
      return apply(text, extra);
    } catch {
      return failed();
    }
  };

  const walk = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') return value === '' ? '' : mask(value);
    if (value === null || typeof value !== 'object') return value;
    if (depth >= MAX_VALUE_DEPTH) return failed();
    if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      let k = mask(key);
      if (k === '' && key !== '') k = MASK_FAILED_TEXT;
      if (Object.prototype.hasOwnProperty.call(out, k)) {
        let i = 2;
        while (Object.prototype.hasOwnProperty.call(out, `${k} (${i})`)) i++;
        k = `${k} (${i})`;
      }
      out[k] = typeof v === 'string' && isAssignmentKeyName(key) ? maskKeyed(v) : walk(v, depth + 1);
    }
    return out;
  };

  return {
    mask,
    maskValue(value: unknown): unknown {
      try {
        return walk(value, 0);
      } catch {
        return failed();
      }
    },
    report(): MaskReport {
      const byType: Partial<Record<MaskType, MaskTypeCount>> = {};
      for (const type of MASK_TYPES) {
        const c = counts.get(type);
        if (c) byType[type] = { ...c };
      }
      return capped ? { total, byType, numberingCapped: true } : { total, byType };
    },
  };
}
