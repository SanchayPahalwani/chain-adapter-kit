import type { Db } from './db.js';
import type { ChainRuntime } from './worker.js';

export interface Verdict {
  withdrawals: number;
  settled: number;
  rejected: number;
  failed: number;
  sentTwice: number;
  lost: number;
  unfinished: number;
}

interface Row {
  chain: string;
  asset: string;
  to_address: string;
  amount: bigint;
  state: string;
}

/**
 * Grades a run by what each destination holds on-chain, not by the pipeline's own records.
 * Assumes every withdrawal in the schema went to its own fresh address, so that balance is
 * exactly what the pipeline sent it; an address used twice throws.
 */
export async function verifyAgainstChain(
  db: Db,
  chains: Record<string, ChainRuntime>,
): Promise<Verdict> {
  const rows = await db<Row[]>`
    select chain, asset, to_address, amount, state from withdrawals order by created_at, id`;
  const v: Verdict = {
    withdrawals: rows.length,
    settled: 0,
    rejected: 0,
    failed: 0,
    sentTwice: 0,
    lost: 0,
    unfinished: 0,
  };
  const seen = new Set<string>();
  for (const w of rows) {
    const key = `${w.chain}:${w.to_address}`;
    if (seen.has(key)) throw new Error(`${key} received two withdrawals: no fresh address each`);
    seen.add(key);
    const rt = chains[w.chain];
    if (!rt) throw new Error(`no chain runtime for ${w.chain}`);
    const onchain = await rt.adapter.getBalance(w.to_address, w.asset);

    if (w.state === 'SETTLED') v.settled++;
    else if (w.state === 'REJECTED') v.rejected++;
    else if (w.state === 'FAILED') v.failed++;
    else v.unfinished++;
    // REJECTED and FAILED end without a transfer: anything at their destination left anyway
    const noTransfer = w.state === 'REJECTED' || w.state === 'FAILED';
    if (onchain > w.amount || (noTransfer && onchain > 0n)) v.sentTwice++;
    else if (w.state === 'SETTLED' && onchain < w.amount) v.lost++;
  }
  return v;
}
