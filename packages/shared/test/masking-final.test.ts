import { expect, test } from 'vitest';
import {
  createMasker,
  cutMaskedText,
  isCutSummary,
  isCutTitle,
  isPathLike,
  maskWarnings,
  MASK_TYPE_LABELS,
  SESSION_TITLE_CHARS,
  SUMMARY_MAX,
  type MaskCategory,
  type MaskType,
} from '../src/index.js';

// Final review fixes. Every secret-looking value is fake and assembled at run time.
const SECRET: MaskCategory[] = ['credential', 'assignment'];
const ph = (type: MaskType, n?: number): string => `‹已遮蔽·${MASK_TYPE_LABELS[type]}${n === undefined ? '' : `#${n}`}›`;
const m = (categories: MaskCategory[] = SECRET) => createMasker({ categories });
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// ---- C1: cut titles and summaries ----

test('截断的标题和摘要的判断', () => {
  expect(SESSION_TITLE_CHARS).toBe(60);
  expect(isCutTitle('x'.repeat(60))).toBe(true);
  expect(isCutTitle('中'.repeat(60))).toBe(true);
  expect(isCutTitle('x'.repeat(59))).toBe(false);
  expect(isCutTitle('short…')).toBe(true);
  expect(isCutTitle('short...')).toBe(true);
  expect(isCutSummary('x'.repeat(SUMMARY_MAX))).toBe(true);
  expect(isCutSummary('x'.repeat(SUMMARY_MAX - 1))).toBe(false);
  expect(isCutSummary('abc…')).toBe(true);
});

test.each<[string, string, MaskType]>([
  ['GitHub', 'gh' + 'p_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8', 'github-token'],
  ['Google', 'AI' + 'za' + 'Sy' + 'x1'.repeat(16) + 'z', 'google-key'],
  ['npm', 'np' + 'm_' + 'a1'.repeat(18), 'npm-token'],
])('标题在 60 个字符处截断，%s 密钥在每个位置被截断都不露出前缀后 4 个以上字符', (_name, key, type) => {
  const prefixLen = key.indexOf('_') >= 0 && key.indexOf('_') < 6 ? key.indexOf('_') + 1 : 4;
  for (let shown = prefixLen + 4; shown < key.length; shown++) {
    const pad = 'x'.repeat(SESSION_TITLE_CHARS - 1 - shown);
    const prompt = `${pad} ${key} please use it`;
    const title = Array.from(prompt).slice(0, SESSION_TITLE_CHARS).join('');
    expect(isCutTitle(title)).toBe(true);
    const out = m().mask(title, { truncated: true });
    expect(out, `${type} cut after ${shown}`).toBe(`${pad} ${ph(type, 1)}`);
  }
});

test('cutMaskedText：按码点截断，不截在占位符中间', () => {
  const p = ph('github-token', 1);
  expect(cutMaskedText('abc', 60)).toBe('abc');
  expect(cutMaskedText('中文字', 2)).toBe('中文');
  expect(cutMaskedText(`ab ${p} cd`, 5)).toBe('ab ');
  expect(cutMaskedText(`ab ${p} cd`, 3 + [...p].length)).toBe(`ab ${p}`);
  expect(cutMaskedText('a😀b', 2)).toBe('a😀');
});

// ---- C2: maskWithSpans ----

test('maskWithSpans：遮蔽后的文字和每处替换的原始、遮蔽后位置', () => {
  const masker = createMasker({ categories: SECRET, numbered: false });
  const key = 'gh' + 'p_' + 'a1B2'.repeat(9);
  const text = `use ${key} and password="Hunter2Hunter2xx" ok`;
  const r = masker.maskWithSpans(text);
  expect(r.text).toBe(`use ${ph('github-token')} and password="${ph('assignment')}" ok`);
  expect(r.spans).toHaveLength(2);
  for (const s of r.spans) {
    expect(r.text.slice(s.maskedStart, s.maskedEnd)).toBe(ph(s.type));
    expect(text.slice(s.start, s.end)).toBe(s.type === 'github-token' ? key : 'Hunter2Hunter2xx');
  }
  // A structured value's key passes its meaning to a bare value.
  expect(masker.maskWithSpans('Hunter2Hunter2xx', { key: 'password' }).text).toBe(ph('assignment'));
  expect(masker.maskWithSpans('Hunter2Hunter2xx').text).toBe('Hunter2Hunter2xx');
  expect(masker.maskWithSpans('plain', { key: 'secrets', nested: true }).text).toBe(ph('assignment'));
});

// ---- I1: path-likeness, filter order, AWS secret keys, dotted tokens ----

test.each(['/etc/passwd', './a/b', '../x', '~/proj', 'C:\\Users\\x', 'D:/w/app', 'src/index.ts', 'packages/web/dist', 'a/b/c.json'])('是路径：%s', (v) => {
  expect(isPathLike(v)).toBe(true);
});
test.each(['wJalrXUtnFEMI/K7MDENG/bPxRfiCYzQ1w2e3r4', 'P@ss/word1', 'abc/def123X', 'AbcDef/Ghi+Jkl012', 'Zm9v/YmFy+cXV4'])('不是路径：%s', (v) => {
  expect(isPathLike(v)).toBe(false);
});

test.each<[string, string, string]>([
  ['引号里带 / 的密码', 'password: "P@ss/word1"', 'password: "@"'],
  ['不带引号带 / 的密码', 'password: P@ss/word1', 'password: @'],
  ['passwd 带 /', 'passwd=abc/def123X', 'passwd=@'],
  ['apiKey 带 / 和 +', '"apiKey":"AbcDef/Ghi+Jkl012"', '"apiKey":"@"'],
  ['AWS secret（env）', 'export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYz' + 'Q1w2e3r45', 'export AWS_SECRET_ACCESS_KEY=@'],
  ['AWS secret（ini）', 'aws_secret_access_key = wJalrXUtnFEMI+K7MDENG+bPxRfiCYz' + 'Q1w2e3r45', 'aws_secret_access_key = @'],
  ['AWS secret（JSON）', '{"secretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYz' + 'Q1w2e3r4"}', '{"secretAccessKey": "@"}'],
  ['Discord 风格的点分令牌', 'DISCORD_TOKEN=MTIzNDU2Nzg5' + 'MDEyMzQ1Njc4.GhIjKl.AbCdEfGhIjKlMnOpQrStUvWxYz0123', 'DISCORD_TOKEN=@'],
])('赋值形式，要遮：%s', (_name, text, expected) => {
  const out = m().mask(text);
  expect(out).not.toBe(text);
  expect(out).toBe(expected.replace('@', out.match(/‹已遮蔽·[^›]+›/)![0]));
});

test.each([
  ['路径值', 'PASSWORD_FILE=/run/secrets/db_password'],
  ['标识符链', 'api_key = config.api.key'],
  ['标识符链（环境变量）', 'token = process.env.GITHUB_TOKEN'],
])('赋值形式，不遮：%s', (_name, text) => {
  expect(m().mask(text)).toBe(text);
});

test('AWS secret key：键名下 40 个 base64 字符一律遮（1000 个随机样本）；同一行有 AKIA 时裸值也遮', () => {
  let state = 7;
  const rand = (): number => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 4294967296;
  };
  let missed = 0;
  for (let i = 0; i < 1000; i++) {
    const secret = Array.from({ length: 40 }, () => B64[Math.floor(rand() * 64)]).join('');
    for (const text of [`aws_secret_access_key=${secret}`, `{"SecretAccessKey":"${secret}"}`, `secretAccessKey: ${secret}`]) {
      if (m().mask(text).includes(secret)) missed++;
    }
  }
  expect(missed).toBe(0);
  const id = 'AK' + 'IA' + 'EXAMPLE0' + 'FAKE1234';
  const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYz' + 'Q1w2e3r45';
  expect(m(['credential']).mask(`${id} ${secret}`)).toBe(`${ph('aws-key', 1)} ${ph('aws-secret-key', 1)}`);
  expect(m(['credential']).mask(`id ${secret}`)).toBe(`id ${secret}`);
});

// ---- minors: new rules, templates, JWT validity ----

test.each<[string, string, string, MaskType]>([
  ['docker login -p', 'docker login -u bob -p ' + 'Dk9pass1word reg.example.com', 'docker login -u bob -p @ reg.example.com', 'cli-password'],
  ['docker login --password', 'docker login --password ' + 'Dk9pass1word', 'docker login --password @', 'cli-password'],
  ['sshpass -p', 'sshpass -p ' + 'Ssh9pass1 ssh host', 'sshpass -p @ ssh host', 'cli-password'],
  ['IDENTIFIED BY', "CREATE USER x IDENTIFIED BY '" + "Sq1pass_word';", "CREATE USER x IDENTIFIED BY '@';", 'sql-password'],
  ['WITH PASSWORD', "ALTER USER app WITH PASSWORD '" + "Sq1pass_word'", "ALTER USER app WITH PASSWORD '@'", 'sql-password'],
  ['PASSWORD', "CREATE ROLE r LOGIN PASSWORD '" + "Sq1pass_word'", "CREATE ROLE r LOGIN PASSWORD '@'", 'sql-password'],
])('新规则：%s', (_name, text, expected, type) => {
  expect(m(['credential']).mask(text)).toBe(expected.replace('@', ph(type, 1)));
});

test.each([
  ['Bearer 后是模板', 'Authorization: `Bearer ${token}`'],
  ['值是模板字符串', 'const header = { token: `prefix-${value}-suffix` }'],
  ['不是合法 JWT', 'eyJhbGciOiJub25lIn0' + '.invalid-but-looks.x'],
  ['IDENTIFIED BY 后是变量', "CREATE USER x IDENTIFIED BY '${PASS}'"],
  ['docker login 无密码', 'docker login reg.example.com'],
])('不遮：%s', (_name, text) => {
  expect(m().mask(text)).toBe(text);
});

// ---- I2: adopting learned values ----

test('adopt：把别处学到的值（类型 + 值）放进遮蔽器；learnedValues 列出已学的值', () => {
  const a = m();
  a.learn('DB_PASSWORD=Hunter2Hunter2xx and ' + 'gh' + 'p_' + 'a1B2'.repeat(9));
  const values = a.learnedValues();
  expect(values.map((v) => v.type).sort()).toEqual(['assignment', 'github-token']);
  const b = m();
  b.adopt(values);
  expect(b.learnedCount()).toBe(2);
  expect(b.mask('psql -W Hunter2Hunter2xx')).toBe(`psql -W ${ph('assignment', 1)}`);
  // Bad entries are ignored.
  b.adopt([{ type: 'nope' as MaskType, value: 'abcdefgh1234' }, { type: 'assignment', value: 'x' }, null as never]);
  expect(b.learnedCount()).toBe(2);
});

test('maskWarnings 在共享包里', () => {
  expect(maskWarnings({ total: 0, byType: {} })).toEqual([]);
  expect(maskWarnings({ total: 0, byType: {}, learnedCapped: true, learnedSkipped: 2, numberingCapped: true })).toHaveLength(3);
});
