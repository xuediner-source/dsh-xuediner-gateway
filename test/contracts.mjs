// contracts.mjs — repo structure contracts (names, dirs, no hardcoded secrets).
import fs from 'node:fs';
import path from 'node:path';

import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
function check(name, cond, hint = '') {
  if (cond) console.log(`  ok: ${name}`);
  else { console.error(`  FAIL: ${name}${hint ? ` — ${hint}` : ''}`); failures++; }
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

console.log('[contracts]');
check('package name is dsh-xuediner-gateway', JSON.parse(read('package.json')).name === 'dsh-xuediner-gateway');
check('cordis patch inserts xuediner-gateway', read('cordis.patch.yml').includes('xuediner-gateway'));
check('client module id is dsh-xuediner-gateway', read('client/index.js').includes('id: "dsh-xuediner-gateway"'));
check('gateway go module renamed', read('gateway/go.mod').includes('xuediner-source/dsh-xuediner-gateway/gateway'));

const mustExist = ['src/index.ts', 'src/adapter.ts', 'src/pool-hub.ts', 'src/zcode.ts', 'src/qoder.ts', 'src/codex.ts', 'client/index.js', 'scripts/login-codearts.mjs', 'scripts/pool-report.mjs', 'gateway/cmd/server/main.go', 'gateway/config.example.json', 'README.md', 'LICENSE', '.gitignore', 'cordis.patch.yml'];
for (const f of mustExist) check(`exists ${f}`, fs.existsSync(path.join(ROOT, f)));

const srcFiles = fs.readdirSync(path.join(ROOT, 'src')).filter((f) => f.endsWith('.ts'));
let absLeak = [];
for (const f of srcFiles) {
  const text = fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
  const hits = [...text.matchAll(/(?:F:[\\/]DPH|C:[\\/]Users|workbuddy2api-panel\/(?:auths|data))/g)].map((m) => m[0]);
  if (hits.length > 0) absLeak.push(`${f}: ${[...new Set(hits)].join(', ')}`);
}
check('no absolute local paths in src/*.ts', absLeak.length === 0, absLeak.join(' | '));

const gwGo = [];
function walkGo(dir) {
  for (const n of fs.readdirSync(dir)) {
    const full = path.join(dir, n);
    const st = fs.statSync(full);
    if (st.isDirectory()) { walkGo(full); continue; }
    if (n.endsWith('.go')) {
      const t = fs.readFileSync(full, 'utf8');
      if (t.includes('linguo2625469/workbuddy2api-panel')) gwGo.push(path.relative(ROOT, full));
    }
  }
}
walkGo(path.join(ROOT, 'gateway', 'cmd'));
walkGo(path.join(ROOT, 'gateway', 'internal'));
check('no old go import path in gateway', gwGo.length === 0, gwGo.slice(0, 5).join(', '));

check('example api_key is placeholder test_key', JSON.parse(read('gateway/config.example.json')).api_key === 'test_key');

if (failures > 0) { console.error(`contracts FAILED (${failures})`); process.exit(1); }
console.log('contracts OK.');
