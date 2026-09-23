// no-secrets.mjs — fail if the staging tree contains credential-looking files.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.argv[2] ?? '.');
const DENY_DIRS = new Set(['auths', 'data', 'backups', 'node_modules', '.git']);
const DENY_FILES = [
  /(^|\/)config\.json$/i,
  /\.key$/i, /\.pem$/i, /\.jwk$/i,
  /codearts.*\.json$/i,
  /workbuddy-.*\.json$/i,
  /credentials\.ya?ml$/i,
  /\.env($|\.)/i,
];
const ALLOW_FILES = new Set(['config.example.json']);

const hits = [];
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (name === '.git') continue;
    const full = path.join(dir, name);
    const rel = path.relative(ROOT, full).replace(/\\/g, '/');
    const base = path.basename(full);
    if (ALLOW_FILES.has(base)) continue;
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      if (DENY_DIRS.has(name)) {
        const inner = fs.readdirSync(full).filter((x) => !x.startsWith('.'));
        if (inner.length > 0 && name !== 'node_modules') hits.push(`${rel}/ (${inner.length} files — must not ship)`);
      }
      if (name !== 'node_modules') walk(full);
      continue;
    }
    if (DENY_FILES.some((re) => re.test(rel))) hits.push(rel);
  }
}
walk(ROOT);
if (hits.length > 0) {
  console.error(`no-secrets FAILED — ${hits.length} credential-looking path(s):`);
  for (const h of hits) console.error(`  - ${h}`);
  process.exit(1);
}
console.log('no-secrets OK — no credential-looking paths.');
