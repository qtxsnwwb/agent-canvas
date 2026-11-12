import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { ProjectFilesResponse, SessionFilesResponse } from '@agent-canvas/shared';
import { start, type Running } from '../src/cli-commands.js';
import { assistantBlock, userPrompt } from './fixtures.js';

/* start() wires the file service: its routes answer, after the warm-up (stats, then files) and during close. */

describe('start() and the file service', () => {
  let tmp: string | null = null;
  let app: Running | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
    if (tmp !== null) await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10 });
    tmp = null;
  });

  async function setup(): Promise<{ projectsDir: string; dataDir: string }> {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-files-warmup-'));
    const projectsDir = path.join(tmp, 'projects');
    await fs.mkdir(path.join(projectsDir, 'p1'), { recursive: true });
    const lines = [userPrompt('u1', null, 'hi'), assistantBlock('a1', 'u1', { type: 'text', text: 'ok' })].map((e) => (e.source === 'transcript' ? e.line : ''));
    await fs.writeFile(path.join(projectsDir, 'p1', 's1.jsonl'), `${lines.join('\n')}\n`);
    return { projectsDir, dataDir: path.join(tmp, 'data') };
  }

  test('with the warm-up: the routes answer once it has run', async () => {
    const dirs = await setup();
    app = await start({ ...dirs, codexSessionsDir: null, cursorDbPath: null, port: 0 }, { statsWarmup: true });
    await app.statsWarmup;
    const project = (await (await fetch(`${app.url}/api/files?projectId=p1`)).json()) as ProjectFilesResponse;
    expect(project).toMatchObject({ projectId: 'p1', files: [], totalFiles: 0, failedSessions: 0 });
    const sessions = (await (await fetch(`${app.url}/api/projects/p1/sessions`)).json()) as { id: string }[];
    const res = await fetch(`${app.url}/api/sessions/${sessions[0]!.id}/files`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as SessionFilesResponse).files).toEqual([]);
  });

  test('close() during the warm-up closes cleanly', async () => {
    const dirs = await setup();
    app = await start({ ...dirs, codexSessionsDir: null, cursorDbPath: null, port: 0 }, { statsWarmup: true });
    const warming = app.statsWarmup!;
    await app.close();
    app = null;
    await expect(warming).resolves.toBeUndefined();
  });
});
