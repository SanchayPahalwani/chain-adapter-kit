// Named places in the handlers where a fault-injection run kills the worker process.
export type CrashPoint =
  | 'after_reserve'
  | 'after_sign' // signed in memory, nothing stored
  | 'after_store'
  | 'before_broadcast'
  | 'after_broadcast' // sent, not recorded
  | 'after_broadcast_recorded'
  | 'before_settle'
  | 'after_settle'
  | 'after_replacement_store';

export type CrashHook = (point: CrashPoint, withdrawalId: string) => Promise<void>;

export const noCrash: CrashHook = () => Promise.resolve();
