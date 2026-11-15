// One worker process: the runtime from the environment (src/pipeline/runtime.ts), then the worker
// loop until SIGTERM or SIGINT, or until the parent that started it is gone. The fault run starts
// these, and with KIT_CRASH_AT they kill themselves at that crash point.
import { setting } from '../src/config.js';
import { buildRuntime, readRuntimeEnv } from '../src/pipeline/runtime.js';
import { runWorker } from '../src/pipeline/worker.js';

const stop = new AbortController();
process.once('SIGTERM', () => stop.abort());
process.once('SIGINT', () => stop.abort());
process.once('disconnect', () => stop.abort()); // the IPC channel closed: the supervisor died
// A channel that closed while this module was still loading fired its event before the listener.
if (process.send !== undefined && !process.connected) stop.abort();

const runtimeEnv = readRuntimeEnv(process.env);
const workerId = setting(process.env, 'KIT_WORKER_ID') ?? String(process.pid);
const deps = await buildRuntime(runtimeEnv);
const crash = runtimeEnv.crashAt ? `, crash at ${runtimeEnv.crashAt}` : '';
console.log(`worker ${workerId}: started${crash}`);
// tells a supervisor this worker is past start-up; the callback keeps a closed channel quiet
if (process.connected) process.send?.('started', undefined, undefined, () => undefined);
try {
  await runWorker(deps, workerId, stop.signal);
} finally {
  await deps.db.end({ timeout: 5 });
  if (process.connected) process.disconnect(); // an open channel would keep this process alive
}
console.log(`worker ${workerId}: stopped`);
