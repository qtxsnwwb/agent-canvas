import { expect, test } from 'vitest';
import {
  createMasker,
  isAssignmentKeyName,
  isMaskableAssignmentValue,
  MASK_FAILED_TEXT,
  MASK_TYPE_LABELS,
  type MaskCategory,
  type MaskType,
} from '../src/index.js';

// Every secret-looking value is obviously fake and assembled at run time (the repository is public).
const FAKE = {
  openai: 'sk-' + 'proj-' + 'A1b2'.repeat(12),
  openaiPlain: 'sk-' + 'a'.repeat(48),
  anthropic: 'sk-' + 'ant-' + 'api03-' + 'Z9y8'.repeat(20),
  github: 'gh' + 'p_' + 'a1B2'.repeat(9),
  githubPat: 'github' + '_pat_' + 'A1'.repeat(30),
  aws: 'AK' + 'IA' + 'EXAMPLE0' + 'FAKE1234',
  google: 'AI' + 'za' + 'Sy' + 'x1'.repeat(16) + 'z',
  slack: 'xo' + 'xb-' + '1234567890-abcdefghij',
  npm: 'np' + 'm_' + 'a1'.repeat(18),
  jwt: 'ey' + 'JhbGciOiJIUzI1NiJ9' + '.' + 'ey' + 'JzdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 'c2lnbmF0dXJlLWZha2U',
  bearerToken: 'tok' + 'A1b2C3d4E5',
  pem: '-----BEGIN ' + 'RSA PRIVATE KEY-----\nMIIfakefakefake\nAAAA\n-----END ' + 'RSA PRIVATE KEY-----',
  urlPassword: 'Hunter2' + 'Pass',
};

const ALL: MaskCategory[] = ['credential', 'assignment', 'personal', 'custom'];
const m = (categories: MaskCategory[] = ALL, extra: { customTerms?: string[]; homeUsers?: string[]; numbered?: boolean } = {}) =>
  createMasker({ categories, ...extra });
const ph = (type: MaskType, n?: number): string => `‹已遮蔽·${MASK_TYPE_LABELS[type]}${n === undefined ? '' : `#${n}`}›`;

test('每个类型都有中文名', () => {
  expect(MASK_TYPE_LABELS['openai-key']).toBe('OpenAI key');
  expect(MASK_TYPE_LABELS['anthropic-key']).toBe('Anthropic key');
  expect(MASK_TYPE_LABELS.bearer).toBe('Bearer 令牌');
  expect(MASK_TYPE_LABELS['private-key']).toBe('私钥');
  expect(MASK_TYPE_LABELS['url-password']).toBe('网址里的密码');
  expect(MASK_TYPE_LABELS.assignment).toBe('密钥/密码');
  expect(MASK_TYPE_LABELS.email).toBe('邮箱');
  expect(MASK_TYPE_LABELS['home-user']).toBe('用户名');
  expect(MASK_TYPE_LABELS.custom).toBe('自定义词');
  expect(MASK_TYPE_LABELS.failed).toBe('处理失败');
});

test.each<[string, string, MaskType]>([
  ['OpenAI key', FAKE.openai, 'openai-key'],
  ['OpenAI key（只有字母）', FAKE.openaiPlain, 'openai-key'],
  ['Anthropic key 不算 OpenAI', FAKE.anthropic, 'anthropic-key'],
  ['GitHub token', FAKE.github, 'github-token'],
  ['GitHub fine-grained token', FAKE.githubPat, 'github-token'],
  ['AWS key', FAKE.aws, 'aws-key'],
  ['Google API key', FAKE.google, 'google-key'],
  ['Slack token', FAKE.slack, 'slack-token'],
  ['npm token', FAKE.npm, 'npm-token'],
  ['JWT', FAKE.jwt, 'jwt'],
])('固定格式的凭据：%s', (_name, secret, type) => {
  const masker = m(['credential']);
  expect(masker.mask(`key is ${secret} here`)).toBe(`key is ${ph(type, 1)} here`);
  expect(masker.mask(`"${secret}"`)).toBe(`"${ph(type, 1)}"`);
  expect(masker.report().byType[type]).toEqual({ occurrences: 2, distinct: 1 });
});

test.each([
  ['sk- 太短', 'sk-' + 'abc123'],
  ['sk- 前面紧贴字母（task-…）', 'task-' + 'a'.repeat(40)],
  ['ghp_ 太短', 'gh' + 'p_' + 'abc123'],
  ['AKIA 后不足 16 位', 'AK' + 'IA' + 'ABC123'],
  ['AKIA 后超过 16 位', 'AK' + 'IA' + 'A'.repeat(20)],
  ['AIza 长度不对', 'AI' + 'za' + 'abc'],
  ['eyJ 没有三段', 'ey' + 'JhbGciOiJIUzI1NiJ9'],
  ['普通的 Bearer 说明', 'use a Bearer token'],
  ['Bearer 后是变量', 'Bearer ${TOKEN}'],
  ['不是私钥的 PEM 块', '-----BEGIN ' + 'CERTIFICATE-----\nMIIabc\n-----END CERTIFICATE-----'],
  ['网址没有密码', 'https://user@example.com/x'],
  ['网址里的密码是变量', 'https://user:${PASS}@example.com/x'],
  ['普通文字', 'hello world, skip this'],
])('固定格式的凭据，反例：%s', (_name, text) => {
  const masker = m(['credential']);
  expect(masker.mask(text)).toBe(text);
  expect(masker.report().total).toBe(0);
});

test('Bearer：只遮令牌部分', () => {
  expect(m(['credential']).mask(`Authorization: Bearer ${FAKE.bearerToken}`)).toBe(`Authorization: Bearer ${ph('bearer', 1)}`);
  expect(m(['credential']).mask(`authorization: bearer ${FAKE.bearerToken}`)).toBe(`authorization: bearer ${ph('bearer', 1)}`);
});

test('私钥：从 BEGIN 到对应的 END 整块；没有 END 就遮到文字末尾', () => {
  expect(m(['credential']).mask(`a\n${FAKE.pem}\nb`)).toBe(`a\n${ph('private-key', 1)}\nb`);
  const open = '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\nmore lines';
  expect(m(['credential']).mask(`x ${open}`)).toBe(`x ${ph('private-key', 1)}`);
});

test('网址里的密码：只遮密码部分', () => {
  const text = `postgres://admin:${FAKE.urlPassword}@db.example.com:5432/app`;
  expect(m(['credential']).mask(text)).toBe(`postgres://admin:${ph('url-password', 1)}@db.example.com:5432/app`);
  // With personal on, the password is not taken for an e-mail address.
  expect(m(ALL).mask(text)).toBe(`postgres://admin:${ph('url-password', 1)}@db.example.com:5432/app`);
});

test.each<[string, string, string]>([
  ['KEY=value', 'DB_PASSWORD=Abc12345xyz', 'DB_PASSWORD=@'],
  ['KEY = value', 'secret = Abc12345xyz;', 'secret = @;'],
  ['KEY: value', 'api_key: Abc12345xyz', 'api_key: @'],
  ['"key": "value"', '{"apiKey": "Abc 12345 xyz"}', '{"apiKey": "@"}'],
  ["'key': 'value'", "{'client_secret': 'Abc12345xyz'}", "{'client_secret': '@'}"],
  ['--key value', 'tool --token Abc12345xyz --verbose', 'tool --token @ --verbose'],
  ['--key=value', 'tool --api-key=Abc12345xyz', 'tool --api-key=@'],
  ['camelCase 段', 'accessToken=Abc12345xyz', 'accessToken=@'],
  ['auth 作为整段', 'AUTH=Abc12345xyz', 'AUTH=@'],
  ['值在 ) 处结束', 'f(password=Abc12345xyz)', 'f(password=@)'],
  ['值在 } 处结束', '{passwd=Abc12345xyz}', '{passwd=@}'],
  ['值在 , 处结束', 'passwd=Abc12345xyz,next', 'passwd=@,next'],
  ['转义引号的 JSON', '{\\"token\\": \\"Abc12345xyz\\"}', '{\\"token\\": \\"@\\"}'],
])('赋值形式：%s', (_name, text, expected) => {
  expect(m(['assignment']).mask(text)).toBe(expected.replace('@', ph('assignment', 1)));
});

test.each([
  ['短于 8 个字符', 'password=Ab12345'],
  ['$ 开头', 'password=$DB_PASSWORD_VALUE'],
  ['${ 开头', 'token: ${{ secrets.TOKEN }}'],
  ['% 开头', 'password=%DB_PASSWORD%1'],
  ['{{ 开头', 'token: {{ .Values.token1 }}'],
  ['< 开头', 'api_key=<your-api-key-1>'],
  ['process.env.X', 'token = process.env.GITHUB_TOKEN'],
  ['os.environ[…]', 'secret = os.environ["SECRET_1"]'],
  ['config.x', 'password: config.dbPassword1'],
  ['同一个字符', 'password=aaaaaaaaaaaa'],
  ['xxx…', 'token=xxxx-xxxx-xxxx'],
  ['***…', 'password: ************'],
  ['your-…', 'api_key=your-api-key-here1'],
  ['changeme', 'password=Changeme123'],
  ['example', 'token=example-token-123'],
  ['placeholder', 'secret=PLACEHOLDER_1234'],
  ['undefined', 'token = undefined'],
  ['普通单词', 'token = response;'],
  ['类型注解', 'secret: string'],
  ['不是赋值的比较', 'if token == Abc12345xyz'],
  ['箭头函数', 'token => Abc12345xyz'],
  ['名字里没有关键词', 'author=Abc12345xyz'],
  ['oauth 不是整段 auth', 'oauth=Abc12345xyz'],
  ['--key 后面是另一个参数', 'tool --token --verbose'],
])('赋值形式，不遮：%s', (_name, text) => {
  const masker = m(['assignment']);
  expect(masker.mask(text)).toBe(text);
  expect(masker.report().total).toBe(0);
});

test('赋值名字的规则', () => {
  for (const name of ['password', 'DB_PASSWD', 'db_pass', 'clientSecret', 'X-Auth-Token', 'apikey', 'API_KEY', 'api-key', 'AWS_ACCESS_KEY_ID', 'private_key', 'client_secret', 'auth', 'my.auth.value', 'APIKey']) {
    expect(isAssignmentKeyName(name), name).toBe(true);
  }
  for (const name of ['author', 'oauth', 'keyboard', 'api', 'key', 'access', 'name', '']) {
    expect(isAssignmentKeyName(name), name).toBe(false);
  }
});

test('赋值值的筛选（直接调用）', () => {
  expect(isMaskableAssignmentValue('Abc12345xyz')).toBe(true);
  expect(isMaskableAssignmentValue('abcdefgh1')).toBe(true);
  expect(isMaskableAssignmentValue('AbcdEfgh', { quoted: true })).toBe(true);
  expect(isMaskableAssignmentValue('AbcdEfgh')).toBe(false); // an unquoted identifier
  expect(isMaskableAssignmentValue('abcdefgh')).toBe(false);
  expect(isMaskableAssignmentValue('ABCDEFGH')).toBe(false);
  expect(isMaskableAssignmentValue('true')).toBe(false);
  expect(isMaskableAssignmentValue('None')).toBe(false);
});

test('凭据优先于赋值：同一个范围按凭据的类型', () => {
  const masker = m(['credential', 'assignment']);
  expect(masker.mask(`OPENAI_API_KEY=${FAKE.openai}`)).toBe(`OPENAI_API_KEY=${ph('openai-key', 1)}`);
  expect(masker.report().byType.assignment).toBeUndefined();
});

test('邮箱', () => {
  const masker = m(['personal']);
  expect(masker.mask('mail a.b+c@example.co.uk, or x@y.org.')).toBe(`mail ${ph('email', 1)}, or ${ph('email', 2)}.`);
  expect(m(['personal']).mask('pkg@1.2.3 and @scope/name and a@b')).toBe('pkg@1.2.3 and @scope/name and a@b');
});

test('主目录里的用户名换成 ~，不编号；只换路径里的', () => {
  const masker = m(['personal'], { homeUsers: ['alice'] });
  expect(masker.mask('C:\\Users\\alice\\proj and c:/users/ALICE/x and /Users/alice/y and /home/alice')).toBe(
    'C:\\Users\\~\\proj and c:/users/~/x and /Users/~/y and /home/~',
  );
  expect(masker.mask('alice said hi; /home/alicex/z; C:\\Users\\alice')).toBe('alice said hi; /home/alicex/z; C:\\Users\\~');
  expect(masker.mask('"C:\\\\Users\\\\alice\\\\x"')).toBe('"C:\\\\Users\\\\~\\\\x"');
  // POSIX paths are case-sensitive.
  expect(masker.mask('/home/Alice/x')).toBe('/home/Alice/x');
  expect(masker.report().byType['home-user']).toEqual({ occurrences: 6, distinct: 1 });
});

test('自定义词：不分 ASCII 大小写，原样匹配，长的优先，正则特殊字符无效', () => {
  const masker = m(['custom'], { customTerms: ['acme', 'Acme Corp', 'a.c*e(', 'ab'] });
  expect(masker.mask('ACME CORP and acme and a.c*e( and abc and aXce(')).toBe(
    `${ph('custom', 1)} and ${ph('custom', 2)} and ${ph('custom', 3)} and abc and aXce(`,
  );
});

test('自定义词：最多 100 个、每个至少 3 个字符、最多 200 个字符', () => {
  const terms = Array.from({ length: 150 }, (_, i) => `term${String(i).padStart(3, '0')}`);
  const masker = m(['custom'], { customTerms: terms });
  expect(masker.mask('term099 term100')).toBe(`${ph('custom', 1)} term100`);
  expect(m(['custom'], { customTerms: ['x'.repeat(201)] }).mask('x'.repeat(201))).toBe('x'.repeat(201));
});

test('同一个值同一个编号；编号按类型 + 值，按首次出现的顺序', () => {
  const masker = m(['credential']);
  const other = 'sk-' + 'B2c3'.repeat(12);
  expect(masker.mask(`${FAKE.openai} ${other} ${FAKE.openai} ${FAKE.github}`)).toBe(
    `${ph('openai-key', 1)} ${ph('openai-key', 2)} ${ph('openai-key', 1)} ${ph('github-token', 1)}`,
  );
  expect(masker.mask(other)).toBe(ph('openai-key', 2)); // numbering lasts for the masker's life
  expect(masker.report()).toEqual({
    total: 5,
    byType: { 'openai-key': { occurrences: 4, distinct: 2 }, 'github-token': { occurrences: 1, distinct: 1 } },
  });
});

test('numbered: false 时不编号', () => {
  expect(m(['credential'], { numbered: false }).mask(`${FAKE.openai} ${FAKE.github}`)).toBe(`${ph('openai-key')} ${ph('github-token')}`);
});

test('报告里没有值', () => {
  const masker = m(ALL, { customTerms: ['secretproject'], homeUsers: ['alice'] });
  masker.mask(`${FAKE.openai} password=Abc12345xyz secretproject a@b.com /home/alice/x`);
  const json = JSON.stringify(masker.report());
  for (const v of [FAKE.openai, 'Abc12345xyz', 'secretproject', 'a@b.com', 'alice']) expect(json).not.toContain(v);
});

test('重叠的命中：最先开始的、其次最长的；重叠的其余部分也遮住', () => {
  // custom term starts first and overlaps the beginning of the key: the rest of the key is still masked.
  const key = 'sk-' + 'C3d4'.repeat(12);
  const masker = m(['credential', 'custom'], { customTerms: [`id:${key.slice(0, 10)}`] });
  const out = masker.mask(`id:${key}`);
  expect(out).not.toContain(key.slice(10));
  expect(out.startsWith(ph('custom', 1))).toBe(true);
  expect(out).toBe(`${ph('custom', 1)}${ph('openai-key', 1)}`);
});

test('替换后的文字不再参与匹配；原文里的 ‹ › 原样保留', () => {
  const masker = m(ALL, { customTerms: ['已遮蔽', 'OpenAI'] });
  expect(masker.mask(FAKE.openai)).toBe(ph('openai-key', 1));
  expect(m(['credential']).mask('‹已遮蔽·假的#1› ‹ ›')).toBe('‹已遮蔽·假的#1› ‹ ›');
});

test('多字节字符旁边的命中', () => {
  expect(m(['credential']).mask(`密钥：${FAKE.openai}。😀`)).toBe(`密钥：${ph('openai-key', 1)}。😀`);
  expect(m(['custom'], { customTerms: ['项目代号'] }).mask('这是项目代号😀')).toBe(`这是${ph('custom', 1)}😀`);
});

test('只在请求的类别里遮', () => {
  const text = `${FAKE.openai} password=Abc12345xyz a@b.com`;
  expect(m([]).mask(text)).toBe(text);
  expect(m(['personal']).mask(text)).toBe(`${FAKE.openai} password=Abc12345xyz ${ph('email', 1)}`);
});

test('mask 收到非字符串时当作空字符串', () => {
  const masker = m();
  expect(masker.mask(undefined as unknown as string)).toBe('');
  expect(masker.mask(42 as unknown as string)).toBe('');
});

test('出错时整段替换为“处理失败”，计入报告，不抛出', () => {
  const masker = m(['credential']);
  const original = String.prototype.indexOf;
  String.prototype.indexOf = function () {
    throw new Error('boom');
  };
  let out: string;
  try {
    out = masker.mask(`x ${FAKE.openai}`);
  } finally {
    String.prototype.indexOf = original;
  }
  expect(out).toBe(MASK_FAILED_TEXT);
  expect(masker.report().byType.failed).toEqual({ occurrences: 1, distinct: 0 });
  expect(masker.report().total).toBe(1);
});

test('maskValue：逐个字符串值处理；键名命中而值是字符串时按赋值处理', () => {
  const masker = m(['credential', 'assignment']);
  const value = {
    command: `curl -H "Authorization: Bearer ${FAKE.bearerToken}"`,
    token: 'Abc 1234 5678',
    nested: [{ password: 'short' }, { apiKey: 'response' }, { secret: 12345678 }, `x ${FAKE.github}`],
    count: 3,
    ok: true,
    none: null,
  };
  expect(masker.maskValue(value)).toEqual({
    command: `curl -H "Authorization: Bearer ${ph('bearer', 1)}"`,
    token: ph('assignment', 1),
    nested: [{ password: ph('assignment', 2) }, { apiKey: 'response' }, { secret: ph('assignment', 3) }, `x ${ph('github-token', 1)}`],
    count: 3,
    ok: true,
    none: null,
  });
  // The original is not modified.
  expect(value.token).toBe('Abc 1234 5678');
});

test('maskValue：键名里的凭据也被遮蔽', () => {
  const out = m(['credential']).maskValue({ [FAKE.openai]: 1 }) as Record<string, unknown>;
  expect(Object.keys(out)).toEqual([ph('openai-key', 1)]);
});

test('maskValue：键名命中、值本身是凭据时按凭据的类型', () => {
  expect(m(['credential', 'assignment']).maskValue({ token: FAKE.github })).toEqual({ token: ph('github-token', 1) });
});

test('maskValue：过深的嵌套整体替换为“处理失败”', () => {
  let deep: unknown = 'x';
  for (let i = 0; i < 500; i++) deep = [deep];
  expect(JSON.stringify(m().maskValue(deep))).toContain(MASK_FAILED_TEXT);
});

test('不同值的个数有上限，超出后不再编号', () => {
  const masker = createMasker({ categories: ['custom'], customTerms: ['abc'] });
  expect(masker.report().numberingCapped).toBeUndefined();
});

// ---- cost: every rule on 1 MB of adversarial near-matches stays linear (time bound generous for slow machines) ----

const MB = 1024 * 1024;
const fill = (unit: string): string => unit.repeat(Math.ceil(MB / unit.length)).slice(0, MB);

test.each([
  ['sk-', fill('sk-')],
  ['sk-a', fill('sk-a')],
  ['ghp_', fill('gh' + 'p_')],
  ['github_pat_', fill('github' + '_pat_')],
  ['AKIA', fill('AK' + 'IA')],
  ['AIza', fill('AI' + 'za')],
  ['xoxb-', fill('xo' + 'xb-')],
  ['npm_', fill('np' + 'm_')],
  ['eyJ', fill('ey' + 'J')],
  ['eyJ.', fill('eyJabcdefghijk.')],
  ['Bearer ', fill('Bearer ')],
  ['-----BEGIN ', fill('-----BEGIN ')],
  ['-----BEGIN RSA PRIVATE KEY-----', fill('-----BEGIN ' + 'X PRIVATE KEY-----')],
  ['://', fill('://')],
  ['a://b:', fill('a://b:')],
  ['=', fill('=')],
  [':', fill(':')],
  ['token=', fill('token=')],
  ['token:"', fill('token:"')],
  ["token='a ", fill("token='a ")],
  ['--token ', fill('--token ')],
  ['a'.repeat(127) + '=', fill('a'.repeat(127) + '=')],
  ['@', fill('@')],
  ['a@', fill('a@')],
  ['a@b.', fill('a@b.')],
  ['a' + '@', fill('a'.repeat(70) + '@')],
  ['/home/', fill('/home/')],
  ['C:\\Users\\', fill('C:\\Users\\')],
  ['custom aaa', fill('a')],
  // fix round 1: starts after escapes and glued starts, new rules
  ['\\nsk-', fill('\\nsk-')],
  ['x_sk-proj-Ab1', fill('x_sk-proj-Ab1')],
  ['glpat-', fill('gl' + 'pat-')],
  ['hf_', fill('h' + 'f_')],
  ['hf_Ab', fill('h' + 'f_Ab')],
  ['sk_live_', fill('s' + 'k_live_')],
  ['AccountKey=', fill('AccountKey=')],
  ['Authorization: Basic ', fill('Authorization: Basic ')],
  ['-u a:', fill(' -u a:')],
  ['mysql -p', fill('mysql -p')],
  ['mysql ', fill('mysql ')],
  ['Cookie: a=', fill('Cookie: a=')],
  ['Cookie: a=b;', fill('Cookie: a=b;')],
  ['Set-Cookie: ', fill('Set-Cookie: ')],
  ['a://u:p@', fill('a://u:p@')],
  ['https://x@', fill('https://x@')],
  ['password="', fill('password="')],
  ['$a', fill('password=$a')],
  // fix round 2
  ['--user=x:', fill('--user=x:')],
  ['--user=ab:cd ', fill(' --user=ab:cdef ')],
  ['ya29.', fill('ya29.')],
  ['1//', fill('1//')],
  ['password (netrc)', fill('machine a login b password ')],
  ['password ', fill(' password ')],
  ['risk_test_', fill('ri' + 'sk_test_')],
  ['db_pass=', fill('db_pass=')],
  ['max_tokens=', fill('max_tokens=')],
  ['a a a (prose)', fill('password="a a a ')],
])('1 MB 的最坏输入：%s', (_name, text) => {
  const masker = createMasker({
    categories: ['credential', 'assignment', 'personal', 'custom'],
    customTerms: ['aaa', 'aaaa', 'aaaaa', 'sk-sk-', 'token', ...Array.from({ length: 95 }, (_, i) => `term${i}`)],
    homeUsers: ['alice', 'a'.repeat(50)],
  });
  // Learned mode: a first pass over the same text, then masking with the learned values; and truncated mode.
  const t0 = performance.now();
  masker.learn(text);
  const t1 = performance.now();
  const out = masker.mask(text);
  const t2 = performance.now();
  const cut = masker.mask(text, { truncated: true });
  const t3 = performance.now();
  if (process.env.AGENT_CANVAS_MASK_TIMES === '1') {
    console.log(`MASKTIME ${JSON.stringify(_name)} learn ${Math.round(t1 - t0)} mask ${Math.round(t2 - t1)} truncated ${Math.round(t3 - t2)}`);
  }
  expect(typeof out).toBe('string');
  expect(typeof cut).toBe('string');
  expect(t1 - t0).toBeLessThan(3000);
  expect(t2 - t1).toBeLessThan(3000);
  expect(t3 - t2).toBeLessThan(3000);
});
