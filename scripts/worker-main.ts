// One worker process: the runtime from the environment (src/pipeline/runtime.ts), then the worker
// loop until SIGTERM or SIGINT. The fault run starts these, and with KIT_CRASH_AT they kill
// themselves at that crash point.
import { buildRuntime, readRuntimeEnv } from '../src/pipeline/runtime.js';
import { runWorker } from '../src/pipeline/worker.js';

const stop = new AbortController();
process.once('SIGTERM', () => stop.abort());
process.once('SIGINT', () => stop.abort());

const runtimeEnv = readRuntimeEnv(process.env);
const workerId = process.env.KIT_WORKER_ID || String(process.pid);
const deps = await buildRuntime(runtimeEnv);
const crash = runtimeEnv.crashAt ? `, crash at ${runtimeEnv.crashAt}` : '';
console.log(`worker ${workerId}: started${crash}`);
try {
  await runWorker(deps, workerId, stop.signal);
} finally {
  await deps.db.end({ timeout: 5 });
}
console.log(`worker ${workerId}: stopped`);
