// Assembles the publishable npm package in release/ from the built workspace (run `pnpm build` first, or `pnpm release`).
//
// The workspace packages stay private. The published package is one directory:
//   release/package.json   generated here (name, version, real dependencies)
//   release/dist/cli.js    the server bundled with the shared model code (third-party dependencies stay external)
//   release/web/           the built web app
//   release/README.md, release/LICENSE
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'release');
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

const rootPkg = read('package.json');
const serverPkg = read('packages/server/package.json');
const entry = path.join(root, 'packages/server/dist/cli.js');
const webDist = path.join(root, 'packages/web/dist');
for (const [what, p] of [['server build', entry], ['web build', path.join(webDist, 'index.html')]]) {
  if (!fs.existsSync(p)) {
    console.error(`pack: missing ${what} (${path.relative(root, p)}); run "pnpm build" first`);
    process.exit(1);
  }
}

// Everything the server depends on stays a normal dependency, except the workspace's own packages, which are bundled.
const dependencies = Object.fromEntries(Object.entries(serverPkg.dependencies).filter(([name, range]) => !String(range).startsWith('workspace:')));

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// Code splitting keeps cli.js small: `hook-forward` runs once per hook event and must not load the server.
await build({
  entryPoints: [entry],
  outdir: path.join(out, 'dist'),
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external: Object.keys(dependencies),
  chunkNames: 'chunk-[hash]',
  logLevel: 'warning',
});

fs.cpSync(webDist, path.join(out, 'web'), { recursive: true });
fs.copyFileSync(path.join(root, 'README.md'), path.join(out, 'README.md'));
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(out, 'LICENSE'));

const pkg = {
  name: '@qtxsnwwb/agent-canvas',
  version: rootPkg.version,
  description: 'See what your coding agents are doing: Claude Code, Codex and Cursor sessions drawn as a live canvas. Runs locally; your data stays on your machine.',
  license: 'MIT',
  type: 'module',
  bin: { 'agent-canvas': 'dist/cli.js' },
  files: ['dist', 'web', 'README.md', 'LICENSE'],
  engines: rootPkg.engines,
  dependencies,
  repository: { type: 'git', url: 'git+https://github.com/qtxsnwwb/agent-canvas.git' },
  homepage: 'https://github.com/qtxsnwwb/agent-canvas#readme',
  bugs: { url: 'https://github.com/qtxsnwwb/agent-canvas/issues' },
  keywords: ['claude-code', 'codex', 'cursor', 'ai-agents', 'coding-agent', 'visualization', 'observability', 'developer-tools'],
  publishConfig: { access: 'public' },
};
fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else files.push([path.relative(out, p).split(path.sep).join('/'), fs.statSync(p).size]);
  }
})(out);
const total = files.reduce((n, [, size]) => n + size, 0);
console.log(`pack: ${pkg.name}@${pkg.version} -> release/ (${files.length} files, ${(total / 1e6).toFixed(1)} MB)`);
