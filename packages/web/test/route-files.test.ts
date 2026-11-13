import { expect, test } from 'vitest';
import { parseHash, sessionFileHash } from '../src/route';

test('#/files 是文件页', () => {
  expect(parseHash('#/files')).toEqual({ page: 'files' });
});

test('#/s/<id>/f/<path> 打开会话并带上文件', () => {
  expect(parseHash('#/s/abc/f/D%3A%2Fa%2Fb.ts')).toEqual({ page: 'session', sessionId: 'abc', filePath: 'D:/a/b.ts' });
  // the plain session route has no filePath key
  expect(parseHash('#/s/abc')).toStrictEqual({ page: 'session', sessionId: 'abc' });
});

test('sessionFileHash 与 parseHash 往返：#、%、空格、中文、反斜杠', () => {
  const paths = [
    'D:/proj/a#b.ts',
    '/home/u/100%/x.md',
    'C:/My Docs/read me.txt',
    'D:/项目/文件 一.ts',
    'D:\\win\\style\\path.ts',
    '/a/f/b/f/c.ts',
    'relative/x?y=1&z.ts',
  ];
  for (const p of paths) {
    const hash = sessionFileHash('s/1 #x', p);
    expect(hash.startsWith('#/s/')).toBe(true);
    expect(hash.slice(1).split('/').length).toBe(5); // '', 's', id, 'f', path: nothing unescaped inside
    expect(parseHash(hash)).toEqual({ page: 'session', sessionId: 's/1 #x', filePath: p });
  }
});

test('编码坏掉的路径退回普通会话页；空路径同样', () => {
  expect(parseHash('#/s/abc/f/%E4%ZZ')).toStrictEqual({ page: 'session', sessionId: 'abc' });
  expect(parseHash('#/s/abc/f/100%')).toStrictEqual({ page: 'session', sessionId: 'abc' });
  expect(parseHash('#/s/abc/f/')).toStrictEqual({ page: 'session', sessionId: 'abc' });
});

test('浏览器没编码的中文也能读', () => {
  expect(parseHash('#/s/abc/f/D:/项目/a.ts')).toEqual({ page: 'session', sessionId: 'abc', filePath: 'D:/项目/a.ts' });
});

test('会话 id 本身坏掉时回首页（和以前一样）', () => {
  expect(parseHash('#/s/%ZZ/f/a')).toEqual({ page: 'home', projectId: null });
});
