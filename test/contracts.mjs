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
const pkg = JSON.parse(read('package.json'));
check('package name is dsh-xuediner-gateway', pkg.name === 'dsh-xuediner-gateway');
check('client export resolves to lib/client.js', pkg.exports['./client'] === './lib/client.js');
check('build copies the client bundle', pkg.scripts.build.includes('copy-client.mjs'));
check('cordis patch inserts xuediner-gateway', read('cordis.patch.yml').includes('xuediner-gateway'));
check('client module id is dsh-xuediner-gateway', read('client/index.js').includes('id: "dsh-xuediner-gateway"'));
check('gateway go module renamed', read('gateway/go.mod').includes('xuediner-source/dsh-xuediner-gateway/gateway'));

const mustExist = ['src/index.ts', 'src/adapter.ts', 'src/pool-hub.ts', 'src/zcode.ts', 'src/qoder.ts', 'src/codex.ts', 'client/index.js', 'scripts/login-codearts.mjs', 'scripts/pool-report.mjs', 'gateway/cmd/server/main.go', 'gateway/config.example.json', 'README.md', 'LICENSE', '.gitignore', 'cordis.patch.yml'];
for (const f of mustExist) check(`exists ${f}`, fs.existsSync(path.join(ROOT, f)));

// Every //go:embed target must exist AND be tracked by git, or a fresh clone
// cannot compile (the gateway .gitignore has a broad *.md rule).
check('go:embed prompt asset exists', fs.existsSync(path.join(ROOT, 'gateway/internal/prompt/defaultprompt.md')));
check('gateway .gitignore un-ignores the embed asset', read('gateway/.gitignore').includes('!internal/prompt/defaultprompt.md'));
check('go:embed html/js assets exist', fs.existsSync(path.join(ROOT, 'gateway/internal/panel/index.html')) && fs.existsSync(path.join(ROOT, 'gateway/internal/panel/app.js')));

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

// ── Provider set lock ────────────────────────────────────────────────────────
// The README claims a specific set of upstreams. Assert that every module it
// names is really present AND actually imported by adapter.ts (so a doc claim
// can never drift from the code), and that retired upstreams stay retired.
const adapter = read('src/adapter.ts');
const UPSTREAM_MODULES = [
  'codex', 'commandcode', 'groq', 'intl-direct', 'llm7', 'nine-router', 'openrouter', 'qoder', 'zcode', 'zhipu',
];
for (const m of UPSTREAM_MODULES) {
  check(`upstream module src/${m}.ts exists`, fs.existsSync(path.join(ROOT, 'src', `${m}.ts`)));
  check(`src/${m}.ts is imported by adapter.ts`, adapter.includes(`'./${m}.js'`));
}
// CodeArts + the WorkBuddy gateway are implemented inside adapter.ts itself.
check('adapter.ts implements the CodeArts upstream', adapter.includes('CODEARTS_API_URL') && adapter.includes('signRequestHuawei'));
check('adapter.ts implements the WorkBuddy gateway upstream', adapter.includes('workbuddyGatewayStream'));
// Every routing prefix the README documents must exist.
for (const p of ['OPENROUTER_PREFIX', 'LLM7_PREFIX', 'GROQ_PREFIX', 'ZHIPU_PREFIX']) {
  check(`adapter.ts defines ${p}`, adapter.includes(`export const ${p} =`));
}
check('nine-router.ts defines 9r/ prefix', read('src/nine-router.ts').includes("NINE_ROUTER_PREFIX = '9r/'"));
check('zcode.ts defines zcode/ prefix', read('src/zcode.ts').includes("ZCODE_PREFIX = 'zcode/'"));
check('adapter.ts defines the cc/ prefix', adapter.includes("COMMANDCODE_PREFIX = 'cc/'"));
check('adapter.ts routes CommandCode in stream()', adapter.includes('this.commandCodeStream(options)'));
check('README documents CommandCode Go', read('README.md').includes('Command Code Go'));
// Retired upstream must not come back as a live module.
check('retired MiMo module is absent', !fs.existsSync(path.join(ROOT, 'src/mimo.ts')));
check('retired MiMo is not imported by adapter.ts', !adapter.includes("'./mimo.js'"));

if (failures > 0) { console.error(`contracts FAILED (${failures})`); process.exit(1); }
console.log('contracts OK.');
