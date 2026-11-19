import { expect, test } from 'vitest';
import { createMasker, MASK_TYPE_LABELS } from '../src/index.js';

// Moved from masking.test.ts into the timing project (single fork, after the others, retried): under full-suite load
// the three phases of one case could exceed vitest's default 5 s test timeout although each phase stays far under its
// own 3 s bound. The per-phase bounds are unchanged (a quadratic rule takes minutes on 1 MB); the test timeout is
// only raised to the sum of those bounds plus slack, so the phase assertions decide.
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
  // final review
  ['docker login -p ', fill('docker login -p ')],
  ['sshpass -p', fill('sshpass -p')],
  ["IDENTIFIED BY '", fill("IDENTIFIED BY '")],
  ["PASSWORD '", fill(" PASSWORD '")],
  ['secretAccessKey=', fill('secretAccessKey=')],
  ['AKIA + b64', fill('AK' + 'IAEXAMPLE0FAKE1234 ' + 'Ab1/'.repeat(20) + '\n')],
  ['a/b/c (paths)', fill('password=a/b/')],
])('1 MB 的最坏输入：%s', { timeout: 15_000 }, (_name, text) => {
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

/** CI's shared runners are several times slower: the bounds grow by AGENT_CANVAS_TIMING_SCALE there (see vitest.config.ts). */
const TIMING_SCALE = Math.max(1, Number(process.env.AGENT_CANVAS_TIMING_SCALE) || 1);

// Moved from masking-round1.test.ts: a wall-clock bound belongs in the timing project (alone in one fork, after the
// others, retried). Among the ordinary tests it failed whenever the machine was busy. A quadratic match takes minutes.
test('自定义词：100 个 200 字符的词、1 MB 最坏输入，线性时间', () => {
  const terms = Array.from({ length: 100 }, (_, i) => 'a'.repeat(101 + i));
  const masker = createMasker({ categories: ['custom'], customTerms: terms });
  const text = 'a'.repeat(1024 * 1024);
  const t0 = performance.now();
  const out = masker.mask(text);
  const ms = performance.now() - t0;
  expect(out).toBe(`‹已遮蔽·${MASK_TYPE_LABELS.custom}#1›`);
  expect(ms).toBeLessThan(300 * TIMING_SCALE);
});
