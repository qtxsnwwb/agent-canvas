import fs from 'node:fs';
import type { Store } from '../../store/store.js';
import type { CodexLookup } from './source.js';

/**
 * The Codex source's view of what is already known: a file's session / agent / project from its stored raw events,
 * and the project ids in use — the derived sessions' and Claude Code's project directories (listed, not read), so a
 * Codex session in the same directory joins the Claude project even before that project's files were ingested.
 */
export function storeLookup(store: Store, claudeProjectsDir: string | null): CodexLookup {
  return {
    storedFile: (key) => store.transcriptFileOwner(key),
    knownProjectIds() {
      const ids = new Set(store.sessionProjectIds());
      if (claudeProjectsDir !== null) {
        try {
          for (const d of fs.readdirSync(claudeProjectsDir, { withFileTypes: true })) if (d.isDirectory()) ids.add(d.name);
        } catch {
          // no Claude Code directory
        }
      }
      return [...ids].sort();
    },
  };
}
