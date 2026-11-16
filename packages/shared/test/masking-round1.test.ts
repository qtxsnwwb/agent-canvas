import { expect, test } from 'vitest';
import {
  createMasker,
  isAssignmentKeyName,
  isMaskableAssignmentValue,
  MASK_TYPE_LABELS,
  type MaskCategory,
  type MaskType,
} from '../src/index.js';

// Fix round 1 of the masking review. Every secret-looking value is fake and assembled at run time.
const K = {
  openai: 'sk-' + 'proj-' + 'Q7w8'.repeat(12),
  anthropic: 'sk-' + 'ant-' + 'api03-' + 'Z9y8'.repeat(20),
  github: 'gh' + 'p_' + 'a1B2'.repeat(9),
  githubPat: 'github' + '_pat_' + 'A1'.repeat(30),
  gitlab: 'gl' + 'pat-' + 'Ab1'.repeat(7),
  hf: 'h' + 'f_' + 'AbCd'.repeat(9),
  stripe: 's' + 'k_' + 'live_' + 'Ab1'.repeat(10),
  aws: 'AK' + 'IA' + 'EXAMPLE0' + 'FAKE1234',
  google: 'AI' + 'za' + 'Sy' + 'x1'.repeat(16) + 'z',
  slack: 'xo' + 'xb-' + '1234567890-abcdefghij',
  npm: 'np' + 'm_' + 'a1'.repeat(18),
  jwt: 'ey' + 'JhbGciOiJIUzI1NiJ9' + '.' + 'ey' + 'JzdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 'c2lnbmF0dXJlLWZha2U',
};
const TYPES: [keyof typeof K, MaskType, number][] = [
  ['openai', 'openai-key', 3],
  ['anthropic', 'anthropic-key', 3],
  ['github', 'github-token', 4],
  ['githubPat', 'github-token', 11],
  ['gitlab', 'gitlab-token', 6],
  ['hf', 'huggingface-token', 3],
  ['stripe', 'stripe-key', 8],
  ['aws', 'aws-key', 4],
  ['google', 'google-key', 4],
  ['slack', 'slack-token', 5],
  ['npm', 'npm-token', 4],
  ['jwt', 'jwt', 3],
];
const ALL: MaskCategory[] = ['credential', 'assignment', 'personal', 'custom'];
const ph = (type: MaskType, n?: number): string => `‹已遮蔽·${MASK_TYPE_LABELS[type]}${n === undefined ? '' : `#${n}`}›`;
const m = (categories: MaskCategory[] = ALL, customTerms?: string[]) => createMasker({ categories, ...(customTerms ? { customTerms } : {}) });

// ---- C2: credentials wherever they start ----

const PREFIXES = ['\\n', '\\t', '\\r', '\\"', '\\u000a', '%0A', '_', '-', 'x', '9', '中', '=', ' ', 'mcp__'];

test.each(TYPES.flatMap(([k, type]) => PREFIXES.map((p): [string, string, MaskType] => [k, p, type])))('%s 前面是 %s 时也能认出', (k, prefix, type) => {
  const key = K[k as keyof typeof K];
  expect(m(['credential']).mask(`a${prefix}${key} b`)).toBe(`a${prefix}${ph(type, 1)} b`);
});

test.each(TYPES)('%s：在 JSON.stringify 的多行文字（摘要）和带转义的输入里', (k, type) => {
  const key = K[k];
  const summary = JSON.stringify({ content: `A=1\n${key}\nB=2`, file_path: '/x/.env' });
  const out = m(['credential']).mask(summary);
  expect(out).not.toContain(key);
  expect(out).toContain(ph(type, 1));
  // Inside a structured input whose string holds JSON-escaped text.
  const value = m(['credential']).maskValue({ command: `printf "x\\n${key}\\t"` }) as { command: string };
  expect(value.command).toBe(`printf "x\\n${ph(type, 1)}\\t"`);
});

test('工具名里的密钥', () => {
  // `_` is a key character: the key's run takes the rest of the name with it.
  expect(m(['credential']).mask(`mcp__${K.openai}__run`)).toBe(`mcp__${ph('openai-key', 1)}`);
});

test('Bearer 前面是转义也能认出', () => {
  expect(m(['credential']).mask(`x\\nBearer tok${'A1b2C3d4'}`)).toBe(`x\\nBearer ${ph('bearer', 1)}`);
});

test.each([
  ['task-…', 'task-' + 'abcdefghijklmnopqrstuvwxyz0123456789abcd'],
  ['risk-…', 'risk-assessment-for-the-production-database-migration'],
  ['desk-…', 'desk-' + 'Abcdefghijklmnopqrstuvwxyz'],
  ['单词里的 hf_', 'shelf_' + 'abcdefghijklmnopqrstuvwxyzabcdefgh'],
  ['单词里的 AKIA（没有数字）', 'XAKIA' + 'ABCDEFGHIJKLMNOP'],
])('紧贴在字母后面、看起来不随机的不算：%s', (_name, text) => {
  expect(m(['credential']).mask(text)).toBe(text);
});

// ---- new rules ----

test.each<[string, string, string, MaskType]>([
  ['Authorization: Basic', 'Authorization: Basic ' + 'dXNlcjpwYXNzd29yZDEy', 'Authorization: Basic @', 'authorization'],
  ['Authorization: Token', '"authorization": "Token ' + 'abcd1234efgh"', '"authorization": "Token @"', 'authorization'],
  ['GitLab', 'x ' + K.gitlab, 'x @', 'gitlab-token'],
  ['Hugging Face', 'x ' + K.hf, 'x @', 'huggingface-token'],
  ['Stripe live', 'x ' + K.stripe, 'x @', 'stripe-key'],
  ['Stripe restricted', 'x ' + 'r' + 'k_' + 'live_' + 'Ab1'.repeat(10), 'x @', 'stripe-key'],
  ['Stripe test', 'x ' + 's' + 'k_' + 'test_' + 'Ab1'.repeat(10), 'x @', 'stripe-key'],
  ['Azure', 'DefaultEndpointsProtocol=https;AccountName=a;AccountKey=' + 'Ab1+/x'.repeat(8) + '==;EndpointSuffix=x', 'DefaultEndpointsProtocol=https;AccountName=a;AccountKey=@;EndpointSuffix=x', 'azure-key'],
  ['curl -u', 'curl -u admin:' + 'Hunter2pw https://x', 'curl -u admin:@ https://x', 'cli-password'],
  ['curl --user', 'curl --user "admin:' + 'Hunter2pw" https://x', 'curl --user "admin:@" https://x', 'cli-password'],
  ['mysql -p', 'mysql -uroot -p' + 'S3cretpw mydb', 'mysql -uroot -p@ mydb', 'cli-password'],
  ['mysql --password=', 'mysqldump --password=' + 'S3cretpw db', 'mysqldump --password=@ db', 'cli-password'],
])('新规则：%s', (_name, text, expected, type) => {
  expect(m(['credential']).mask(text)).toBe(expected.replace('@', ph(type, 1)));
});

test('Cookie 和 Set-Cookie：遮值，留名字和属性', () => {
  expect(m(['credential']).mask('Cookie: sid=' + 'abc123; theme=dark')).toBe(`Cookie: sid=${ph('cookie', 1)}; theme=${ph('cookie', 2)}`);
  expect(m(['credential']).mask('Set-Cookie: sid=' + 'abc123; Path=/; HttpOnly; Max-Age=3600')).toBe(
    `Set-Cookie: sid=${ph('cookie', 1)}; Path=/; HttpOnly; Max-Age=3600`,
  );
  expect(m(['credential']).mask('-H "Cookie: a=' + 'b1c2d3"')).toBe(`-H "Cookie: a=${ph('cookie', 1)}"`);
});

test.each([
  ['git push -u', 'git push -u origin main'],
  ['sort -u', 'sort -u file.txt'],
  ['mkdir -p', 'mkdir -p dir && mysql db'],
  ['mysql -p 提示输入', 'mysql -u root -p db'],
  ['普通的 Authorization 说明', 'the Authorization header'],
  ['Basic 后面太短', 'Authorization: Basic ab'],
  ['不是 mysql 的 -p', 'cp -pr a b'],
  ['cookie 说明', 'set a cookie for the user'],
  ['glpat 太短', 'gl' + 'pat-abc'],
  ['sk_live 太短', 's' + 'k_' + 'live_abc'],
])('新规则，反例：%s', (_name, text) => {
  expect(m(['credential']).mask(text)).toBe(text);
});

// ---- I1: every value under a secret key ----

test('键名命中时：数字换成占位符，数组和嵌套对象里的字符串和数字都遮，布尔和 null 保留', () => {
  const out = m(['credential', 'assignment']).maskValue({
    password: 12345678,
    api_key: ['Abc123456789', 42],
    token: { value: 'Abc123456789', nested: { deep: 'plain' }, on: true, none: null },
    secret: false,
    max_tokens: 4096,
  });
  expect(out).toEqual({
    password: ph('assignment', 1),
    api_key: [ph('assignment', 2), ph('assignment', 3)],
    token: { value: ph('assignment', 2), nested: { deep: ph('assignment', 4) }, on: true, none: null },
    secret: false,
    max_tokens: 4096,
  });
});

// ---- I2: key names ----

test.each(['passWord', 'PassWord', 'userPASSWORD', 'db_password_hash', 'SECRETkey', 'clientSecret', 'X-Auth-Token', 'access_token', 'refreshToken', 'apiKey', 'API_KEY', 'aws_access_key_id', 'privateKey', 'passphrase', 'credentials', 'Authorization', 'Cookie', 'AccountKey', 'auth', 'db_pass', 'PASS'])(
  '是密钥的名字：%s',
  (name) => {
    expect(isAssignmentKeyName(name)).toBe(true);
  },
);

test.each(['tokens', 'max_tokens', 'input_tokens', 'output_tokens', 'token_count', 'tokenCount', 'tokenizer', 'tokenize', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'author', 'oauth', 'keyboard', 'name'])(
  '不是密钥的名字：%s',
  (name) => {
    expect(isAssignmentKeyName(name)).toBe(false);
  },
);

// ---- I3: learned values ----

test('学到的值在别处原样出现时也遮，类型和编号与第一次相同', () => {
  const masker = m(['credential', 'assignment']);
  const texts = ['first echo Hunter2Hunter2 here', 'export DB_PASSWORD=Hunter2Hunter2', `psql -W Hunter2Hunter2 and ${K.github}`, `log ${K.github}`];
  for (const t of texts) masker.learn(t);
  masker.learnValue({ token: 'Zz9Zz9Zz9Zz9', count: 3 });
  expect(masker.learnedCount()).toBe(3);
  expect(masker.mask(texts[0]!)).toBe(`first echo ${ph('assignment', 1)} here`);
  expect(masker.mask(texts[1]!)).toBe(`export DB_PASSWORD=${ph('assignment', 1)}`);
  expect(masker.mask(texts[2]!)).toBe(`psql -W ${ph('assignment', 1)} and ${ph('github-token', 1)}`);
  expect(masker.mask('the value Zz9Zz9Zz9Zz9 again')).toBe(`the value ${ph('assignment', 2)} again`);
  // learn() does not change the report or the numbering.
  expect(masker.report().byType['assignment']).toEqual({ occurrences: 4, distinct: 2 });
});

test('不学短于 8 个字符的值', () => {
  const masker = m(['assignment']);
  masker.learn('password="abc1"');
  expect(masker.learnedCount()).toBe(0);
});

// ---- I4: truncated text ----

test.each(TYPES)('截断的文字：%s 在前缀后的每个位置被截断都遮住', (k, type) => {
  const key = K[k];
  const prefix = TYPES.find((t) => t[0] === k)![2];
  for (let n = prefix + 1; n <= key.length; n++) {
    const text = `cmd "x: ${key.slice(0, n)}…`;
    const masker = m(['credential']);
    const out = masker.mask(text, { truncated: true });
    // Fewer than 4 key characters after the prefix reveal nothing useful and stay; from 4 on the tail is masked.
    if (n < prefix + 4) expect(out, `${k} cut at ${n}`).toBe(text);
    else expect(out, `${k} cut at ${n}`).toMatch(/^cmd "x: ‹已遮蔽·[^›]+›…$/);
    // Nothing accepted only because of the cut is learned.
    if (n < prefix + 9) {
      masker.learn(text, { truncated: true });
      expect(masker.learnedCount(), `${k} learned at ${n}`).toBe(0);
    }
  }
  void type;
});

test('截断的文字：值一直到末尾的赋值不管筛选都遮；不截断时照常筛选', () => {
  expect(m(['assignment']).mask('{"command":"x","password":"Ab…', { truncated: true })).toBe(`{"command":"x","password":"${ph('assignment', 1)}`);
  expect(m(['assignment']).mask('export TOKEN=ab…', { truncated: true })).toBe('export TOKEN=ab…'); // not a password-class key
  expect(m(['assignment']).mask('export TOKEN=ab')).toBe('export TOKEN=ab');
  expect(m(['credential']).mask('psql postgres://u:Hun…', { truncated: true })).toBe(`psql postgres://u:${ph('url-password', 1)}`);
  expect(m(['credential']).mask('see https://example.com:8080…', { truncated: true })).toBe('see https://example.com:8080…');
});

// ---- I6: URL credentials ----

test.each<[string, string, string]>([
  ['密码里有 @', 'postgres://u:' + 'p4ss@w0rd' + '@host/db', 'postgres://u:@@host/db'],
  ['密码里有 #', 'postgres://u:' + 'p4ss#w0rd' + '@host/db', 'postgres://u:@@host/db'],
  ['密码里有 :', 'redis://u:' + 'a:b:c1' + '@host', 'redis://u:@@host'],
  ['百分号转义', 'https://u:' + 'p%40ss%2Fw0rd' + '@host', 'https://u:@@host'],
  ['只有令牌没有冒号', 'https://' + 'ghx' + 'Ab12Cd34Ef56' + '@github.com/o/r', 'https://@@github.com/o/r'],
])('网址里的凭据：%s', (_name, text, expected) => {
  expect(m(['credential']).mask(text)).toBe(expected.replace('@@', `${ph('url-password', 1)}@`));
});

test('网址：普通用户名不遮', () => {
  expect(m(['credential']).mask('ssh://git@github.com/o/r and https://johnsmith@host')).toBe('ssh://git@github.com/o/r and https://johnsmith@host');
});

// ---- I7: the assignment filter ----

test.each([
  ['引号里的全大写密码', 'PASSWORD="LETMEINNOW"', 'PASSWORD="@"'],
  ['引号里带符号的密码', '"password": "pass!word#here"', '"password": "@"'],
  ['bcrypt 哈希', 'password_hash: "$2b$12$' + 'abcdefghijklmnopqrstuv"', 'password_hash: "@"'],
  ['不带引号的 bcrypt 哈希', 'password_hash=$2b$12$' + 'abcdefghijklmnopqrstuv', 'password_hash=@'],
  ['argon2 哈希', 'secret: "$argon2id$v=19$' + 'm=65536$abc"', 'secret: "@"'],
  ['结构化数据里的密码', JSON.stringify({ password: 'correcthorse' }), '{"password":"@"}'],
])('要遮：%s', (_name, text, expected) => {
  expect(m(['assignment']).mask(text)).toBe(expected.replace('@', ph('assignment', 1)));
});

test.each([
  ['函数调用', 'const token = getToken();'],
  ['函数调用（参数）', 'password: hashPassword(pw)'],
  ['类型名', 'token: TokenType; secret: SecretManager'],
  ['tokenizer', 'tokenizer: cl100k_base'],
  ['颜色', '--auth-token-color: #ff00aa12'],
  ['日期', "password_reset_at = '2026-01-01'"],
  ['变量引用', 'password="$DB_PASSWORD"'],
  ['模板', 'password: "${{ secrets.DB }}"'],
  ['占位符', 'password = "changeme"'],
  ['空', 'password=""'],
])('不遮：%s', (_name, text) => {
  expect(m(['assignment']).mask(text)).toBe(text);
});

test('值的筛选：引号 + 密码类键名', () => {
  expect(isMaskableAssignmentValue('letmein', { quoted: true, passwordKey: true })).toBe(true);
  expect(isMaskableAssignmentValue('letmein', { quoted: true })).toBe(false);
  expect(isMaskableAssignmentValue('$HOME_DIR', { quoted: true, passwordKey: true })).toBe(false);
});

// ---- custom terms, __proto__ ----

test('自定义词：重叠的命中合并，不留下半个词', () => {
  expect(m(['custom'], ['abc', 'bcd']).mask('xabcdx')).toBe(`x${ph('custom', 1)}x`);
});

test('自定义词：100 个 200 字符的词、1 MB 最坏输入，线性时间', () => {
  const terms = Array.from({ length: 100 }, (_, i) => 'a'.repeat(101 + i));
  const masker = m(['custom'], terms);
  const text = 'a'.repeat(1024 * 1024);
  const t0 = performance.now();
  const out = masker.mask(text);
  const ms = performance.now() - t0;
  expect(out).toBe(ph('custom', 1));
  expect(ms).toBeLessThan(300);
});

test('maskValue：__proto__ 和 constructor 作为普通键保留', () => {
  const input = JSON.parse('{"__proto__": {"x": 1}, "constructor": "c", "a": 2}') as Record<string, unknown>;
  const out = m().maskValue(input) as Record<string, unknown>;
  expect(Object.keys(out)).toEqual(['__proto__', 'constructor', 'a']);
  expect(JSON.stringify(out)).toBe('{"__proto__":{"x":1},"constructor":"c","a":2}');
  expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
});
