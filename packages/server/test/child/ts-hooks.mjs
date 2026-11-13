// Module resolution hooks for running the server's TypeScript sources in a plain Node child process (tests only):
// `@agent-canvas/shared` -> packages/shared/src/index.ts; a relative `./x.js` that does not exist -> `./x.ts`.
// Node strips the types itself.
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SHARED = new URL('../../../shared/src/index.ts', import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === '@agent-canvas/shared') return { url: SHARED, shortCircuit: true };
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
    const js = new URL(specifier, context.parentURL);
    if (!fs.existsSync(fileURLToPath(js))) {
      const ts = pathToFileURL(fileURLToPath(js).replace(/\.js$/, '.ts')).href;
      return { url: ts, shortCircuit: true };
    }
  }
  return next(specifier, context);
}
