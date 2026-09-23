// commandcode.test.mjs — CommandCode Go protocol/unit tests (no network).
//
// The live call is verified separately; these tests pin the parsing and
// catalog behaviour that would otherwise silently regress.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
function check(name, cond, hint = '') {
  if (cond) console.log(`  ok: ${name}`);
  else { console.error(`  FAIL: ${name}${hint ? ` — ${hint}` : ''}`); failures++; }
}

// Absolute paths must be file:// URLs for the ESM loader on Windows.
const mod = await import(pathToFileURL(path.join(ROOT, 'lib', 'commandcode.js')).href);
const adapterMod = await import(pathToFileURL(path.join(ROOT, 'lib', 'adapter.js')).href);

console.log('[commandcode]');
check('catalog is non-empty', mod.COMMANDCODE_MODELS.length > 0);
check('catalog ids are namespaced', mod.COMMANDCODE_MODELS.every((m) => m.id.includes('/')));
check('every model declares efforts', mod.COMMANDCODE_MODELS.every((m) => m.efforts.length > 0));
check('every defaultEffort is in its efforts list',
  mod.COMMANDCODE_MODELS.every((m) => m.efforts.includes(m.defaultEffort)));

check('findCommandCodeModel resolves an exact upstream id',
  mod.findCommandCodeModel('meta/muse-spark-1.3-contributor').id === 'meta/muse-spark-1.3-contributor');
check('findCommandCodeModel resolves a prefixed picker id',
  mod.findCommandCodeModel('cc/deepseek/deepseek-v4.1-flash').id === 'deepseek/deepseek-v4.1-flash');
check('findCommandCodeModel falls back for an unknown id',
  mod.findCommandCodeModel('nope/xyz') === mod.COMMANDCODE_MODELS[0]);

check('adapter exports the cc/ prefix', adapterMod.COMMANDCODE_PREFIX === 'cc/');
check('adapter recognizes a cc/ id', adapterMod.isCommandCodeModel('cc/x') === true);
check('adapter ignores a non-cc id', adapterMod.isCommandCodeModel('or/x') === false);
check('adapter strips the cc/ prefix', adapterMod.commandCodeUpstreamId('cc/a/b') === 'a/b');
check('adapter leaves an unprefixed id alone', adapterMod.commandCodeUpstreamId('a/b') === 'a/b');

// The endpoint must be the observed /alpha/generate path, not a guessed one.
check('generate url is /alpha/generate', mod.COMMANDCODE_GENERATE_URL.endsWith('/alpha/generate'));

if (failures > 0) { console.error(`commandcode FAILED (${failures})`); process.exit(1); }
console.log('commandcode OK.');
