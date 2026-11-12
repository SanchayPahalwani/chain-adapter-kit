import type { Db } from './db.js';

// Named places in the handlers where a fault-injection run kills the worker process.
export const crashPoints = [
  'after_reserve',
  'after_sign', // signed in memory, nothing stored
  'after_store',
  'before_broadcast',
  'after_broadcast', // sent, not recorded
  'after_broadcast_recorded',
  'before_settle',
  'after_settle',
  'after_replacement_store',
] as const;
export type CrashPoint = (typeof crashPoints)[number];

export const isCrashPoint = (s: string): s is CrashPoint =>
  (crashPoints as readonly string[]).includes(s);

export type CrashHook = (point: CrashPoint, withdrawalId: string) => Promise<void>;

export const noCrash: CrashHook = () => Promise.resolve();

/**
 * Kills this process with SIGKILL the first time each withdrawal reaches `point`: no cleanup
 * runs, and the server rolls back whatever the process had open. It records a 'crash_injected'
 * event first, in its own autocommit statement, so a restarted worker does not kill itself at
 * the same point for the same withdrawal. One worker per withdrawal at a time: two reaching the
 * same point at once could both insert the event.
 */
export function killOnce(db: Db, point: CrashPoint): CrashHook {
  return async (at, withdrawalId) => {
    if (at !== point) return;
    const rows = await db`
      insert into withdrawal_events (withdrawal_id, kind, data)
      select ${withdrawalId}::uuid, 'crash_injected', ${db.json({ point })}::jsonb
       where not exists (
         select 1 from withdrawal_events
          where withdrawal_id = ${withdrawalId}::uuid and kind = 'crash_injected'
            and data->>'point' = ${point})`;
    if (rows.count === 0) return; // killed here before: carry on
    process.kill(process.pid, 'SIGKILL');
    await new Promise<never>(() => {}); // nothing after the hook runs while the signal lands
  };
}
