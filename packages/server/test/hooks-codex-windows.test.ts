import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  CODEX_HOOK_EVENTS,
  HookCommandError,
  codexForwardCommands,
  codexHookTarget,
  isPlainToken,
  planInstallFor,
  planUninstallFor,
  posixQuote,
  windowsQuote,
} from '../src/hooks-config.js';
import { windowsShortPath } from '../src/win-short-path.js';

/*
 * Codex runs a hook's commandWindows through PowerShell (`-NoProfile -Command <string>`), and through `cmd /C` only
 * when its local environment is not ready (.superpowers/sdd/codex-hooks-verify.md, F1). The only form both accept is
 * an unquoted line: plain words, a path with spaces replaced by its 8.3 short form (form A). Otherwise the PowerShell
 * call form `& "<node>" "<cli.js>" …` (form E). Earlier versions wrote `"<node>" "<cli.js>" …` (form D), which neither
 * shell runs.
 */

const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const NODE_SHORT = 'C:\\PROGRA~1\\nodejs\\node.exe';
const CLI = 'D:\\My Tools\\agent-canvas\\packages\\server\\dist\\cli.js';
const CLI_SHORT = 'D:\\MYTOOL~1\\agent-canvas\\packages\\server\\dist\\cli.js';
const SHORT: Record<string, string> = { [NODE]: NODE_SHORT, [CLI]: CLI_SHORT };
const shortPath = (p: string): string | null => SHORT[p] ?? null;
const TAIL = 'hook-forward --origin codex --port 4317';
const spec = (over: Partial<Parameters<typeof codexHookTarget>[0]> = {}) => ({
  nodePath: NODE, cliPath: CLI, port: 4317, platform: 'win32' as const, shortPath, ...over,
});
/** What versions before this fix wrote (form D). */
const formD = (node = NODE, cli = CLI, port = 4317) => ({
  type: 'command',
  command: `${posixQuote(node)} ${posixQuote(cli)} hook-forward --origin codex --port ${port}`,
  commandWindows: `${windowsQuote(node)} ${windowsQuote(cli)} hook-forward --origin codex --port ${port}`,
  async: true,
  timeout: 5,
});
const foreign = (name: string) => ({ type: 'command', command: name });

test('plain token: letters, digits and _ . : \\ / ~ - only', () => {
  expect(isPlainToken(NODE_SHORT)).toBe(true);
  expect(isPlainToken('D:/a-b/c_d.e~1/x.js')).toBe(true);
  for (const bad of [NODE, 'C:\\a&b', 'C:\\a$b', "C:\\it's", 'C:\\a(1)', 'C:\\ä', '', 'C:\\a;b', 'C:\\a"b', 'C:\\a`b']) expect(isPlainToken(bad), bad).toBe(false);
});

describe('commandWindows', () => {
  test('form A: paths with spaces become their short form, no quotes; the POSIX command is unchanged', () => {
    const c = codexForwardCommands(spec());
    expect(c.commandWindows).toBe(`${NODE_SHORT} ${CLI_SHORT} ${TAIL}`);
    expect(c.windowsForm).toBe('plain');
    expect(c.command).toBe(`'${NODE}' '${CLI}' ${TAIL}`);
  });

  test('form A: a plain long path is used as is, without asking for its short form', () => {
    const ask = vi.fn(shortPath);
    const c = codexForwardCommands(spec({ nodePath: 'C:\\nodejs\\node.exe', shortPath: ask }));
    expect(c.commandWindows).toBe(`C:\\nodejs\\node.exe ${CLI_SHORT} ${TAIL}`);
    expect(ask.mock.calls.map((a) => a[0])).toEqual([CLI]);
  });

  test.each([
    ['no short form', () => null],
    ['a short form that is not plain', (p: string) => p.replace('My Tools', 'MY TOO~1')],
  ])('form E when a path cannot be made plain (%s): the PowerShell call form, double-quoted', (_name, sp) => {
    const c = codexForwardCommands(spec({ shortPath: (p) => (p === CLI ? sp(p) : shortPath(p)) }));
    expect(c.commandWindows).toBe(`& "${NODE}" "${CLI}" ${TAIL}`);
    expect(c.windowsForm).toBe('call');
  });

  test('form E without a short-path function (another platform)', () => {
    const c = codexForwardCommands({ nodePath: NODE, cliPath: CLI, port: 4400, platform: 'linux' });
    expect(c.commandWindows).toBe(`& "${NODE}" "${CLI}" hook-forward --origin codex --port 4400`);
  });

  test.each(['D:\\a$b\\cli.js', 'D:\\a`b\\cli.js', 'D:\\a"b\\cli.js', 'D:\\a\u201cb\\cli.js'])(
    'Windows: a path PowerShell would expand in double quotes (%s) is refused with a clear message',
    (cli) => {
      expect(() => codexForwardCommands(spec({ cliPath: cli, shortPath: () => null }))).toThrow(HookCommandError);
      expect(() => codexForwardCommands(spec({ cliPath: cli, shortPath: () => null }))).toThrow(cli);
      // Uninstall still recognises entries for such a path; only writing a new command is refused.
      const t = codexHookTarget(spec({ cliPath: cli, shortPath: () => null }));
      expect(() => t.entry('Stop')).toThrow(HookCommandError);
      expect(t.isOurs({ type: 'command', command: `${posixQuote(NODE)} ${posixQuote(cli)} ${TAIL}` })).toBe(true);
    },
  );

  test('such a path is still form A when its short form is plain (no quoting needed)', () => {
    const cli = 'D:\\a$b\\cli.js';
    expect(codexForwardCommands(spec({ cliPath: cli, shortPath: (p) => (p === cli ? 'D:\\AB~1\\cli.js' : shortPath(p)) })).commandWindows).toBe(
      `${NODE_SHORT} D:\\AB~1\\cli.js ${TAIL}`,
    );
  });

  test('another platform never refuses (Codex does not run commandWindows there): such a path is escaped', () => {
    const c = codexForwardCommands({ nodePath: '/usr/bin/node', cliPath: '/opt/a$b/cli.js', port: 4317, platform: 'darwin' });
    expect(c.commandWindows).toBe(`& "/usr/bin/node" "/opt/a\`$b/cli.js" ${TAIL}`);
  });
});

describe('recognising our entries on Windows', () => {
  const t = codexHookTarget(spec());
  const current = (t.entry('Stop') as any).hooks[0];

  test('current form A: ours, up to date', () => {
    expect(current.commandWindows).toBe(`${NODE_SHORT} ${CLI_SHORT} ${TAIL}`);
    expect(t.isOurs(current)).toBe(true);
    expect(t.isOutdated?.(current)).toBe(false);
  });

  test('form D (earlier versions): ours, outdated', () => {
    expect(t.isOurs(formD())).toBe(true);
    expect(t.isOutdated?.(formD())).toBe(true);
    expect(t.isOurs({ type: 'command', commandWindows: formD().commandWindows })).toBe(true);
  });

  test('form E: ours; outdated while form A is possible', () => {
    const e = { ...current, commandWindows: `& "${NODE}" "${CLI}" ${TAIL}` };
    expect(t.isOurs(e)).toBe(true);
    expect(t.isOutdated?.(e)).toBe(true);
    // ...and up to date when form E is what install writes now.
    const te = codexHookTarget(spec({ shortPath: () => null }));
    expect(te.isOutdated?.((te.entry('Stop') as any).hooks[0])).toBe(false);
    expect(te.isOutdated?.(current)).toBe(true);
  });

  test('short or long, any case, either slash: the same cli.js; another port or path is not ours', () => {
    const lower = { ...current, command: undefined, commandWindows: `${NODE_SHORT.toLowerCase()} ${CLI_SHORT.toLowerCase().replace(/\\/g, '/')} ${TAIL}` };
    expect(t.isOurs(lower)).toBe(true);
    expect(t.isOutdated?.(lower)).toBe(false);
    expect(t.isOurs({ type: 'command', commandWindows: `"${NODE.toUpperCase()}" "${CLI.toLowerCase()}" ${TAIL}` })).toBe(true);
    expect(t.isOurs({ type: 'command', commandWindows: `${NODE_SHORT} ${CLI_SHORT} hook-forward --origin codex --port 4400` })).toBe(false);
    expect(t.isOurs({ type: 'command', commandWindows: `${NODE_SHORT} D:\\OTHER~1\\cli.js ${TAIL}` })).toBe(false);
    expect(t.isOurs(formD(NODE, CLI, 4400))).toBe(false);
  });

  test('a node binary that is neither the current one nor its short form: outdated', () => {
    expect(t.isOutdated?.({ ...current, commandWindows: `C:\\old\\node.exe ${CLI_SHORT} ${TAIL}` })).toBe(true);
  });

  test('ours without commandWindows on Windows: outdated (Codex would run the POSIX command there)', () => {
    expect(t.isOutdated?.({ type: 'command', command: current.command })).toBe(true);
  });

  test('on another platform the Windows form does not matter: an old form D entry is not rewritten', () => {
    const lt = codexHookTarget({ nodePath: '/usr/bin/node', cliPath: '/opt/ac/cli.js', port: 4317, platform: 'linux' });
    const old = formD('/usr/bin/node', '/opt/ac/cli.js');
    expect(lt.isOurs(old)).toBe(true);
    expect(lt.isOutdated?.(old)).toBe(false);
  });
});

/** A file as an earlier version left it, with other people's hooks before and after ours. */
function legacyFile(): any {
  const hooks: Record<string, unknown[]> = {};
  for (const e of CODEX_HOOK_EVENTS) {
    hooks[e] = [{ hooks: [{ ...formD(), timeout: e === 'SessionEnd' || e === 'Interrupt' ? 3 : 5 }] }];
  }
  hooks.Stop = [{ hooks: [foreign('before')] }, { hooks: [{ ...formD() }] }, { matcher: 'x', hooks: [foreign('after-1'), foreign('after-2')] }];
  hooks.PreToolUse = [{ matcher: 'Bash', hooks: [foreign('neighbour-before'), formD(), foreign('neighbour-after')] }, { hooks: [foreign('later')] }];
  return { hooks };
}

describe('in place (Codex keys trust by event, group index, handler index)', () => {
  const t = codexHookTarget(spec());
  const fresh = (e: string) => (t.entry(e) as any).hooks[0];

  test('install over form D: all 11 replaced at the same event, group and handler index; foreign hooks untouched', () => {
    const before = legacyFile();
    const p = planInstallFor(t, before);
    expect(p.replaced).toEqual([...CODEX_HOOK_EVENTS]);
    expect(p.added).toEqual([]);
    expect(p.shifted).toBeUndefined();
    const h = p.next.hooks as any;
    expect(h.Stop).toEqual([{ hooks: [foreign('before')] }, { hooks: [fresh('Stop')] }, before.hooks.Stop[2]]);
    expect(h.PreToolUse).toEqual([
      { matcher: 'Bash', hooks: [foreign('neighbour-before'), fresh('PreToolUse'), foreign('neighbour-after')] },
      { hooks: [foreign('later')] },
    ]);
    expect(h.SessionEnd).toEqual([{ hooks: [fresh('SessionEnd')] }]);
    expect(h.SessionEnd[0].hooks[0].timeout).toBe(3);
    expect(JSON.stringify(p.next)).not.toContain('\\"C:');
    // Second run: nothing to do.
    const again = planInstallFor(t, p.next);
    expect(again.replaced).toEqual([]);
    expect(again.alreadyPresent).toEqual([...CODEX_HOOK_EVENTS]);
  });

  test('two outdated entries of ours in one event: the first is replaced in place, the second removed', () => {
    const before = { hooks: { Stop: [{ hooks: [formD()] }, { hooks: [foreign('mid')] }, { hooks: [formD()] }, { hooks: [foreign('last')] }] } };
    const p = planInstallFor(t, before);
    expect((p.next.hooks as any).Stop).toEqual([{ hooks: [fresh('Stop')] }, { hooks: [foreign('mid')] }, { hooks: [foreign('last')] }]);
    expect(p.shifted).toEqual(['Stop']);
  });

  test('a fresh install still appends', () => {
    const p = planInstallFor(t, { hooks: { Stop: [{ hooks: [foreign('a')] }] } });
    expect((p.next.hooks as any).Stop).toEqual([{ hooks: [foreign('a')] }, { hooks: [fresh('Stop')] }]);
    expect(p.shifted).toBeUndefined();
  });

  test('uninstall removes ours (no empty group left) and names the events where a later foreign hook moved', () => {
    const installed = planInstallFor(t, legacyFile()).next;
    (installed.hooks as any).SessionStart.unshift({ hooks: [foreign('only-before')] });
    const u = planUninstallFor(t, installed);
    expect(u.removed).toEqual([...CODEX_HOOK_EVENTS]);
    const h = u.next.hooks as any;
    expect(h.Stop).toEqual([{ hooks: [foreign('before')] }, { matcher: 'x', hooks: [foreign('after-1'), foreign('after-2')] }]);
    expect(h.PreToolUse).toEqual([{ matcher: 'Bash', hooks: [foreign('neighbour-before'), foreign('neighbour-after')] }, { hooks: [foreign('later')] }]);
    expect(h.SessionStart).toEqual([{ hooks: [foreign('only-before')] }]);
    // Stop: the group after ours moved up; PreToolUse: neighbour-after moved within its group. SessionStart: nothing after ours.
    expect(u.shifted).toEqual(['PreToolUse', 'Stop']);
  });

  test('uninstall with nothing after ours: no shift reported', () => {
    expect(planUninstallFor(t, planInstallFor(t, { hooks: { Stop: [{ hooks: [foreign('a')] }] } }).next).shifted).toBeUndefined();
  });
});

describe('windowsShortPath', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-short-path-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** A file under a directory with a space, and a hard link to it under a plain name (same file, other name). */
  function files(): { long: string; link: string; other: string } {
    fs.mkdirSync(path.join(dir, 'with space'));
    fs.mkdirSync(path.join(dir, 'plain'));
    const long = path.join(dir, 'with space', 'cli.js');
    fs.writeFileSync(long, 'x');
    const link = path.join(dir, 'plain', 'cli.js');
    fs.linkSync(long, link);
    const other = path.join(dir, 'plain', 'other.js');
    fs.writeFileSync(other, 'x');
    return { long, link, other };
  }

  test('accepts a plain answer that names the same existing file', () => {
    const { long, link } = files();
    if (!isPlainToken(link)) return; // the temp dir itself is not plain here: nothing to assert
    expect(windowsShortPath(long, () => `${link}\r\n`)).toBe(link);
  });

  test('rejects an answer that is another file, missing, not plain, or the same text; a failing query', () => {
    const { long, other } = files();
    expect(windowsShortPath(long, () => other)).toBeNull();
    expect(windowsShortPath(long, () => path.join(dir, 'missing.js'))).toBeNull();
    expect(windowsShortPath(long, () => long)).toBeNull();
    expect(windowsShortPath(long, () => null)).toBeNull();
    expect(
      windowsShortPath(long, () => {
        throw new Error('boom');
      }),
    ).toBeNull();
  });

  test('never asks for a missing file, a directory, a relative path, or one with characters cmd would interpret', () => {
    const ask = vi.fn(() => 'C:\\x');
    expect(windowsShortPath(path.join(dir, 'nope.js'), ask)).toBeNull();
    expect(windowsShortPath(dir, ask)).toBeNull();
    expect(windowsShortPath('rel\\cli.js', ask)).toBeNull();
    const pct = path.join(dir, '100%x.js');
    fs.writeFileSync(pct, 'x');
    expect(windowsShortPath(pct, ask)).toBeNull();
    expect(ask).not.toHaveBeenCalled();
  });

  test.skipIf(process.platform !== 'win32')('Windows, for real: the node binary resolves to a plain name of the same file, or null', () => {
    const s = windowsShortPath(process.execPath);
    if (isPlainToken(process.execPath)) expect(s === null || s === process.execPath).toBe(true);
    else if (s !== null) {
      expect(isPlainToken(s)).toBe(true);
      expect(fs.statSync(s, { bigint: true }).ino).toBe(fs.statSync(process.execPath, { bigint: true }).ino);
    }
  });
});
