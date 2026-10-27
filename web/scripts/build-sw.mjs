// Bundel src/sw.js (Workbox) menjadi public/sw.js. Dijalankan otomatis oleh `npm run build`.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
await build({
  entryPoints: [path.join(root, 'src/sw.js')],
  outfile: path.join(root, 'public/sw.js'),
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'none',
  logLevel: 'warning',
});
console.log('[sw] public/sw.js siap');
