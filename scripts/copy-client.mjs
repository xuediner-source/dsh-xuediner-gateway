// copy-client.mjs — place the Web client bundle where DSH resolves it.
//
// The client UI lives in client/index.js (plain JS, no build step of its own).
// DSH loads the client entry through the package "exports" map, which points at
// lib/client.js — the same layout the sibling DSH plugins use — so the build
// copies it there after tsc emits lib/*.js.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(ROOT, 'client', 'index.js');
const libDir = path.join(ROOT, 'lib');
const dst = path.join(libDir, 'client.js');

if (!fs.existsSync(src)) {
  console.error(`copy-client: missing ${src}`);
  process.exit(1);
}
fs.mkdirSync(libDir, { recursive: true });
fs.copyFileSync(src, dst);
console.log(`copy-client: ${path.relative(ROOT, src)} -> ${path.relative(ROOT, dst)}`);
