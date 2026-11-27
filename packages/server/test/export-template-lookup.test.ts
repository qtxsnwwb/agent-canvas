import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { findViewerTemplate, VIEWER_TEMPLATE_FILE } from '../src/export/html.js';
import { removeTestPath } from './remove-test-path.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-export-lookup-')); });
afterEach(() => { removeTestPath(dir); });

const put = (...parts: string[]): string => {
  const file = path.join(dir, ...parts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x');
  return file;
};

test('仓库里：从 src/export 和 dist/export 都找到 packages/web/dist 里的模板', () => {
  const file = put('packages', 'web', 'dist', VIEWER_TEMPLATE_FILE);
  expect(findViewerTemplate(path.join(dir, 'packages', 'server', 'src', 'export'))).toBe(file);
  expect(findViewerTemplate(path.join(dir, 'packages', 'server', 'dist', 'export'))).toBe(file);
});

test('发布的包里：代码打包在 dist/ 下，模板在旁边的 web/ 里', () => {
  const file = put('pkg', 'web', VIEWER_TEMPLATE_FILE);
  expect(findViewerTemplate(path.join(dir, 'pkg', 'dist'))).toBe(file);
});

test('发布的包里：dist/ 外面的同名文件不算', () => {
  put('web', VIEWER_TEMPLATE_FILE); // next to the package directory, not inside it
  expect(findViewerTemplate(path.join(dir, 'pkg', 'dist'))).toBeNull();
});
