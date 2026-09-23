// Pool status without restarting DSH.
// Usage: pnpm run build && node scripts/pool-report.mjs
import { renderPoolReport } from '../lib/pool-hub.js';

console.log(await renderPoolReport());
