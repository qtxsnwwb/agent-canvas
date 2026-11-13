// Checks the package assembled in release/ (run after scripts/pack.mjs; `pnpm release` runs both): the packed CLI must
// be able to run `compact` — a migration and a VACUUM in its child process — on a temporary data directory.
// The release directory is copied to a temp directory whose node_modules points at the server's installed dependencies
// (what `npm install` of the package would provide). Nothing outside temp directories is touched.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = path.join(root, 'release');
const serverModules = path.join(root, 'packages/server/node_modules');
const fail = (message) => {
  console.error(`check-release: ${message}`);
  process.exit(1);
};
if (!fs.existsSync(path.join(release, 'dist/cli.js'))) fail('release/dist/cli.js is missing; run "pnpm release"');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-release-check-'));
try {
  const pkg = path.join(tmp, 'pkg');
  fs.cpSync(release, pkg, { recursive: true });
  fs.symlinkSync(serverModules, path.join(pkg, 'node_modules'), 'junction');

  // A database with free pages for VACUUM to give back.
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir);
  const Database = createRequire(path.join(serverModules, 'x.js'))('better-sqlite3');
  const db = new Database(path.join(dataDir, 'data.db'));
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE junk (x TEXT)');
  const ins = db.prepare('INSERT INTO junk (x) VALUES (?)');
  db.transaction(() => {
    for (let i = 0; i < 4000; i++) ins.run(`row ${i} `.repeat(200));
  })();
  db.exec('DELETE FROM junk');
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();

  const env = {
    ...process.env,
    AGENT_CANVAS_DATA_DIR: dataDir,
    AGENT_CANVAS_PROJECTS_DIR: path.join(tmp, 'projects'),
    AGENT_CANVAS_CODEX_DIR: '',
    AGENT_CANVAS_CURSOR_DB: '',
  };
  let out;
  try {
    out = execFileSync(process.execPath, [path.join(pkg, 'dist/cli.js'), 'compact', '--force'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    fail(`packed "compact --force" failed (exit ${err.status}): ${String(err.stdout ?? '')}${String(err.stderr ?? '')}`);
  }
  const m = /database file: ([\d.]+) MB -> ([\d.]+) MB/.exec(out);
  if (m === null) fail(`unexpected output of packed "compact": ${out}`);
  if (!(Number(m[2]) < Number(m[1]))) fail(`VACUUM did not shrink the file: ${m[0]}`);
  console.log(`check-release: packed CLI ran compact (VACUUM in its child process): ${m[1]} MB -> ${m[2]} MB`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10 });
}
