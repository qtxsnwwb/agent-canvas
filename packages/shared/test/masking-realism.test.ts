import { expect, test } from 'vitest';
import { createMasker, MASK_TYPE_LABELS, type MaskType } from '../src/index.js';

/*
 * Realism check (over-masking guard): about 200 KB of ordinary developer content — git log, package.json and a lock
 * excerpt, stack traces, ls -la, a .env.example with placeholders, i18n JSON using password / token / secret as labels,
 * CSS, a minified JS line, UUIDs, SHA hashes, base64 image data — plus a docker-compose file with fake but well-formed
 * secrets and a log line repeating one of them. Masked with the export's defaults (credential + assignment) in two
 * passes, the output must equal the input with exactly the expected spans replaced, byte for byte.
 */

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const r = rng(20261113);
const pick = (alphabet: string, n: number): string => Array.from({ length: n }, () => alphabet[Math.floor(r() * alphabet.length)]).join('');
const HEX = '0123456789abcdef';
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const uuid = (): string => `${pick(HEX, 8)}-${pick(HEX, 4)}-4${pick(HEX, 3)}-a${pick(HEX, 3)}-${pick(HEX, 12)}`;

// Fake secrets (well-formed, assembled at run time).
const S = {
  pg: 'Xk9#mP2v' + 'Q8zL',
  openai: 'sk-' + 'proj-' + 'R4t5Y6u7'.repeat(6),
  github: 'gh' + 'p_' + 'Z9y8X7w6'.repeat(4) + 'V5u4',
  jwtSecret: 'q7W' + 'e8R9t0Y1u2I3o4P5a6S7d8F9',
  awsSecret: 'wJalrXUtnFEMI/K7MDENG' + '/bPxRfiCYzQ1w2e3r45',
  i18nPassword: 'Password',
};

const parts: string[] = [];
const authors = ['Ada Lovelace <ada@example.com>', 'Grace Hopper <grace@example.org>', 'Linus T <linus@example.net>'];
const subjects = [
  'fix(ui): task-list item spacing',
  'feat: risk-assessment report export',
  'docs: explain the token refresh flow',
  'fix(auth): password reset email wording',
  'chore: bump scikit-learn to 1.5.2',
  'refactor: move secret manager client',
  'test: cover tokenizer edge cases',
];
for (let i = 0; i < 400; i++) {
  parts.push(
    `commit ${pick(HEX, 40)}\nAuthor: ${authors[i % 3]}\nDate:   Mon Nov ${(i % 28) + 1} 10:${String(i % 60).padStart(2, '0')}:00 2026 +0800\n\n    ${subjects[i % subjects.length]} (#${100 + i})\n`,
  );
}
parts.push(
  JSON.stringify(
    {
      name: '@acme/web',
      version: '2.3.4',
      scripts: { build: 'vite build', test: 'vitest run', lint: 'eslint . --max-warnings=0' },
      dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1', tokenizers: '^0.13.3' },
      config: { max_tokens: 4096, tokenizer: 'cl100k_base' },
    },
    null,
    2,
  ),
);
for (let i = 0; i < 60; i++) {
  parts.push(`"node_modules/pkg-${i}": {\n  "version": "1.${i}.0",\n  "resolved": "https://registry.npmjs.org/pkg-${i}/-/pkg-${i}-1.${i}.0.tgz",\n  "integrity": "sha512-${pick(B64, 86)}=="\n},`);
}
for (let i = 0; i < 80; i++) {
  parts.push(
    `TypeError: Cannot read properties of undefined (reading 'token')\n    at resolveSession (/home/runner/work/app/app/src/session.ts:${i + 10}:17)\n    at async handler (/home/runner/work/app/app/src/api/${uuid()}.ts:42:5)\n    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)`,
  );
}
for (let i = 0; i < 200; i++) {
  parts.push(`-rw-r--r--  1 runner staff  ${1000 + i * 37} Nov 13 10:${String(i % 60).padStart(2, '0')} file-${i}.ts`);
}
parts.push(
  [
    '# .env.example',
    'API_KEY=your-api-key-here',
    'SECRET_KEY=changeme',
    'GITHUB_TOKEN=xxxxxxxxxxxxxxxx',
    'DATABASE_URL=postgres://app:${DB_PASSWORD}@localhost:5432/app',
    'PASSWORD_FILE=/run/secrets/db_password',
    'PWD=/home/runner/work/app',
  ].join('\n'),
);
parts.push(
  JSON.stringify(
    {
      'login.password': S.i18nPassword,
      'login.forgot': 'Forgot password?',
      'token.expired': 'Your token has expired',
      'secret.label': 'Secret',
      'password.hint': 'At least 8 characters',
      'auth.required': 'required',
    },
    null,
    2,
  ),
);
for (let i = 0; i < 100; i++) parts.push(`.task-list__item--${i} { color: #${pick(HEX, 6)}; margin: ${i}px; }\n.risk-badge-${i} { border-color: #ff00aa; }`);
parts.push(`!function(e){var t="token",n=e.password=t;return e.secret=n,e}({});var u="${uuid()}";`);
for (let i = 0; i < 300; i++) parts.push(`${uuid()}  ${pick(HEX, 64)}  ${pick(HEX, 32)}`);
parts.push(`<img src="data:image/png;base64,${pick(B64, 40_000)}">`);
parts.push(
  [
    'services:',
    '  db:',
    '    environment:',
    `      POSTGRES_PASSWORD: "${S.pg}"`,
    '      POSTGRES_USER: app',
    '  api:',
    '    environment:',
    `      OPENAI_API_KEY: ${S.openai}`,
    `      GITHUB_TOKEN: ${S.github}`,
    `      JWT_SECRET: "${S.jwtSecret}"`,
    `      AWS_SECRET_ACCESS_KEY: ${S.awsSecret}`,
    '      MAX_TOKENS: 4096',
  ].join('\n'),
);
parts.push(`[db] connecting as app with ${S.pg} to postgres:5432`);
const FIXTURE = parts.join('\n');

test('真实感检查：只遮预期的地方，其余逐字节不变', () => {
  expect(FIXTURE.length).toBeGreaterThan(150_000);
  const masker = createMasker({ categories: ['credential', 'assignment'] });
  masker.learn(FIXTURE);
  const out = masker.mask(FIXTURE);
  // Expected replacements, by type in first-seen order (numbers follow that order).
  const ph = (type: MaskType, n: number): string => `‹已遮蔽·${MASK_TYPE_LABELS[type]}#${n}›`;
  // i18n labels quoted after password-class keys are masked where they stand (accepted cost: such a key's quoted value
  // is masked whatever its shape) but never learned, so the words stay readable everywhere else.
  const expected = FIXTURE.replace(`"login.password": "${S.i18nPassword}"`, `"login.password": "${ph('assignment', 1)}"`)
    .replace('"secret.label": "Secret"', `"secret.label": "${ph('assignment', 2)}"`)
    .split(S.pg)
    .join(ph('assignment', 3))
    .replace(S.openai, ph('openai-key', 1))
    .replace(S.github, ph('github-token', 1))
    .replace(S.jwtSecret, ph('assignment', 4))
    .replace(S.awsSecret, ph('aws-secret-key', 1));
  if (out !== expected) {
    // Show where they first differ.
    let i = 0;
    while (i < out.length && out[i] === expected[i]) i++;
    expect(out.slice(Math.max(0, i - 80), i + 120)).toBe(expected.slice(Math.max(0, i - 80), i + 120));
  }
  expect(out).toBe(expected);
  expect(masker.report().total).toBe(8);
});
