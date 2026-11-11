import type { Queryable, Tx } from './db.js';

export type Side = 'debit' | 'credit';
export interface Line {
  account: string;
  side: Side;
  amount: bigint;
}

export const ledgerAsset = (chain: string, asset: string) => `${chain}:${asset}`;
export const acct = {
  custody: (a: string) => `custody:${a}`, // normal side: debit
  networkFees: (a: string) => `network_fees:${a}`, // debit
  user: (userId: string, a: string) => `user:${userId}:${a}`, // credit
  inFlight: (a: string) => `withdrawals_in_flight:${a}`, // credit
  platform: (a: string) => `platform:${a}`, // credit
};

export class InsufficientFunds extends Error {
  constructor(readonly account: string) {
    super(`insufficient funds in ${account}`);
  }
}

function normalSide(account: string): Side {
  const prefix = account.split(':')[0];
  if (prefix === 'custody' || prefix === 'network_fees') return 'debit';
  if (prefix === 'user' || prefix === 'withdrawals_in_flight' || prefix === 'platform')
    return 'credit';
  throw new Error(`unknown ledger account ${account}`);
}

// A concurrent creator makes this wait until it commits, then do nothing.
async function ensureAccount(tx: Tx, account: string, asset: string): Promise<void> {
  await tx`
    insert into ledger_accounts (name, asset, normal_side)
    values (${account}, ${asset}, ${normalSide(account)})
    on conflict (name) do nothing`;
}

export async function lockAccount(tx: Tx, account: string, asset: string): Promise<void> {
  await ensureAccount(tx, account, asset);
  const rows =
    await tx`select 1 from ledger_accounts where name = ${account} and asset = ${asset} for update`;
  if (rows.length === 0) throw new Error(`${account} exists in another asset than ${asset}`);
}

export async function balance(sql: Queryable, account: string): Promise<bigint> {
  const rows = await sql<
    { balance: bigint }[]
  >`select balance from ledger_accounts where name = ${account}`;
  return rows[0]?.balance ?? 0n;
}

// Never commits or opens a transaction: it runs inside the caller's. Throwing (unbalanced lines,
// InsufficientFunds) leaves the caller's transaction to roll back.
export async function post(
  tx: Tx,
  ref: string,
  kind: string,
  asset: string,
  lines: Line[],
): Promise<boolean> {
  // change per account: lines on the account's normal side add, the others subtract
  const delta = new Map<string, bigint>();
  let net = 0n;
  for (const l of lines) {
    if (l.amount <= 0n) throw new Error(`line amount must be positive, got ${l.amount}`);
    const sign = l.side === 'debit' ? 1n : -1n;
    net += sign * l.amount;
    const own = l.side === normalSide(l.account) ? 1n : -1n;
    delta.set(l.account, (delta.get(l.account) ?? 0n) + own * l.amount);
  }
  if (lines.length === 0 || net !== 0n)
    throw new Error(`postings must balance: ${ref} is off by ${net}`);

  // A second transaction with the same ref waits here for the first to commit, then gets no row.
  const [row] = await tx<{ id: string }[]>`
    insert into ledger_txs (ref, kind) values (${ref}, ${kind})
    on conflict (ref) do nothing returning id`;
  if (!row) return false;

  // Sorted by name, so two postings touching the same accounts lock them in the same order.
  for (const account of [...delta.keys()].sort()) {
    await ensureAccount(tx, account, asset);
    try {
      const rows = await tx`
        update ledger_accounts set balance = balance + ${delta.get(account) ?? 0n}
        where name = ${account} and asset = ${asset}`;
      if (rows.count === 0) throw new Error(`${account} exists in another asset than ${asset}`);
    } catch (e) {
      if ((e as { code?: string }).code === '23514') throw new InsufficientFunds(account);
      throw e;
    }
  }
  for (const l of lines) {
    await tx`
      insert into ledger_entries (tx_id, account, side, amount)
      values (${row.id}, ${l.account}, ${l.side}, ${l.amount})`;
  }
  return true;
}
