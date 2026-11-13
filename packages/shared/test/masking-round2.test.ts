import { expect, test } from 'vitest';
import {
  createMasker,
  isAssignmentKeyName,
  isLearnableValue,
  keyNameKind,
  MASK_LEARN_CAP,
  MASK_TYPE_LABELS,
  type MaskCategory,
  type MaskType,
} from '../src/index.js';

// Fix round 2 of the masking review. Every secret-looking value is fake and assembled at run time.
const ALL: MaskCategory[] = ['credential', 'assignment', 'personal', 'custom'];
const SECRET: MaskCategory[] = ['credential', 'assignment'];
const ph = (type: MaskType, n?: number): string => `‹已遮蔽·${MASK_TYPE_LABELS[type]}${n === undefined ? '' : `#${n}`}›`;
const m = (categories: MaskCategory[] = SECRET) => createMasker({ categories });

/** Learns from `first`, then masks `second`. */
function learnThenMask(first: string | unknown, second: string): { site: unknown; other: string; learned: number } {
  const masker = m();
  if (typeof first === 'string') masker.learn(first);
  else masker.learnValue(first);
  const learned = masker.learnedCount();
  const site = typeof first === 'string' ? masker.mask(first) : masker.maskValue(first);
  return { site, other: masker.mask(second), learned };
}

// ---- N1: only secret-like values are learned ----

test.each<[string, unknown, string]>([
  ['docker-compose 里的弱密码', 'POSTGRES_PASSWORD: "password"', 'Enter your password to continue. The password field is required.'],
  ['i18n 标签', { password: 'Password' }, 'Forgot Password? Password'],
  ['校验规则', "rules: { password: 'required' }", 'name is required; email is required'],
  ['工作目录 PWD', 'PWD=/home/x/proj', 'cd /home/x/proj && ls /home/x/proj/src'],
  ['环境变量里的 PWD', { env: { PWD: '/Users/Bob/Code/app', OLDPWD: '/Users/Bob' } }, 'cd /Users/Bob/Code/app'],
  ['Cookie 里的普通词', 'Set-Cookie: theme=darkmode', 'toggle darkmode in settings'],
  ['Basic 的说明文字', 'Authorization: Basic authentication is required', 'We use authentication everywhere'],
  ['rsync -u', 'rsync -u src/ dest/', 'ls src/ dest/'],
  ['rsync -u 主机:路径', 'rsync -avu -u backup:/var/data/archive ./', 'ls backup:/var/data/archive'],
])('不学：%s', (_name, first, second) => {
  const r = learnThenMask(first, second);
  expect(r.learned).toBe(0);
  expect(r.other).toBe(second);
});

test('原处照常遮：弱密码、Cookie 值', () => {
  expect(m().mask('POSTGRES_PASSWORD: "password"')).toBe(`POSTGRES_PASSWORD: "${ph('assignment', 1)}"`);
  expect(m().mask('Set-Cookie: theme=darkmode')).toBe(`Set-Cookie: theme=${ph('cookie', 1)}`);
});

test.each([
  ['PWD', 'PWD=/home/x/proj'],
  ['OLDPWD', 'OLDPWD=/Users/Bob/Code/app'],
  ['密码类键名后是路径', 'PASSWORD_FILE=/run/secrets/db_password'],
  ['rsync -u', 'rsync -u src/ dest/'],
  ['rsync 主机:路径', 'rsync -avu -u backup:/var/data/archive ./'],
  ['docker -u uid:gid', 'docker run -u 1000:1000 image'],
  ['Basic 后是说明文字', 'Authorization: Basic authentication is required'],
])('不遮：%s', (_name, text) => {
  expect(m(ALL).mask(text)).toBe(text);
});

test('学：强的值和固定格式的凭据；别处原样出现也遮', () => {
  const pw = 'Hunter2' + 'Hunter2xyz';
  const key = 'gh' + 'p_' + 'a1B2'.repeat(9);
  const r = learnThenMask(`DB_PASSWORD=${pw} and ${key}`, `psql -W ${pw}; echo ${key}`);
  expect(r.learned).toBe(2);
  expect(r.other).toBe(`psql -W ${ph('assignment', 1)}; echo ${ph('github-token', 1)}`);
});

test.each(['Hunter2Hunter2xyz', 'Xk9#mP2vQ8zL', 'p4ss@w0rd!2024', 'abc123def456ghi'])('可学：%s', (v) => {
  expect(isLearnableValue(v)).toBe(true);
});
test.each(['password', 'Password', 'required', 'darkmode', 'Correct-Horse-Battery', 'authentication', '/home/x/proj', '~/proj/a1b2c3d4', 'C:\\Users\\a1\\x', 'https://x1.example/a', 'short1A', '12345678901234', 'Please enter 8 chars', 'src/a1/b2c3d4e5'])(
  '不可学：%s',
  (v) => {
    expect(isLearnableValue(v)).toBe(false);
  },
);

test('键名：pwd 不再是密钥名，pass 只作为整段', () => {
  for (const name of ['PWD', 'OLDPWD', 'pwd', 'passport', 'compass', 'bypass_cache']) expect(isAssignmentKeyName(name), name).toBe(false);
  for (const name of ['db_pass', 'PASS', 'smtpPass', 'pass']) expect(isAssignmentKeyName(name), name).toBe(true);
  expect(m().mask('db_pass=Abc12345xyz PASS="letmein"')).toBe(`db_pass=${ph('assignment', 1)} PASS="${ph('assignment', 2)}"`);
});

// ---- N2: truncated mode only for the tail, never for glued starts, needs 4 key characters ----

test.each([
  ['risk-score', 'Fix risk-score'],
  ['task-list', 'run npm task-list'],
  ['desk-top', 'clean the desk-top'],
  ['ASIAN', 'VISIT ASIAN'],
  ['eyJx', 'notes on eyJx'],
  ['token: string', 'token: string'],
  ['task-manag…', 'npm run task-manag…'],
  ['中间的前缀', 'see sk-abcd and the rest of it…'],
  ['只有 3 个字符', 'key sk-abc…'],
])('截断模式下不遮：%s', (_name, text) => {
  const masker = m(ALL);
  expect(masker.mask(text, { truncated: true })).toBe(text);
  masker.learn(text, { truncated: true });
  expect(masker.learnedCount()).toBe(0);
});

test('截断模式：末尾的前缀加至少 4 个字符才遮；密码类键名的值一直到末尾时遮，其他键名照常筛选', () => {
  expect(m().mask('curl -H "x: sk-proj-ab12…', { truncated: true })).toBe(`curl -H "x: ${ph('openai-key', 1)}…`);
  expect(m().mask('push ghp_ab12…', { truncated: true })).toBe(`push ${ph('github-token', 1)}…`);
  expect(m().mask('{"password":"x…', { truncated: true })).toBe(`{"password":"${ph('assignment', 1)}`);
  expect(m().mask('{"token":"abc…', { truncated: true })).toBe('{"token":"abc…');
});

// ---- N3: token counters are a closed list ----

test.each(['tokens', 'token_count', 'tokenCounts', 'num_tokens', 'n_tokens', 'max_tokens', 'maxOutputTokens', 'max_input_tokens', 'max_completion_tokens', 'min_tokens', 'total_tokens', 'input_tokens', 'outputTokens', 'prompt_tokens', 'completion_tokens', 'reasoning_tokens', 'cached_tokens', 'cachedInputTokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'tokens_used', 'tokens_per_second', 'token_limit', 'token_usage', 'token_type', 'tokenizer', 'tokenize', 'tokenized', 'tokenization', 'tokenizer_name'])(
  '计数类名字：%s',
  (name) => {
    expect(keyNameKind(name)).toBe('counter');
    expect(isAssignmentKeyName(name)).toBe(false);
  },
);

test.each(['refresh_tokens', 'access_tokens', 'apiTokens', 'botTokens', 'token_store', 'tokenSig', 'tokenSalt', 'id_token', 'session_token', 'csrf_token', 'token_sha256', 'tokenizerSecret'])(
  '仍是密钥名：%s',
  (name) => {
    expect(isAssignmentKeyName(name)).toBe(true);
  },
);

test('计数类名字下：数字、布尔、模型名不遮；长而随机的字符串照遮', () => {
  const strong = 'Ab1' + 'Cd2Ef3Gh4Ij5Kl6';
  expect(m().maskValue({ max_tokens: 4096, tokenizer: 'cl100k_base', token_type: 'Bearer', stream: true, input_tokens: strong })).toEqual({
    max_tokens: 4096,
    tokenizer: 'cl100k_base',
    token_type: 'Bearer',
    stream: true,
    input_tokens: ph('assignment', 1),
  });
  expect(m().mask(`max_tokens=4096 tokenizer: cl100k_base total_tokens=${strong}`)).toBe(`max_tokens=4096 tokenizer: cl100k_base total_tokens=${ph('assignment', 1)}`);
});

test('Google OAuth 令牌', () => {
  const access = 'ya29' + '.a0AfB_byC' + 'x1Y2'.repeat(6);
  const refresh = '1//' + '0gAbCd' + 'Q1w2'.repeat(5);
  const value = { refresh_tokens: [refresh], access_tokens: { google: access } };
  const out = JSON.stringify(m().maskValue(value));
  expect(out).not.toContain(access);
  expect(out).not.toContain(refresh);
  expect(m(['credential']).mask(`Authorization: x ${access}`)).toBe(`Authorization: x ${ph('google-oauth', 1)}`);
  expect(m(['credential']).mask(`refresh=${refresh}`)).toBe(`refresh=${ph('google-oauth', 1)}`);
  for (const text of ['http://1//' + 'abcdefghijklmnopqrstuvwxyz', 'ya29.short', 'version 1//2 of 3']) expect(m(['credential']).mask(text)).toBe(text);
});

// ---- minors ----

test.each(['risk_test_CalculatesValueAtRisk1.py', 'desk_live_ReportGeneratorV2Final.ts', 'mask_test_SomethingNamedClass2.ts'])('Stripe：紧贴单词、不够随机的不算：%s', (text) => {
  expect(m(['credential']).mask(text)).toBe(text);
});

test('学到的值：共享前缀的值再多也不漏', () => {
  const masker = m();
  const real = 'Zq8shared' + '1xY';
  for (let i = 0; i < 70; i++) masker.learn(`password="Zq8shared${i}xY${'a'.repeat(20)}Q${i}"`);
  masker.learn(`password="${real}"`);
  expect(masker.mask(`echo ${real} done`)).toBe(`echo ${ph('assignment', 1)} done`);
});

test('学到的值：工作量超限时只停止这段文字的学到值查找，按规则照常遮，并计入报告', () => {
  const masker = m();
  const v = 'a'.repeat(510) + 'Q1';
  masker.learn(`password="${v}"`);
  const text = 'a'.repeat(100_000) + ` key ${'gh' + 'p_' + 'a1B2'.repeat(9)}`;
  const out = masker.mask(text);
  expect(out).not.toBe('‹已遮蔽·处理失败›');
  expect(out.endsWith(`key ${ph('github-token', 1)}`)).toBe(true);
  expect(masker.report().learnedSkipped).toBe(1);
});

test('学到的值有上限，超出时报告 learnedCapped', () => {
  const masker = m(['credential']);
  const keys: string[] = [];
  for (let i = 0; i <= MASK_LEARN_CAP; i++) keys.push('gh' + 'p_' + String(i).padStart(36, 'x'));
  masker.learn(keys.join(' '));
  expect(masker.learnedCount()).toBe(MASK_LEARN_CAP);
  masker.mask('x');
  expect(masker.report().learnedCapped).toBe(true);
}, 60_000);

test('wouldMask 不计数、不占编号', () => {
  const masker = m();
  const key = 'gh' + 'p_' + 'a1B2'.repeat(9);
  expect(masker.wouldMask(`x ${key}`)).toBe(true);
  expect(masker.wouldMask('plain id 1234')).toBe(false);
  expect(masker.report()).toEqual({ total: 0, byType: {} });
  expect(masker.mask(key)).toBe(ph('github-token', 1));
});

test('Cookie: a=b 的类型是 Cookie', () => {
  expect(m().mask('Cookie: a=' + 'b1c2d3')).toBe(`Cookie: a=${ph('cookie', 1)}`);
});

test('.netrc', () => {
  expect(m(['credential']).mask('machine api.example.com\n  login bob\n  password ' + 'Hunter2pw\n')).toBe(
    `machine api.example.com\n  login bob\n  password ${ph('netrc-password', 1)}\n`,
  );
  expect(m(['credential']).mask('machine x login bob password ' + 'S3cret')).toBe(`machine x login bob password ${ph('netrc-password', 1)}`);
  expect(m(['credential']).mask('Reset your password here')).toBe('Reset your password here');
});

// ---- cut text ending inside a custom term or a learned value ----

test('截断的文字以自定义词的开头结尾：至少 3 个字符就遮；1–2 个字符不动；不截断时不动', () => {
  const masker = createMasker({ categories: ['custom'], customTerms: ['BluefinCorp', 'Project Falcon'] });
  expect(masker.mask('ship it for BluefinC…', { truncated: true })).toBe(`ship it for ${ph('custom', 1)}…`);
  expect(masker.mask('ship it for blu…', { truncated: true })).toBe(`ship it for ${ph('custom', 2)}…`);
  expect(masker.mask('ship it for Project Fal...', { truncated: true })).toBe(`ship it for ${ph('custom', 3)}...`);
  expect(masker.mask('ship it for bl…', { truncated: true })).toBe('ship it for bl…');
  expect(masker.mask('ship it for BluefinC', {})).toBe('ship it for BluefinC');
  // Accepted cost: an ordinary word that begins a term at the very end of a cut text.
  expect(masker.mask('the blue…', { truncated: true })).toBe(`the ${ph('custom', 4)}…`);
  // Full terms elsewhere are still found as usual.
  expect(masker.mask('BluefinCorp and Projec…', { truncated: true })).toBe(`${ph('custom', 5)} and ${ph('custom', 6)}…`);
  masker.learn('BluefinC…', { truncated: true });
  expect(masker.learnedCount()).toBe(0);
});

test('截断的文字以学到的值的开头结尾：至少 6 个字符就遮，类型相同；更短的不动', () => {
  const masker = m();
  const pw = 'Hunter2' + 'Hunter2xyz';
  masker.learn(`DB_PASSWORD=${pw}`);
  expect(masker.mask(`psql -W ${pw.slice(0, 9)}…`, { truncated: true })).toBe(`psql -W ${ph('assignment', 1)}…`);
  expect(masker.mask(`psql -W ${pw.slice(0, 5)}…`, { truncated: true })).toBe(`psql -W ${pw.slice(0, 5)}…`);
  expect(masker.mask(`psql -W ${pw.slice(0, 9)}`)).toBe(`psql -W ${pw.slice(0, 9)}`);
});

test('学到的值：4 万个共享前缀的值，查找仍然快而准确', () => {
  const masker = m();
  for (let i = 0; i < 40_000; i++) masker.learn(`token=${'y'.repeat(20)}${i}`);
  expect(masker.learnedCount()).toBe(40_000);
  const text = Array.from({ length: 4000 }, (_, i) => `grep ${'y'.repeat(20)}${i * 7} .`).join('\n');
  const t0 = performance.now();
  const out = masker.mask(text);
  expect(performance.now() - t0).toBeLessThan(2000);
  expect(out).not.toMatch(/y{20}\d/);
  expect(masker.report().learnedSkipped).toBeUndefined();
});
