// Refresh the vendored Three.js build from node_modules.
//
// The game ships `vendor/three.module.js` and resolves it through the import
// map in index.html, so it runs with no build step and no network. Run this
// after bumping the `three` devDependency.

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'node_modules/three/build/three.module.js');
const dest = resolve(root, 'vendor/three.module.js');

if (!existsSync(src)) {
  console.error('three is not installed — run `npm install` first.');
  process.exit(1);
}

mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
console.log(`vendored ${src} -> ${dest}`);
