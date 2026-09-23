// run-all.mjs — repo gate: no-secrets + contracts (+ tsc/go when toolchains exist).
//
// Toolchains are optional: a missing go/tsc is reported as a SKIP, not a
// failure, so the credential and structure gates still run on a bare checkout.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
let skips = 0;

async function step(name, cmd, args, opts = {}) {
  try {
    const { stdout } = await run(cmd, args, { cwd: ROOT, timeout: 300_000, ...opts });
    console.log(`ok: ${name}`);
    if (stdout?.trim()) {
      console.log(stdout.trim().split('\n').slice(0, 8).map((l) => `    ${l}`).join('\n'));
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      skips++;
      console.log(`skip: ${name} (tool not installed)`);
      return;
    }
    failures++;
    console.error(
      `FAIL: ${name}\n${(err.stdout ?? '').toString().slice(0, 2000)}${(err.stderr ?? '').toString().slice(0, 2000)}`,
    );
  }
}

// Prefer the locally installed TypeScript so the gate works offline.
function localTsc() {
  const bin = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  return fs.existsSync(bin) ? { cmd: process.execPath, args: [bin] } : null;
}

await step('no-secrets', process.execPath, ['test/no-secrets.mjs', ROOT]);
await step('contracts', process.execPath, ['test/contracts.mjs']);

const tsc = localTsc();
if (tsc) {
  await step('tsc typecheck', tsc.cmd, [...tsc.args, '-p', 'tsconfig.json', '--noEmit']);
} else {
  skips++;
  console.log('skip: tsc typecheck (run `pnpm install` first)');
}

await step('go build ./...', 'go', ['build', './...'], { cwd: path.join(ROOT, 'gateway') });
await step('go vet ./...', 'go', ['vet', './...'], { cwd: path.join(ROOT, 'gateway') });

if (failures > 0) {
  console.error(`run-all FAILED (${failures} failure(s), ${skips} skipped)`);
  process.exit(1);
}
console.log(`run-all OK.${skips > 0 ? ` (${skips} skipped)` : ''}`);
