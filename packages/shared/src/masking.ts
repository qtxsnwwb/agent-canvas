/**
 * Secret masking (spec 2026-11-13-export-and-masking-design.md, section 3): pure functions shared by the server's export
 * and the web page's masking switch. No Node or DOM APIs.
 *
 * - Rules are grouped in four categories (MaskCategory); each match has a type (MaskType) with a Chinese label.
 * - One left-to-right selection over every rule's matches: the earliest start wins, then the longest, then the rule
 *   priority credential > assignment > custom > personal. A match overlapping an already selected one is not dropped
 *   when it reaches past it: the part beyond is masked too (as its own value), so every character any rule matched is
 *   masked (fail closed). Replaced text never takes part in matching again (one pass over the original text).
 * - Fixed-format credentials are recognised wherever they start (after a JSON escape such as `\n`, a `%0A`, an `_` or a
 *   `-` too). A start glued to a preceding letter or digit must look random (stricter body: length, digits, both cases)
 *   so that `task-…` or `risk-…` words are not taken for keys.
 * - Every rule runs in linear time: candidate starts are found with literal searches or simple global expressions
 *   without nested quantifiers, then validated over bounded runs or runs that are examined once (starts inside a run
 *   already examined are skipped). Custom terms use an Aho–Corasick automaton.
 * - A matched value is replaced by `‹已遮蔽·<label>#<n>›` (n: per masker, by type and exact value, in first-seen order;
 *   without `#<n>` when numbering is off); a home-directory user name by `~`.
 * - Learned values (optional, see Masker.learn): values found by the credential and assignment rules in a first pass
 *   are masked wherever they occur literally in later calls, with the type they were first found as.
 * - mask() never throws: when anything inside fails, the whole text becomes MASK_FAILED_TEXT (counted as `failed`).
 */

export type MaskCategory = 'credential' | 'assignment' | 'personal' | 'custom';
export const MASK_CATEGORIES: readonly MaskCategory[] = ['credential', 'assignment', 'personal', 'custom'];

export type MaskType =
  | 'openai-key'
  | 'anthropic-key'
  | 'github-token'
  | 'gitlab-token'
  | 'huggingface-token'
  | 'stripe-key'
  | 'aws-key'
  | 'azure-key'
  | 'google-key'
  | 'slack-token'
  | 'npm-token'
  | 'jwt'
  | 'bearer'
  | 'authorization'
  | 'private-key'
  | 'url-password'
  | 'cli-password'
  | 'cookie'
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
  'gitlab-token',
  'huggingface-token',
  'stripe-key',
  'aws-key',
  'azure-key',
  'google-key',
  'slack-token',
  'npm-token',
  'jwt',
  'bearer',
  'authorization',
  'private-key',
  'url-password',
  'cli-password',
  'cookie',
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
  'gitlab-token': 'GitLab token',
  'huggingface-token': 'Hugging Face token',
  'stripe-key': 'Stripe key',
  'aws-key': 'AWS key',
  'azure-key': 'Azure 存储密钥',
  'google-key': 'Google API key',
  'slack-token': 'Slack token',
  'npm-token': 'npm token',
  jwt: 'JWT',
  bearer: 'Bearer 令牌',
  authorization: 'Authorization 凭据',
  'private-key': '私钥',
  'url-password': '网址里的密码',
  'cli-password': '命令行密码',
  cookie: 'Cookie',
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
  'gitlab-token': 'credential',
  'huggingface-token': 'credential',
  'stripe-key': 'credential',
  'aws-key': 'credential',
  'azure-key': 'credential',
  'google-key': 'credential',
  'slack-token': 'credential',
  'npm-token': 'credential',
  jwt: 'credential',
  bearer: 'credential',
  authorization: 'credential',
  'private-key': 'credential',
  'url-password': 'credential',
  'cli-password': 'credential',
  cookie: 'credential',
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

/**
 * truncated: the text was cut short (a 200-character summary, a title): a credential prefix followed by key characters
 * running to the end of the text (or to a trailing `…` / `...`) is masked although too short to validate, and an
 * assignment whose value runs to the end is masked whatever the value filter says.
 */
export interface MaskTextOptions {
  truncated?: boolean;
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
  mask(text: string, options?: MaskTextOptions): string;
  /** A copy of a JSON-like value with every string masked; see createMasker. */
  maskValue(value: unknown): unknown;
  /**
   * First pass of a two-pass masking (optional): remembers the values the credential and assignment rules find in this
   * text (at least MASK_LEARN_MIN_CHARS characters, held only inside the masker); later mask() / maskValue() calls also
   * mask every literal occurrence of them, typed as first found. Changes neither the report nor the numbering.
   */
  learn(text: string, options?: MaskTextOptions): void;
  /** learn() for a structured value, with maskValue's key-name rules. */
  learnValue(value: unknown): void;
  /** How many different values have been learned. */
  learnedCount(): number;
  report(): MaskReport;
}

export const MASK_FAILED_TEXT = '‹已遮蔽·处理失败›';
/** Different values remembered per type for numbering. */
export const MASK_DISTINCT_CAP = 100_000;
/** The longest assignment value considered (characters); a longer unquoted value is masked up to here. */
export const MASK_ASSIGNMENT_VALUE_MAX = 4096;
/** Learned values shorter than this are not remembered. */
export const MASK_LEARN_MIN_CHARS = 8;
/** Learned values longer than this are not remembered (a PEM block or a 4 KB value recurs under its own rule). */
export const MASK_LEARN_MAX_CHARS = 512;
/** Learned values remembered at most (per masker). */
export const MASK_LEARN_CAP = 200_000;
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
const isLetter = (c: number): boolean => isUpper(c) || isLower(c);
const isAlnum = (c: number): boolean => isDigit(c) || isLetter(c);
const isHex = (c: number): boolean => isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
/** [A-Za-z0-9_-] */
const isKeyChar = (c: number): boolean => isAlnum(c) || c === 95 || c === 45;
/** [A-Za-z0-9_] */
const isWordChar = (c: number): boolean => isAlnum(c) || c === 95;
/** [A-Za-z0-9-] */
const isAlnumDash = (c: number): boolean => isAlnum(c) || c === 45;
/** Base64url: [A-Za-z0-9_-] */
const isB64Url = isKeyChar;
/** [A-Z0-9] */
const isUpperDigit = (c: number): boolean => isUpper(c) || isDigit(c);
/** Token characters after an auth scheme: [A-Za-z0-9._~+/=-] */
const isTokenChar = (c: number): boolean => isKeyChar(c) || c === 46 || c === 126 || c === 43 || c === 47 || c === 61;
/** Base64: [A-Za-z0-9+/=] */
const isBase64 = (c: number): boolean => isAlnum(c) || c === 43 || c === 47 || c === 61;
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

/** Whether `at` follows the end of an escape: `\n` `\t` `\r` `\f` `\b` `\/`, `%XX` or `\uXXXX`. */
function afterEscape(text: string, at: number): boolean {
  if (at >= 2 && text.charCodeAt(at - 2) === 92) return true;
  if (at >= 3 && text.charCodeAt(at - 3) === 37 && isHex(text.charCodeAt(at - 2)) && isHex(text.charCodeAt(at - 1))) return true;
  if (at >= 6 && text.charCodeAt(at - 6) === 92 && text.charCodeAt(at - 5) === 117) {
    for (let i = at - 4; i < at; i++) if (!isHex(text.charCodeAt(i))) return false;
    return true;
  }
  return false;
}

/** A start not glued to a preceding letter or digit (or one right after an escape). */
const cleanStart = (text: string, at: number): boolean => !isAlnum(before(text, at)) || afterEscape(text, at);

function counts(text: string, from: number, to: number): { digit: boolean; upper: boolean; lower: boolean } {
  let digit = false;
  let upper = false;
  let lower = false;
  for (let i = from; i < to; i++) {
    const c = text.charCodeAt(i);
    if (isDigit(c)) digit = true;
    else if (isUpper(c)) upper = true;
    else if (isLower(c)) lower = true;
  }
  return { digit, upper, lower };
}
const looksRandom = (text: string, from: number, to: number): boolean => {
  const c = counts(text, from, to);
  return c.digit && c.upper && c.lower;
};
const hasDigit = (text: string, from: number, to: number): boolean => counts(text, from, to).digit;

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

/** One text being scanned. tEnd: where a truncated text's content ends (before a trailing ellipsis); -1 when not truncated. */
interface Scan {
  text: string;
  out: Cand[];
  tEnd: number;
}

/** Whether a run ending at `end` reaches the end of a truncated text. */
const toCut = (sc: Scan, end: number): boolean => sc.tEnd >= 0 && end >= sc.tEnd;

/** Global-regex starts, each examined once; `skip` returns the position before which further starts are skipped. */
function eachStart(re: RegExp, text: string, visit: (at: number, m: RegExpExecArray) => number): void {
  re.lastIndex = 0;
  let skipTo = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const at = m.index;
    re.lastIndex = at + 1;
    if (at < skipTo) continue;
    skipTo = Math.max(skipTo, visit(at, m));
  }
}

// ---- credential rules --------------------------------------------------------------------------------------------

/**
 * A prefixed token: prefix at `at`, body from `bodyAt` made of `isBody` characters. Accepted when the body has at least
 * `min` characters (a start glued to a letter or digit: at least `gluedMin` and passing `glued`), or when the text is
 * truncated and the body (at least one character) runs to its end. Returns the end of the examined run.
 */
function prefixedToken(
  sc: Scan,
  at: number,
  bodyAt: number,
  type: MaskType,
  isBody: (c: number) => boolean,
  min: number,
  gluedMin: number,
  glued: (from: number, to: number) => boolean,
  rightOk: (c: number) => boolean = () => true,
): number {
  const end = runEnd(sc.text, bodyAt, isBody);
  const len = end - bodyAt;
  if (len >= 1 && toCut(sc, end)) {
    sc.out.push(cand(at, end, type));
    return end;
  }
  if (!rightOk(charAt(sc.text, end))) return end;
  const clean = cleanStart(sc.text, at);
  if (clean ? len >= min : len >= gluedMin && glued(bodyAt, end)) sc.out.push(cand(at, end, type));
  return end;
}

/** A fixed-length token: exactly `length` body characters, not followed by `notAfter`. */
function fixedToken(sc: Scan, at: number, bodyAt: number, type: MaskType, isBody: (c: number) => boolean, length: number, notAfter: (c: number) => boolean): void {
  const end = runEnd(sc.text, bodyAt, isBody, Math.min(sc.text.length, bodyAt + length));
  if (end - bodyAt >= 1 && toCut(sc, end)) {
    sc.out.push(cand(at, end, type));
    return;
  }
  if (end - bodyAt === length && !notAfter(charAt(sc.text, end))) sc.out.push(cand(at, end, type));
}

const SK_START = /sk-/g;
/** `sk-…`: Anthropic when it begins `sk-ant-`, else OpenAI. ≥ 20 key characters (glued: ≥ 32 and random-looking). */
function ruleSk(sc: Scan): void {
  const { text } = sc;
  eachStart(SK_START, text, (at) =>
    prefixedToken(sc, at, at + 3, text.startsWith('sk-ant-', at) ? 'anthropic-key' : 'openai-key', isKeyChar, 20, 32, (f, t) => looksRandom(text, f, t)),
  );
}

const STRIPE_START = /[sr]k_(?:live|test)_|whsec_/g;
function ruleStripe(sc: Scan): void {
  eachStart(STRIPE_START, sc.text, (at, m) => prefixedToken(sc, at, at + m[0].length, 'stripe-key', isAlnum, 16, 16, () => true));
}

const GITHUB_START = /gh[pousr]_|github_pat_/g;
function ruleGithub(sc: Scan): void {
  const { text } = sc;
  eachStart(GITHUB_START, text, (at, m) =>
    m[0] === 'github_pat_'
      ? prefixedToken(sc, at, at + 11, 'github-token', isWordChar, 22, 22, () => true)
      : prefixedToken(sc, at, at + 4, 'github-token', isAlnum, 30, 30, (f, t) => hasDigit(text, f, t), (c) => !isWordChar(c)),
  );
}

const GITLAB_START = /glpat-/g;
function ruleGitlab(sc: Scan): void {
  const { text } = sc;
  eachStart(GITLAB_START, text, (at) => prefixedToken(sc, at, at + 6, 'gitlab-token', isKeyChar, 20, 20, (f, t) => hasDigit(text, f, t)));
}

const HF_START = /hf_/g;
function ruleHuggingFace(sc: Scan): void {
  const { text } = sc;
  eachStart(HF_START, text, (at) =>
    prefixedToken(sc, at, at + 3, 'huggingface-token', isAlnum, 30, 30, (f, t) => {
      const c = counts(text, f, t);
      return c.upper && c.lower;
    }),
  );
}

const AWS_START = /AKIA|ASIA/g;
function ruleAws(sc: Scan): void {
  const { text } = sc;
  AWS_START.lastIndex = 0;
  for (let m = AWS_START.exec(text); m !== null; m = AWS_START.exec(text)) {
    const at = m.index;
    AWS_START.lastIndex = at + 1;
    if (!cleanStart(text, at) && !hasDigit(text, at + 4, Math.min(text.length, at + 20))) continue;
    fixedToken(sc, at, at + 4, 'aws-key', isUpperDigit, 16, isAlnum);
  }
}

const GOOGLE_START = /AIza/g;
function ruleGoogle(sc: Scan): void {
  GOOGLE_START.lastIndex = 0;
  for (let m = GOOGLE_START.exec(sc.text); m !== null; m = GOOGLE_START.exec(sc.text)) {
    GOOGLE_START.lastIndex = m.index + 1;
    fixedToken(sc, m.index, m.index + 4, 'google-key', isKeyChar, 35, isKeyChar);
  }
}

const SLACK_START = /xox[abprse]-/g;
function ruleSlack(sc: Scan): void {
  const { text } = sc;
  eachStart(SLACK_START, text, (at) => prefixedToken(sc, at, at + 5, 'slack-token', isAlnumDash, 10, 10, (f, t) => hasDigit(text, f, t)));
}

const NPM_START = /npm_/g;
function ruleNpm(sc: Scan): void {
  NPM_START.lastIndex = 0;
  for (let m = NPM_START.exec(sc.text); m !== null; m = NPM_START.exec(sc.text)) {
    NPM_START.lastIndex = m.index + 1;
    fixedToken(sc, m.index, m.index + 4, 'npm-token', isAlnum, 36, isAlnum);
  }
}

const JWT_START = /eyJ/g;
/** JWT: `eyJ` header (≥ 10), `.`, payload (≥ 10), `.`, signature (possibly empty), all base64url. */
function ruleJwt(sc: Scan): void {
  const { text } = sc;
  eachStart(JWT_START, text, (at) => {
    const h = runEnd(text, at, isB64Url);
    if (toCut(sc, h) && h - at > 3) {
      sc.out.push(cand(at, h, 'jwt'));
      return h;
    }
    if (h - at < 10 || charAt(text, h) !== 46) return h;
    const p = runEnd(text, h + 1, isB64Url);
    if (toCut(sc, p)) {
      sc.out.push(cand(at, p, 'jwt'));
      return p;
    }
    if (p - (h + 1) < 10 || charAt(text, p) !== 46) return p;
    const s = runEnd(text, p + 1, isB64Url);
    sc.out.push(cand(at, s, 'jwt'));
    return s;
  });
}

const BEARER_START = /bearer[ \t]{1,8}/gi;
/** The token after `Bearer ` (8 or more token characters with a digit or both cases). */
function ruleBearer(sc: Scan): void {
  const { text } = sc;
  eachStart(BEARER_START, text, (at, m) => {
    const tokenAt = at + m[0].length;
    if (isLetter(before(text, at)) && !afterEscape(text, at)) return at + 1;
    const end = runEnd(text, tokenAt, isTokenChar);
    if (end > tokenAt && toCut(sc, end)) {
      sc.out.push(cand(tokenAt, end, 'bearer'));
      return end;
    }
    if (end - tokenAt < 8) return end;
    const c = counts(text, tokenAt, end);
    if (c.digit || (c.upper && c.lower)) sc.out.push(cand(tokenAt, end, 'bearer'));
    return end;
  });
}

const AUTH_START = /authorization["']?[ \t]{0,8}[:=][ \t]{0,8}["']?(?:basic|token|bot)[ \t]{1,8}/gi;
/** `Authorization: Basic|Token|Bot <credential>`: the credential (≥ 4 token characters). */
function ruleAuthorization(sc: Scan): void {
  const { text } = sc;
  eachStart(AUTH_START, text, (start, m) => {
    const tokenAt = start + m[0].length;
    const end = runEnd(text, tokenAt, isTokenChar);
    if (end - tokenAt >= 4 || (end > tokenAt && toCut(sc, end))) sc.out.push(cand(tokenAt, end, 'authorization'));
    return end;
  });
}

const AZURE_START = /(?:AccountKey|SharedAccessKey)=/gi;
/** Azure connection strings: the value of AccountKey= / SharedAccessKey= (base64, ≥ 8). */
function ruleAzure(sc: Scan): void {
  const { text } = sc;
  eachStart(AZURE_START, text, (start, m) => {
    const at = start + m[0].length;
    const end = runEnd(text, at, isBase64);
    if (end - at >= 8 || (end > at && toCut(sc, end))) sc.out.push(cand(at, end, 'azure-key'));
    return end;
  });
}

/** PEM private key blocks: from `-----BEGIN <label>-----` (label containing PRIVATE KEY) to its END line, else to the end. */
function rulePrivateKey(sc: Scan): void {
  const { text } = sc;
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
    sc.out.push(cand(at, end, 'private-key'));
    from = end;
  }
}

/** Characters of a URL's authority run (userinfo and host): not whitespace / ? " ' < > \ ` */
const isAuthorityChar = (c: number): boolean =>
  !(isWhitespace(c) || c === 47 || c === 63 || c === 34 || c === 39 || c === 60 || c === 62 || c === 92 || c === 96 || c < 0);

/**
 * `scheme://user:password@host`: the password, up to the LAST `@` of the authority (a password may hold `@`, `#`, `:`,
 * percent-escapes). A userinfo without `:` (`https://<token>@host`) is masked when token-like (≥ 8 of [A-Za-z0-9_-]
 * with a digit or both cases). Returns nothing; adds the `@` positions it used to `usedAt`.
 */
function ruleUrlPassword(sc: Scan, usedAt: Set<number>): void {
  const { text } = sc;
  let from = 0;
  for (;;) {
    const at = text.indexOf('://', from);
    if (at < 0) return;
    from = at + 3;
    let s = at;
    while (s > 0 && at - s < 32) {
      const c = text.charCodeAt(s - 1);
      if (isAlnum(c) || c === 43 || c === 46 || c === 45) s--;
      else break;
    }
    if (s === at || !isLetter(text.charCodeAt(s))) continue;
    const runStop = runEnd(text, from, isAuthorityChar, Math.min(text.length, from + 2048));
    let lastAt = -1;
    for (let i = runStop - 1; i >= from; i--) {
      if (text.charCodeAt(i) === 64) {
        lastAt = i;
        break;
      }
    }
    if (lastAt < 0) {
      if (toCut(sc, runStop)) maskUserinfoToEnd(sc, from, runStop);
      from = Math.max(from, runStop);
      continue;
    }
    let colon = from;
    while (colon < lastAt && text.charCodeAt(colon) !== 58) colon++;
    if (colon < lastAt) {
      const passAt = colon + 1;
      if (passAt < lastAt && !isTemplateStart(text, passAt) && !isOneCharRepeated(text, passAt, lastAt)) {
        sc.out.push(cand(passAt, lastAt, 'url-password'));
        usedAt.add(lastAt);
      }
    } else if (lastAt - from >= 8 && runEnd(text, from, isKeyChar, lastAt) === lastAt) {
      const c = counts(text, from, lastAt);
      if (c.digit || (c.upper && c.lower)) {
        sc.out.push(cand(from, lastAt, 'url-password'));
        usedAt.add(lastAt);
      }
    }
    from = Math.max(from, runStop);
  }
}

/** A truncated URL whose userinfo runs to the end: `scheme://user:pa…` — mask after the first `:`. */
function maskUserinfoToEnd(sc: Scan, from: number, end: number): void {
  const { text } = sc;
  let colon = from;
  while (colon < end && text.charCodeAt(colon) !== 58) colon++;
  // A host:port runs to the end the same way; only a colon followed by something other than digits is a password.
  if (colon + 1 < end && !/^\d*$/.test(text.slice(colon + 1, Math.min(end, sc.tEnd)))) sc.out.push(cand(colon + 1, end, 'url-password'));
}

const CURL_USER = /(?:^|[^A-Za-z0-9_-])(?:-u|--user)(?:[ \t]{1,8}|=)/g;
const MYSQL_WORD = /(?:mysql|mariadb|mysqldump|mysqladmin)(?![A-Za-z0-9_-])/g;

/** `curl -u user:pass` / `--user user:pass` (the part after `:`), `mysql … -p<pass>` / `--password=<pass>`. */
function ruleCliPassword(sc: Scan): void {
  const { text } = sc;
  CURL_USER.lastIndex = 0;
  for (let m = CURL_USER.exec(text); m !== null; m = CURL_USER.exec(text)) {
    const valueAt = m.index + m[0].length;
    CURL_USER.lastIndex = Math.max(m.index + 1, valueAt);
    const span = valueSpan(text, valueAt);
    if (span === null) continue;
    CURL_USER.lastIndex = Math.max(CURL_USER.lastIndex, span.end);
    let colon = span.s;
    while (colon < span.e && text.charCodeAt(colon) !== 58) colon++;
    if (colon + 1 < span.e && !isTemplateStart(text, colon + 1)) sc.out.push(cand(colon + 1, span.e, 'cli-password'));
  }
  MYSQL_WORD.lastIndex = 0;
  let scanned = 0;
  for (let m = MYSQL_WORD.exec(text); m !== null; m = MYSQL_WORD.exec(text)) {
    if (isKeyChar(before(text, m.index)) && !afterEscape(text, m.index)) continue;
    let i = Math.max(m.index + m[0].length, scanned);
    const limit = Math.min(text.length, i + 400);
    while (i < limit) {
      const c = text.charCodeAt(i);
      if (c === 10 || c === 13 || c === 59 || c === 124 || c === 38) break; // end of line or command
      if (isSpaceOrTab(c) && charAt(text, i + 1) === 45 && charAt(text, i + 2) === 112 && !isWhitespace(charAt(text, i + 3)) && charAt(text, i + 3) >= 0) {
        const valueAt = i + 3;
        const end = runEnd(text, valueAt, (d) => !isWhitespace(d) && d !== 59 && d !== 124 && d !== 38);
        if (!isTemplateStart(text, valueAt)) sc.out.push(cand(valueAt, end, 'cli-password'));
        i = end;
        continue;
      }
      if (isSpaceOrTab(c) && text.startsWith('--password=', i + 1)) {
        const span = valueSpan(text, i + 12);
        if (span !== null && span.e > span.s && !isTemplateStart(text, span.s)) sc.out.push(cand(span.s, span.e, 'cli-password'));
        i = span === null ? i + 12 : span.end;
        continue;
      }
      i++;
    }
    scanned = i;
  }
}

const COOKIE_START = /(?:set-)?cookie["']?[ \t]{0,8}:[ \t]{0,8}["']?/gi;
const COOKIE_ATTRIBUTES = new Set(['path', 'domain', 'expires', 'max-age', 'samesite', 'secure', 'httponly', 'priority', 'partitioned']);
/** `Cookie:` / `Set-Cookie:` header values: every cookie value (Set-Cookie: the first pair's), names kept. */
function ruleCookie(sc: Scan): void {
  const { text } = sc;
  COOKIE_START.lastIndex = 0;
  let scanned = 0;
  for (let m = COOKIE_START.exec(text); m !== null; m = COOKIE_START.exec(text)) {
    COOKIE_START.lastIndex = m.index + 1;
    if (m.index < scanned) continue;
    const b = before(text, m.index);
    if ((isAlnum(b) || b === 95) && !afterEscape(text, m.index)) continue;
    const set = m[0].toLowerCase().startsWith('set-');
    const at = m.index + m[0].length;
    const end = runEnd(text, at, (c) => c !== 10 && c !== 13 && c !== 34 && c !== 39 && c !== 92 && c !== 60, Math.min(text.length, at + 8192));
    scanned = end;
    let i = at;
    let first = true;
    while (i < end) {
      let semi = i;
      while (semi < end && text.charCodeAt(semi) !== 59) semi++;
      let eq = i;
      while (eq < semi && text.charCodeAt(eq) !== 61) eq++;
      if (eq < semi) {
        const name = text.slice(i, eq).trim().toLowerCase();
        let vs = eq + 1;
        while (vs < semi && isSpaceOrTab(text.charCodeAt(vs))) vs++;
        let ve = semi;
        while (ve > vs && isSpaceOrTab(text.charCodeAt(ve - 1))) ve--;
        const isAttribute = set && (!first || COOKIE_ATTRIBUTES.has(name));
        if (ve > vs && !isAttribute) sc.out.push(cand(vs, ve, 'cookie'));
      }
      first = false;
      i = semi + 1;
    }
  }
}

// ---- personal ----------------------------------------------------------------------------------------------------

/** E-mail addresses: local part (1–64) @ domain (two or more labels, top-level label of 2–24 letters). */
function ruleEmail(sc: Scan, skipAt: Set<number>): void {
  const { text } = sc;
  for (let at = text.indexOf('@'); at >= 0; at = text.indexOf('@', at + 1)) {
    if (skipAt.has(at)) continue;
    let s = at;
    while (s > 0 && at - s <= 64 && isEmailLocal(text.charCodeAt(s - 1))) s--;
    if (at - s > 64 || s === at) continue;
    if (s > 0 && isEmailLocal(text.charCodeAt(s - 1))) continue;
    while (s < at && text.charCodeAt(s) === 46) s++;
    if (s === at || text.charCodeAt(at - 1) === 46) continue;
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
    for (let k = lastLabelStart; k < lastLabelEnd; k++) if (!isLetter(text.charCodeAt(k))) letters = false;
    if (!letters || isAlnumDash(charAt(text, lastLabelEnd))) continue;
    sc.out.push(cand(s, lastLabelEnd, 'email'));
  }
}

const HOME_START = /[\\/]{1,2}(users|home)[\\/]{1,2}/gi;
/** Home-directory user names in paths (`C:\Users\<name>`, `/Users/<name>`, `/home/<name>`). */
function ruleHomeUsers(sc: Scan, names: string[]): void {
  const { text } = sc;
  if (names.length === 0) return;
  HOME_START.lastIndex = 0;
  for (let m = HOME_START.exec(text); m !== null; m = HOME_START.exec(text)) {
    const at = m.index;
    const nameAt = at + m[0].length;
    HOME_START.lastIndex = at + 1;
    const segment = m[1]!;
    const windowsStyle = m[0].includes('\\') || (at >= 2 && text.charCodeAt(at - 1) === 58 && isLetter(text.charCodeAt(at - 2)));
    if (!windowsStyle && segment !== 'home' && segment !== 'Users') continue;
    for (const name of names) {
      if (nameAt + name.length > text.length) continue;
      const got = text.slice(nameAt, nameAt + name.length);
      const same = windowsStyle ? asciiLower(got) === asciiLower(name) : got === name;
      if (!same || isUserChar(charAt(text, nameAt + name.length))) continue;
      sc.out.push(cand(nameAt, nameAt + name.length, 'home-user'));
      break;
    }
  }
}

// ---- custom (Aho–Corasick) ---------------------------------------------------------------------------------------

function asciiLower(s: string): string {
  return s.replace(/[A-Z]+/g, (x) => x.toLowerCase());
}

/** An Aho–Corasick automaton over UTF-16 code units; `longest[state]`: the longest term that is a suffix there (0: none). */
interface Automaton {
  next: Map<number, number>[];
  fail: Int32Array;
  longest: Int32Array;
}

function buildAutomaton(terms: string[]): Automaton {
  const next: Map<number, number>[] = [new Map()];
  const depth: number[] = [0];
  const terminal: number[] = [0];
  for (const term of terms) {
    let s = 0;
    for (let i = 0; i < term.length; i++) {
      const c = term.charCodeAt(i);
      let t = next[s]!.get(c);
      if (t === undefined) {
        t = next.length;
        next.push(new Map());
        depth.push(depth[s]! + 1);
        terminal.push(0);
        next[s]!.set(c, t);
      }
      s = t;
    }
    terminal[s] = term.length;
  }
  const fail = new Int32Array(next.length);
  const longest = new Int32Array(next.length);
  const queue: number[] = [];
  for (const t of next[0]!.values()) {
    fail[t] = 0;
    longest[t] = terminal[t]!;
    queue.push(t);
  }
  for (let q = 0; q < queue.length; q++) {
    const s = queue[q]!;
    for (const [c, t] of next[s]!) {
      let f = fail[s]!;
      while (f !== 0 && !next[f]!.has(c)) f = fail[f]!;
      const g = next[f]!.get(c);
      fail[t] = g !== undefined && g !== t ? g : 0;
      longest[t] = Math.max(terminal[t]!, longest[fail[t]!]!);
      queue.push(t);
    }
  }
  return { next, fail, longest };
}

/**
 * Custom terms: every occurrence of any term (ASCII-case-insensitive); overlapping occurrences are merged into one span,
 * adjacent ones are not. Linear in the text whatever the terms: per position only the longest term ending there counts
 * (it covers every shorter one ending there).
 */
function ruleCustom(sc: Scan, ac: Automaton | null): void {
  if (ac === null) return;
  const lower = asciiLower(sc.text);
  const spans: [number, number][] = [];
  let s = 0;
  for (let i = 0; i < lower.length; i++) {
    const c = lower.charCodeAt(i);
    for (;;) {
      const t = ac.next[s]!.get(c);
      if (t !== undefined) {
        s = t;
        break;
      }
      if (s === 0) break;
      s = ac.fail[s]!;
    }
    const len = ac.longest[s]!;
    if (len === 0) continue;
    let start = i + 1 - len;
    let end = i + 1;
    while (spans.length > 0 && spans[spans.length - 1]![1] > start) {
      const top = spans.pop()!;
      start = Math.min(start, top[0]);
      end = Math.max(end, top[1]);
    }
    spans.push([start, end]);
  }
  for (const [a, b] of spans) sc.out.push(cand(a, b, 'custom'));
}

// ---- learned values ----------------------------------------------------------------------------------------------

/**
 * Learned values by a hash of their first MASK_LEARN_MIN_CHARS characters (each list longest first), a bit filter over
 * those hashes (most positions of a text are rejected by one bit test), and their types.
 */
interface Learned {
  byHash: Map<number, string[]>;
  filter: Uint32Array;
  types: Map<string, MaskType>;
  sorted: boolean;
}
/** Candidates tried per position at most (a pathological set of values sharing a prefix stays bounded). */
const LEARNED_TRIES = 64;
const HASH_BASE = 0x01000193;
/** HASH_BASE^(MASK_LEARN_MIN_CHARS - 1) mod 2^32. */
const HASH_TOP = (() => {
  let p = 1;
  for (let i = 1; i < MASK_LEARN_MIN_CHARS; i++) p = Math.imul(p, HASH_BASE) >>> 0;
  return p;
})();
const FILTER_BITS = 20;

function hashAt(text: string, from: number): number {
  let h = 0;
  for (let i = from; i < from + MASK_LEARN_MIN_CHARS; i++) h = (Math.imul(h, HASH_BASE) + text.charCodeAt(i)) >>> 0;
  return h;
}
const filterIndex = (h: number): number => h >>> (32 - FILTER_BITS);

function newLearned(): Learned {
  return { byHash: new Map(), filter: new Uint32Array(1 << (FILTER_BITS - 5)), types: new Map(), sorted: true };
}

function addLearned(learned: Learned, value: string, type: MaskType): void {
  learned.types.set(value, type);
  const h = hashAt(value, 0);
  let list = learned.byHash.get(h);
  if (!list) learned.byHash.set(h, (list = []));
  list.push(value);
  const idx = filterIndex(h);
  learned.filter[idx >>> 5]! |= 1 << (idx & 31);
  learned.sorted = false;
}

function ruleLearned(sc: Scan, learned: Learned): void {
  if (learned.types.size === 0) return;
  if (!learned.sorted) {
    for (const list of learned.byHash.values()) list.sort((a, b) => b.length - a.length);
    learned.sorted = true;
  }
  const { text } = sc;
  const k = MASK_LEARN_MIN_CHARS;
  if (text.length < k) return;
  const filter = learned.filter;
  // Bounded work: comparisons beyond this budget (only a text built against the learned values reaches it) make the
  // whole text fail closed (MASK_FAILED_TEXT) instead of running long.
  let budget = 32 * text.length + 1_000_000;
  let h = hashAt(text, 0);
  for (let i = 0; i + k <= text.length; ) {
    const idx = filterIndex(h);
    let matched = 0;
    if ((filter[idx >>> 5]! >>> (idx & 31)) & 1) {
      const list = learned.byHash.get(h);
      if (list !== undefined) {
        const tries = Math.min(list.length, LEARNED_TRIES);
        for (let j = 0; j < tries; j++) {
          const v = list[j]!;
          if (i + v.length > text.length) continue;
          let p = 0;
          while (p < v.length && v.charCodeAt(p) === text.charCodeAt(i + p)) p++;
          budget -= p + 1;
          if (budget < 0) throw new Error('learned-value matching budget exceeded');
          if (p === v.length) {
            sc.out.push(cand(i, i + v.length, learned.types.get(v)!));
            matched = v.length;
            break;
          }
        }
      }
    }
    if (matched > 0) {
      i += matched;
      if (i + k <= text.length) h = hashAt(text, i);
      continue;
    }
    if (i + k < text.length) h = (Math.imul((h - Math.imul(text.charCodeAt(i), HASH_TOP)) >>> 0, HASH_BASE) + text.charCodeAt(i + k)) >>> 0;
    i++;
  }
}

// ---- assignment --------------------------------------------------------------------------------------------------

/** Words whose presence anywhere in a name (case-insensitive, non-alphanumerics removed) names a secret. */
const NAME_WORDS = [
  'password',
  'passwd',
  'passphrase',
  'pwd',
  'secret',
  'token',
  'apikey',
  'accesskey',
  'privatekey',
  'accountkey',
  'credential',
  'authorization',
  'cookie',
];
/** Of those, the ones whose quoted values are masked whatever their case or digits (spec 3.2). */
const PASSWORD_WORDS = ['password', 'passwd', 'passphrase', 'pwd', 'secret', 'privatekey'];

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
      if (((isLower(prev) || isDigit(prev)) && isUpper(c)) || (isUpper(prev) && isUpper(c) && isLower(next))) {
        out.push(part.slice(start, i));
        start = i;
      }
    }
    out.push(part.slice(start));
  }
  return out.map((s) => s.toLowerCase());
}

/**
 * `token` occurrences that are about language-model tokens, not secrets: `tokens`, `tokenizer` / `tokenize…`,
 * `token_count` / `tokenCount` (so max_tokens, inputTokens, outputTokens, cachedInputTokens, token_count are no secret
 * names).
 */
function isCountingToken(compact: string, at: number): boolean {
  const rest = compact.slice(at + 5);
  return rest.startsWith('s') || rest.startsWith('iz') || rest.startsWith('count');
}

function compactName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Whether a key name names a secret (spec 3.2): case-insensitive, the name with non-alphanumerics removed contains
 * password, passwd, passphrase, pwd, secret, token, apikey, accesskey, privatekey, accountkey, credential,
 * authorization or cookie — except `token` as in tokens / tokenizer / token count (isCountingToken) — or a segment
 * (split at `_`, `-`, `.` and camelCase) is exactly `auth`.
 */
export function isAssignmentKeyName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0 || name.length > 128) return false;
  const compact = compactName(name);
  for (const w of NAME_WORDS) {
    for (let at = compact.indexOf(w); at >= 0; at = compact.indexOf(w, at + 1)) {
      if (w === 'token' && isCountingToken(compact, at)) continue;
      return true;
    }
  }
  return nameSegments(name).includes('auth');
}

/** Whether a secret key name is of the password class (quoted values masked whatever their shape). */
export function isPasswordKeyName(name: string): boolean {
  if (!isAssignmentKeyName(name)) return false;
  const compact = compactName(name);
  return PASSWORD_WORDS.some((w) => compact.includes(w));
}

function isOneCharRepeated(text: string, from: number, to: number): boolean {
  for (let i = from + 1; i < to; i++) if (text.charCodeAt(i) !== text.charCodeAt(from)) return false;
  return true;
}

/** `$VAR`, `${…}`, `$(…)` (not `$2b$…`), `{{…`, `<…`, `%VAR%`: a reference, not a value. */
function isTemplateStart(text: string, at: number): boolean {
  const c = charAt(text, at);
  const d = charAt(text, at + 1);
  if (c === 36) {
    if (d === 123 || d === 40) return true;
    if (isLetter(d) || d === 95) {
      // $VAR — but not a crypt hash such as $argon2id$v=19$…, which has more `$`
      const e = runEnd(text, at + 1, isWordChar);
      return charAt(text, e) !== 36;
    }
    return false;
  }
  if (c === 123 && d === 123) return true;
  if (c === 60) return true;
  if (c === 37 && (isLetter(d) || d === 95)) {
    const e = runEnd(text, at + 1, isWordChar);
    return charAt(text, e) === 37;
  }
  return false;
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
const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z_]*$/;
const CALL = /^[A-Za-z_$][\w$.]*\(/;
const DATE = /^\d{4}-\d{2}-\d{2}(?:[T ][0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;
/** A CSS colour (`#ff00aa12`). */
const COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const PLACEHOLDER_ONLY = /^[xX*._-]+$/;
const PLACEHOLDER_WORDS = /changeme|example|placeholder/i;
const PLACEHOLDER_EXACT = /^(?:null|undefined|true|false|none|nil|empty|redacted|hidden)$/i;

/** Where an assignment value came from: quoted (a string literal, or a string in structured data) after which key. */
export interface AssignmentValueContext {
  quoted?: boolean;
  /** The key is of the password class (isPasswordKeyName). */
  passwordKey?: boolean;
}

/**
 * The assignment value filter (spec 3.2). Never masked: empty; a reference or template (`$VAR`, `${…}`, `$(…)`, `{{…`,
 * `<…`, `%VAR%`); a placeholder (one repeated character, only x / * and separators, `your-…`, containing changeme /
 * example / placeholder, or exactly null / undefined / true / false / none / nil / empty / redacted / hidden); a date.
 * Then a quoted value after a password-class key is masked. Otherwise not masked: shorter than 8 characters; an
 * identifier chain (process.env.X, os.environ[…], config.x); an unquoted identifier without digits (a word, a type
 * name); a call (`getToken(`); a value with neither a digit nor both upper- and lower-case letters.
 */
export function isMaskableAssignmentValue(value: string, context: AssignmentValueContext = {}): boolean {
  if (typeof value !== 'string' || value === '') return false;
  if (isTemplateStart(value, 0)) return false;
  if (isOneCharRepeated(value, 0, value.length) || PLACEHOLDER_ONLY.test(value)) return false;
  if (/^your[-_]/i.test(value) || PLACEHOLDER_WORDS.test(value) || PLACEHOLDER_EXACT.test(value)) return false;
  if (DATE.test(value) || COLOR.test(value)) return false;
  if (context.quoted && context.passwordKey) return true;
  if (!atLeastCodePoints(value, 8)) return false;
  if (IDENTIFIER_CHAIN.test(value) || CALL.test(value)) return false;
  if (!context.quoted && PLAIN_IDENTIFIER.test(value)) return false;
  const c = counts(value, 0, value.length);
  return c.digit || (c.upper && c.lower);
}

/** Characters ending an unquoted assignment value: whitespace , ; ) } */
const isValueTerminator = (c: number): boolean => isWhitespace(c) || c === 44 || c === 59 || c === 41 || c === 125;

/** The value span starting at `at`: [s, e) of the value, `end` of what it covers, whether it was quoted and closed. */
function valueSpan(text: string, at: number): { s: number; e: number; end: number; quoted: boolean; open: boolean } | null {
  const max = Math.min(text.length, at + 1 + MASK_ASSIGNMENT_VALUE_MAX);
  const c = charAt(text, at);
  if (c === 34 || c === 39 || c === 96) {
    let i = at + 1;
    for (; i < max; i++) {
      const d = text.charCodeAt(i);
      if (d === 10) break;
      if (d === c && text.charCodeAt(i - 1) !== 92) return { s: at + 1, e: i, end: i + 1, quoted: true, open: false };
    }
    if (i >= text.length) return { s: at + 1, e: text.length, end: text.length, quoted: true, open: true };
  } else if (c === 92 && charAt(text, at + 1) === 34) {
    let i = at + 2;
    for (; i + 1 < max; i++) {
      const d = text.charCodeAt(i);
      if (d === 10) break;
      if (d === 92 && text.charCodeAt(i + 1) === 34) return { s: at + 2, e: i, end: i + 2, quoted: true, open: false };
    }
    if (i + 1 >= text.length) return { s: at + 2, e: text.length, end: text.length, quoted: true, open: true };
  }
  if (c < 0 || isValueTerminator(c)) return null;
  const e = runEnd(text, at, (d) => !isValueTerminator(d), Math.min(text.length, at + MASK_ASSIGNMENT_VALUE_MAX));
  return { s: at, e, end: e, quoted: false, open: e >= text.length };
}

const ASSIGNMENT_OPS = /[=:]|--[A-Za-z]/g;

/** `KEY=value`, `KEY: value`, `"key": "value"`, `--key value`, `--key=value` (spec 3.2). */
function ruleAssignment(sc: Scan): void {
  const { text } = sc;
  let skipTo = 0;
  ASSIGNMENT_OPS.lastIndex = 0;
  for (let m = ASSIGNMENT_OPS.exec(text); m !== null; m = ASSIGNMENT_OPS.exec(text)) {
    const at = m.index;
    ASSIGNMENT_OPS.lastIndex = at + 1;
    if (at < skipTo) continue;
    let valueAt: number;
    let name: string;
    if (m[0].startsWith('--')) {
      if (isKeyChar(before(text, at))) continue;
      const nameEnd = runEnd(text, at + 2, isKeyChar, Math.min(text.length, at + 2 + 64));
      name = text.slice(at + 2, nameEnd);
      if (!isAssignmentKeyName(name)) continue;
      const sp = runEnd(text, nameEnd, isSpaceOrTab, Math.min(text.length, nameEnd + 8));
      if (sp === nameEnd) continue;
      if (charAt(text, sp) === 45) continue; // another option
      valueAt = sp;
    } else {
      const op = m[0].charCodeAt(0);
      const next = charAt(text, at + 1);
      const prev = before(text, at);
      if (op === 61 && (next === 61 || next === 62 || prev === 61 || prev === 33 || prev === 60 || prev === 62)) continue;
      if (op === 58 && (next === 58 || prev === 58 || next === 47)) continue;
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
      name = text.slice(n, k).replace(/^[-.]+/, '');
      if (!isAssignmentKeyName(name)) continue;
      valueAt = runEnd(text, at + 1, isSpaceOrTab, Math.min(text.length, at + 1 + 16));
    }
    const span = valueSpan(text, valueAt);
    if (span === null) continue;
    skipTo = span.end;
    if (span.e <= span.s) continue;
    const value = text.slice(span.s, span.e);
    const cut = toCut(sc, span.e) && (span.open || !span.quoted);
    if (cut ? !isTemplateStart(value, 0) : isMaskableAssignmentValue(value, { quoted: span.quoted, passwordKey: isPasswordKeyName(name) })) {
      sc.out.push(cand(span.s, span.e, 'assignment'));
    }
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
  return out;
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

/** Where a truncated text's content ends: before a trailing `…` or `...`. */
function contentEnd(text: string): number {
  if (text.endsWith('…')) return text.length - 1;
  if (text.endsWith('...')) return text.length - 3;
  return text.length;
}

/** Sets `key` on `out` as plain data (`__proto__` included). */
function setOwn(out: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * A masker with its own numbering and report (see the module comment).
 * - mask(text, { truncated }): the text with every match replaced; a non-string is taken as ''.
 * - maskValue(value): a copy of a JSON-like value: strings masked; object keys masked as text too (a collision after
 *   masking keeps both, the later one with ` (2)`… appended; `__proto__` and the like stay plain keys). Under a key that
 *   names a secret (isAssignmentKeyName): a string is masked as a whole as `assignment` when the value filter lets it
 *   (as a quoted value: a password-class key masks any non-placeholder string; a credential covering the whole string
 *   keeps its own type), a number is replaced by the placeholder, true / false / null are kept, and every string and
 *   number inside an array or object is masked as a whole. Deeper than MAX_VALUE_DEPTH, or anything failing:
 *   MASK_FAILED_TEXT in its place.
 * - learn / learnValue: see Masker.
 */
export function createMasker(options: MaskOptions): Masker {
  const categories = new Set(Array.isArray(options.categories) ? options.categories : []);
  const credential = categories.has('credential');
  const assignment = categories.has('assignment');
  const personal = categories.has('personal');
  const terms = categories.has('custom') ? normalizeTerms(options.customTerms) : [];
  const automaton = terms.length > 0 ? buildAutomaton(terms) : null;
  const users = personal ? normalizeUsers(options.homeUsers) : [];
  const numbered = options.numbered !== false;
  const learned: Learned = newLearned();

  const numbers = new Map<MaskType, Map<string, number>>();
  const counted = new Map<MaskType, MaskTypeCount>();
  let total = 0;
  let capped = false;

  const count = (type: MaskType): MaskTypeCount => {
    let c = counted.get(type);
    if (!c) counted.set(type, (c = { occurrences: 0, distinct: 0 }));
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

  /** Candidates of the secret rules (credential, assignment, learned) — the ones learn() remembers. */
  const secretCandidates = (sc: Scan, urlAt: Set<number>): void => {
    if (credential) {
      ruleSk(sc);
      ruleStripe(sc);
      ruleGithub(sc);
      ruleGitlab(sc);
      ruleHuggingFace(sc);
      ruleAws(sc);
      ruleAzure(sc);
      ruleGoogle(sc);
      ruleSlack(sc);
      ruleNpm(sc);
      ruleJwt(sc);
      ruleBearer(sc);
      ruleAuthorization(sc);
      rulePrivateKey(sc);
      ruleUrlPassword(sc, urlAt);
      ruleCliPassword(sc);
      ruleCookie(sc);
    }
    if (assignment) ruleAssignment(sc);
  };

  const scanOf = (text: string, opts: MaskTextOptions | undefined): Scan => ({ text, out: [], tEnd: opts?.truncated ? contentEnd(text) : -1 });

  const apply = (text: string, opts: MaskTextOptions | undefined, extra: Cand | null): string => {
    const sc = scanOf(text, opts);
    const urlAt = new Set<number>();
    secretCandidates(sc, urlAt);
    ruleLearned(sc, learned);
    ruleCustom(sc, automaton);
    if (personal) {
      ruleEmail(sc, urlAt);
      ruleHomeUsers(sc, users);
    }
    if (extra !== null) sc.out.push(extra);
    if (sc.out.length === 0) return text;
    const spans = selectSpans(sc.out);
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

  const mask = (text: string, opts?: MaskTextOptions): string => {
    if (typeof text !== 'string' || text === '') return '';
    try {
      return apply(text, opts, null);
    } catch {
      return failed();
    }
  };

  /** A string under a secret key: the whole string as an assignment value, competing with the other rules. */
  const keyedExtra = (text: string, passwordKey: boolean, always: boolean): Cand | null =>
    assignment && (always ? !isTemplateStart(text, 0) : isMaskableAssignmentValue(text, { quoted: true, passwordKey })) ? cand(0, text.length, 'assignment') : null;

  const maskKeyed = (text: string, passwordKey: boolean, always: boolean): string => {
    if (text === '') return text;
    try {
      return apply(text, undefined, keyedExtra(text, passwordKey, always));
    } catch {
      return failed();
    }
  };

  /** A value under a secret key (`inside`: nested in an array or object there, masked whatever its shape). */
  const walkSecret = (value: unknown, passwordKey: boolean, inside: boolean, depth: number): unknown => {
    if (typeof value === 'string') return maskKeyed(value, passwordKey, inside);
    if (typeof value === 'number' || typeof value === 'bigint') return assignment ? replacement('assignment', String(value)) : value;
    if (value === null || typeof value !== 'object') return value;
    if (depth >= MAX_VALUE_DEPTH) return failed();
    if (Array.isArray(value)) return value.map((v) => walkSecret(v, passwordKey, true, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) setOwn(out, maskedKey(out, key), walkSecret(v, passwordKey, true, depth + 1));
    return out;
  };

  const maskedKey = (out: Record<string, unknown>, key: string): string => {
    let k = mask(key);
    if (k === '' && key !== '') k = MASK_FAILED_TEXT;
    if (Object.prototype.hasOwnProperty.call(out, k)) {
      let i = 2;
      while (Object.prototype.hasOwnProperty.call(out, `${k} (${i})`)) i++;
      k = `${k} (${i})`;
    }
    return k;
  };

  const walk = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') return value === '' ? '' : mask(value);
    if (value === null || typeof value !== 'object') return value;
    if (depth >= MAX_VALUE_DEPTH) return failed();
    if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const secret = isAssignmentKeyName(key);
      setOwn(out, maskedKey(out, key), secret ? walkSecret(v, isPasswordKeyName(key), false, depth + 1) : walk(v, depth + 1));
    }
    return out;
  };

  // ---- learning

  const remember = (value: string, type: MaskType): void => {
    if (value.length < MASK_LEARN_MIN_CHARS || value.length > MASK_LEARN_MAX_CHARS || learned.types.has(value) || learned.types.size >= MASK_LEARN_CAP) return;
    addLearned(learned, value, type);
  };

  const learnText = (text: string, opts: MaskTextOptions | undefined, extra: Cand | null): void => {
    if (typeof text !== 'string' || text === '' || (!credential && !assignment)) return;
    const sc = scanOf(text, opts);
    secretCandidates(sc, new Set());
    if (extra !== null) sc.out.push(extra);
    if (sc.out.length === 0) return;
    for (const c of selectSpans(sc.out)) remember(text.slice(c.s, c.e), c.type);
  };

  const learnSecret = (value: unknown, passwordKey: boolean, inside: boolean, depth: number): void => {
    if (depth >= MAX_VALUE_DEPTH) return;
    if (typeof value === 'string') learnText(value, undefined, keyedExtra(value, passwordKey, inside));
    else if (typeof value === 'number' && assignment) remember(String(value), 'assignment');
    else if (Array.isArray(value)) for (const v of value) learnSecret(v, passwordKey, true, depth + 1);
    else if (value !== null && typeof value === 'object') for (const v of Object.values(value)) learnSecret(v, passwordKey, true, depth + 1);
  };

  const learnWalk = (value: unknown, depth: number): void => {
    if (depth >= MAX_VALUE_DEPTH) return;
    if (typeof value === 'string') learnText(value, undefined, null);
    else if (Array.isArray(value)) for (const v of value) learnWalk(v, depth + 1);
    else if (value !== null && typeof value === 'object') {
      for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        learnText(key, undefined, null);
        if (isAssignmentKeyName(key)) learnSecret(v, isPasswordKeyName(key), false, depth + 1);
        else learnWalk(v, depth + 1);
      }
    }
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
    learn(text: string, opts?: MaskTextOptions): void {
      try {
        learnText(text, opts, null);
      } catch {
        // learning is best effort; mask() still applies every rule
      }
    },
    learnValue(value: unknown): void {
      try {
        learnWalk(value, 0);
      } catch {
        // as above
      }
    },
    learnedCount: () => learned.types.size,
    report(): MaskReport {
      const byType: Partial<Record<MaskType, MaskTypeCount>> = {};
      for (const type of MASK_TYPES) {
        const c = counted.get(type);
        if (c) byType[type] = { ...c };
      }
      return capped ? { total, byType, numberingCapped: true } : { total, byType };
    },
  };
}
