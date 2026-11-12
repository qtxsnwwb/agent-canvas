import { describe, expect, test } from 'vitest';
import { isWindowsStylePath, normalizeFilePath, pathKey, relativeToDir, samePath } from '../src/index.js';

describe('normalizeFilePath', () => {
  test('Windows absolute: separators, drive letter, dot segments, duplicate and trailing slashes', () => {
    expect(normalizeFilePath('D:\\a\\b.ts', null)).toBe('D:/a/b.ts');
    expect(normalizeFilePath('d:/a/b.ts', null)).toBe('D:/a/b.ts');
    expect(normalizeFilePath('D:/a/./x/../b.ts', null)).toBe('D:/a/b.ts');
    expect(normalizeFilePath('D:\\a\\\\b\\', null)).toBe('D:/a/b');
    expect(normalizeFilePath('d:\\', null)).toBe('D:/');
    expect(normalizeFilePath('D:/..', null)).toBe('D:/');
    expect(normalizeFilePath('D:/a/../../b', null)).toBe('D:/b');
  });

  test('absolute input ignores the cwd', () => {
    expect(normalizeFilePath('D:\\a\\b.ts', 'E:\\w')).toBe('D:/a/b.ts');
    expect(normalizeFilePath('/usr/x', '/home/u')).toBe('/usr/x');
  });

  test('POSIX absolute keeps case', () => {
    expect(normalizeFilePath('/Home/U/./a//b/../C.ts', null)).toBe('/Home/U/a/C.ts');
    expect(normalizeFilePath('/', null)).toBe('/');
    expect(normalizeFilePath('/a/', null)).toBe('/a');
    expect(normalizeFilePath('/../a', null)).toBe('/a');
  });

  test('UNC paths keep their leading double slash and never climb above the share', () => {
    expect(normalizeFilePath('\\\\server\\share\\a\\b.ts', null)).toBe('//server/share/a/b.ts');
    expect(normalizeFilePath('//server/share/a/../b.ts', null)).toBe('//server/share/b.ts');
    expect(normalizeFilePath('//server/share/../../x', null)).toBe('//server/share/x');
    expect(normalizeFilePath('//server/share/', null)).toBe('//server/share');
  });

  test('relative input is joined to the cwd', () => {
    expect(normalizeFilePath('src\\a.ts', 'D:\\proj')).toBe('D:/proj/src/a.ts');
    expect(normalizeFilePath('./src/../b.ts', 'd:/proj/')).toBe('D:/proj/b.ts');
    expect(normalizeFilePath('../x.ts', '/home/u/p')).toBe('/home/u/x.ts');
    expect(normalizeFilePath('a.ts', '//srv/share/p')).toBe('//srv/share/p/a.ts');
  });

  test('relative input without a usable cwd keeps its text, separators unified', () => {
    expect(normalizeFilePath('src\\a.ts', null)).toBe('src/a.ts');
    expect(normalizeFilePath('./a/../b.ts', null)).toBe('./a/../b.ts');
    expect(normalizeFilePath('src/a.ts', '')).toBe('src/a.ts');
    expect(normalizeFilePath('src/a.ts', 'relative/cwd')).toBe('src/a.ts');
  });

  test('empty, whitespace and non-string input give an empty string', () => {
    expect(normalizeFilePath('', null)).toBe('');
    expect(normalizeFilePath('   ', 'D:/p')).toBe('');
    expect(normalizeFilePath(undefined as unknown as string, null)).toBe('');
    expect(normalizeFilePath(42 as unknown as string, 'D:/p')).toBe('');
  });

  test('file:// URLs are returned as given', () => {
    expect(normalizeFilePath('file:///D:/a/b.ts', null)).toBe('file:///D:/a/b.ts');
    expect(normalizeFilePath('file:///home/a', '/x')).toBe('file:///home/a');
  });

  test('is idempotent', () => {
    for (const p of ['D:/a/b.ts', '/a/b', '//s/sh/a', 'src/a.ts', 'D:/']) {
      expect(normalizeFilePath(normalizeFilePath(p, null), null)).toBe(normalizeFilePath(p, null));
    }
  });
});

describe('relativeToDir', () => {
  test('inside the dir: the relative part', () => {
    expect(relativeToDir('D:/proj/src/a.ts', 'D:/proj')).toBe('src/a.ts');
    expect(relativeToDir('/home/u/p/a.ts', '/home/u/p/')).toBe('a.ts');
    expect(relativeToDir('//s/sh/p/a.ts', '//s/sh/p')).toBe('a.ts');
  });

  test('Windows-style paths compare case-insensitively and accept a raw dir', () => {
    expect(relativeToDir('D:/Proj/Src/a.ts', 'd:\\proj')).toBe('Src/a.ts');
    expect(relativeToDir('D:/proj/a.ts', 'D:/PROJ/')).toBe('a.ts');
  });

  test('POSIX paths compare case-sensitively', () => {
    expect(relativeToDir('/home/U/p/a.ts', '/home/u/p')).toBe('/home/U/p/a.ts');
  });

  test('outside the dir, a sibling with a shared prefix, the dir itself, no dir: the full path', () => {
    expect(relativeToDir('D:/other/a.ts', 'D:/proj')).toBe('D:/other/a.ts');
    expect(relativeToDir('D:/project2/a.ts', 'D:/proj')).toBe('D:/project2/a.ts');
    expect(relativeToDir('D:/proj', 'D:/proj')).toBe('D:/proj');
    expect(relativeToDir('D:/proj/a.ts', null)).toBe('D:/proj/a.ts');
    expect(relativeToDir('D:/proj/a.ts', '')).toBe('D:/proj/a.ts');
  });

  test('a root dir', () => {
    expect(relativeToDir('D:/a.ts', 'D:/')).toBe('a.ts');
    expect(relativeToDir('/a/b', '/')).toBe('a/b');
  });
});

describe('samePath', () => {
  test('Windows spellings of one file are the same', () => {
    expect(samePath('D:\\a\\b.ts', 'd:/a/b.ts')).toBe(true);
    expect(samePath('D:/a/./x/../b.ts', 'D:/A/B.TS')).toBe(true);
    expect(samePath('//S/Share/a', '\\\\s\\share\\A')).toBe(true);
  });

  test('POSIX is case-sensitive', () => {
    expect(samePath('/a/b', '/a/b/')).toBe(true);
    expect(samePath('/a/B', '/a/b')).toBe(false);
  });

  test('different files differ', () => {
    expect(samePath('D:/a/b.ts', 'D:/a/c.ts')).toBe(false);
    expect(samePath('', 'D:/a')).toBe(false);
  });
});

describe('fix round 1', () => {
  test('Win32 namespace prefixes normalise to the plain path', () => {
    expect(normalizeFilePath(String.raw`\\?\C:\foo\bar.ts`, null)).toBe('C:/foo/bar.ts');
    expect(normalizeFilePath('//?/c:/foo/bar.ts', null)).toBe('C:/foo/bar.ts');
    expect(normalizeFilePath(String.raw`\\.\C:\foo`, null)).toBe('C:/foo');
    expect(normalizeFilePath(String.raw`\\?\UNC\server\share\a.ts`, null)).toBe('//server/share/a.ts');
    expect(samePath(String.raw`\\?\C:\foo\bar.ts`, 'c:/foo/bar.ts')).toBe(true);
    expect(normalizeFilePath('a.ts', String.raw`\\?\D:\w`)).toBe('D:/w/a.ts');
  });

  test('a "." or ".." share is no share', () => {
    expect(normalizeFilePath(String.raw`\\server\..\x`, null)).toBe('//server/x');
    expect(normalizeFilePath('//server/./x', null)).toBe('//server/x');
  });

  test('surrounding whitespace is trimmed (path and cwd)', () => {
    expect(normalizeFilePath(' D:/a/b.ts ', 'D:/w')).toBe('D:/a/b.ts');
    expect(normalizeFilePath('\tsrc/a.ts\n', ' D:/w ')).toBe('D:/w/src/a.ts');
  });

  test('a path starting with ~ is not joined to the cwd', () => {
    expect(normalizeFilePath('~/x.ts', 'D:/w')).toBe('~/x.ts');
    expect(normalizeFilePath(String.raw`~\a\b.ts`, '/home/u')).toBe('~/a/b.ts');
    expect(normalizeFilePath('~', '/home/u')).toBe('~');
  });

  test('relativeToDir normalizes the path too; a relative dir matches nothing', () => {
    expect(relativeToDir(String.raw`d:\a\b.ts`, 'D:/a')).toBe('b.ts');
    expect(relativeToDir('src/a.ts', 'src')).toBe('src/a.ts');
  });

  test('isWindowsStylePath and pathKey', () => {
    expect(isWindowsStylePath('D:/a')).toBe(true);
    expect(isWindowsStylePath('//s/sh/a')).toBe(true);
    expect(isWindowsStylePath('/a')).toBe(false);
    expect(isWindowsStylePath('src/a')).toBe(false);
    expect(pathKey('D:/A/b.TS')).toBe('d:/a/b.ts');
    expect(pathKey('/A/b')).toBe('/A/b');
  });
});
