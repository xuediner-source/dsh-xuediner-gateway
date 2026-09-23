// run-all.mjs — repo gate: no-secrets + contracts (+ tsc/go when toolchains exist).
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
async function step(name, cmd, args, opts = {}) {
  try {
    const { stdout } = await run(cmd, args, { cwd: ROOT, timeout: 240_000, ...opts });
    console.log(`ok: ${name}`);
    if (stdout?.trim()) console.log(stdout.trim().split('\n').slice(0, 8).map((l) => `    ${l}`).join('\n'));
  } catch (err) {
    failures++;
    console.error(`FAIL: ${name}\n${(err.stdout ?? '').toString().slice(0, 2000)}${(err.stderr ?? '').toString().slice(0, 2000)}`);
  }
}
await step('no-secrets', process.execPath, ['test/no-secrets.mjs', ROOT]);
await step('contracts', process.execPath, ['test/contracts.mjs']);
await step('tsc typecheck', process.platform === 'win32' ? 'npx.cmd' : 'npx', ['-y', 'typescript@5.6', 'tsc', '-p', 'tsconfig.json', '--noEmit']);
await step('go build ./...', 'go', ['build', './...'], { cwd: path.join(ROOT, 'gateway') });
await step('go vet ./...', 'go', ['vet', './...'], { cwd: path.join(ROOT, 'gateway') });
if (failures > 0) { console.error(`run-all FAILED (${failures})`); process.exit(1); }
console.log('run-all OK.');
