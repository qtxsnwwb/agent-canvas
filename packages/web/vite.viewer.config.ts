import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { inlineViewerHtml, templateProblems } from './src/viewer/inline';

/**
 * The second build of the web package: the exported file's template, dist/viewer-template.html. It runs after the app's
 * build (`emptyOutDir: false` keeps the app's files) and writes only that one file: the plugin below inlines the
 * script and the stylesheet into the page (by hand; see src/viewer/inline.ts), drops every other output file and fails
 * the build when the result refers to anything outside itself.
 */
const TEMPLATE = 'viewer-template.html';

function singleFileTemplate(): Plugin {
  return {
    name: 'agent-canvas-viewer-template',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const scripts: Record<string, string> = {};
      const styles: Record<string, string> = {};
      let html: string | null = null;
      for (const [fileName, out] of Object.entries(bundle)) {
        if (out.type === 'chunk') {
          if (!out.isEntry || out.dynamicImports.length > 0 || out.imports.length > 0) {
            this.error(`viewer build: ${fileName} is not a single self-contained entry chunk`);
          }
          scripts[fileName] = out.code;
        } else if (fileName.endsWith('.css')) {
          styles[fileName] = String(out.source);
        } else if (fileName === 'viewer.html') {
          html = String(out.source);
        } else {
          this.error(`viewer build: unexpected output file ${fileName} (an asset that was not inlined)`);
        }
      }
      if (html === null) this.error('viewer build: viewer.html is missing from the output');
      const hash = (code: string): string => `sha256-${createHash('sha256').update(code, 'utf8').digest('base64')}`;
      const template = inlineViewerHtml(html, { scripts, styles }, hash);
      const problems = templateProblems(template);
      if (problems.length > 0) this.error(`viewer build: the template is not self-contained:\n  ${problems.join('\n  ')}`);
      for (const fileName of Object.keys(bundle)) delete bundle[fileName];
      this.emitFile({ type: 'asset', fileName: TEMPLATE, source: template });
    },
  };
}

export default defineConfig({
  plugins: [react(), singleFileTemplate()],
  resolve: {
    alias: {
      '@agent-canvas/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    copyPublicDir: false,
    // No preload helper (it would bring fetch / link preloading), every asset as a data: URL, one JS file.
    modulePreload: false,
    assetsInlineLimit: () => true,
    cssCodeSplit: false,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      input: fileURLToPath(new URL('./viewer.html', import.meta.url)),
      output: { inlineDynamicImports: true },
    },
  },
});
