import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { BACKEND_URL } from '../src/backend.js';

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
fs.writeFileSync(path.join(root, 'public/debug/config.js'), `window.CV_BACKEND = ${JSON.stringify(BACKEND_URL)};\n`);
console.log(`[prebuild] public/sw.js dan public/debug/config.js siap (backend ${BACKEND_URL})`);
