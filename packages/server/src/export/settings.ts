import fs from 'node:fs';
import path from 'node:path';
import { validateCustomTerms, type ExportSettings, type ExportSettingsResponse } from '@agent-canvas/shared';
import { removeSync } from '../fs-remove.js';

/** The export settings (custom masking terms) in the data directory. */
export const EXPORT_SETTINGS_FILE = 'export-settings.json';

/**
 * The stored settings: none when the file does not exist; also none, with `settingsError` saying why, when it cannot be
 * read or is not valid (spec 6: a damaged settings file counts as no custom terms). Never throws.
 */
export function loadExportSettings(dataDir: string): ExportSettingsResponse {
  const file = path.join(dataDir, EXPORT_SETTINGS_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { customTerms: [], settingsError: null };
    return { customTerms: [], settingsError: '读取导出设置失败，已按没有自定义词处理' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\ufeff/, ''));
  } catch {
    return { customTerms: [], settingsError: '导出设置文件已损坏（不是合法的 JSON），已按没有自定义词处理' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { customTerms: [], settingsError: '导出设置文件不合法（必须是一个对象），已按没有自定义词处理' };
  }
  // Unknown fields (another version) are ignored; the terms must be valid.
  const checked = validateCustomTerms((parsed as Record<string, unknown>).customTerms ?? []);
  if (!checked.ok) return { customTerms: [], settingsError: `导出设置文件不合法（${checked.error}），已按没有自定义词处理` };
  return { customTerms: checked.terms, settingsError: null };
}

/** Replaces the stored settings (already validated): written to a temporary file, then renamed over the old one. */
export function saveExportSettings(dataDir: string, settings: ExportSettings): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, EXPORT_SETTINGS_FILE);
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify({ customTerms: settings.customTerms }, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    removeSync(tmp);
    throw err;
  }
}
