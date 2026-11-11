import type { Queryable, Tx } from './db.js';

export type Side = 'debit' | 'credit';
export interface Line {
  account: string;
  side: Side;
  amount: bigint;
}

// In acct.*, `a` is a ledgerAsset() string; every account name ends in `:${asset}`.
export const ledgerAsset = (chain: string, asset: string) => `${chain}:${asset}`;
export const acct = {
  custody: (a: string) => `custody:${a}`, // normal side: debit
  networkFees: (a: string) => `network_fees:${a}`, // debit
  user: (userId: string, a: string) => `user:${userId}:${a}`, // credit
  inFlight: (a: string) => `withdrawals_in_flight:${a}`, // credit
  platform: (a: string) => `platform:${a}`, // credit
};

export class InsufficientFunds extends Error {
  override name = 'InsufficientFunds';
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

// Checked before any write, so a wrong-asset call cannot leave half a posting behind.
function checkAsset(account: string, asset: string): void {
  if (!account.endsWith(`:${asset}`)) throw new Error(`${account} is not an ${asset} account`);
}

// A concurrent creator makes this wait until it commits, then do nothing.
async function ensureAccount(tx: Tx, account: string, asset: string): Promise<void> {
  await tx`
    insert into ledger_accounts (name, asset, normal_side)
    values (${account}, ${asset}, ${normalSide(account)})
    on conflict (name) do nothing`;
}

/**
 * Lock an account row for the rest of the transaction, creating it if needed.
 * Call it before any `post` in the transaction, and afterwards post only to accounts whose names
 * sort at or after the locked one (the request path locks `user:...`, then posts `user:...` and
 * `withdrawals_in_flight:...`). A caller that breaks this can deadlock; Postgres aborts one side.
 */
export async function lockAccount(tx: Tx, account: string, asset: string): Promise<void> {
  checkAsset(account, asset);
  await ensureAccount(tx, account, asset);
  await tx`select 1 from ledger_accounts where name = ${account} for update`;
}

export async function balance(sql: Queryable, account: string): Promise<bigint> {
  const rows = await sql<
    { balance: bigint }[]
  >`select balance from ledger_accounts where name = ${account}`;
  return rows[0]?.balance ?? 0n;
}

/**
 * Posts a balanced entry set inside the caller's transaction; it never commits or begins one.
 * Returns false and changes nothing if `ref` was already posted.
 * InsufficientFunds comes from a failed statement, so the surrounding transaction is aborted;
 * a caller that wants to record a rejection must run `post` inside a savepoint.
 */
export async function post(
  tx: Tx,
  ref: string,
  kind: string,
  asset: string,
  lines: Line[],
): Promise<boolean> {
  if (lines.length === 0) throw new Error(`posting ${ref} has no lines`);
  let net = 0n; // debits minus credits over the whole posting; must be zero
  // change per account: lines on its normal side add, the others subtract
  const delta = new Map<string, bigint>();
  for (const l of lines) {
    if (l.amount <= 0n) throw new Error(`line amount must be positive, got ${l.amount}`);
    checkAsset(l.account, asset);
    net += l.side === 'debit' ? l.amount : -l.amount;
    const change = l.side === normalSide(l.account) ? l.amount : -l.amount;
    delta.set(l.account, (delta.get(l.account) ?? 0n) + change);
  }
  if (net !== 0n)
    throw new Error(`posting ${ref} does not balance: debits minus credits is ${net}`);

  // A second transaction with the same ref waits here for the first to commit, then gets no row.
  const [row] = await tx<{ id: string }[]>`
    insert into ledger_txs (ref, kind) values (${ref}, ${kind})
    on conflict (ref) do nothing returning id`;
  if (!row) return false;

  // Sorted by name, so two single posts touching the same accounts lock them in the same order.
  // A transaction that makes several post calls should make them in a consistent order too.
  for (const account of [...delta.keys()].sort()) {
    await ensureAccount(tx, account, asset);
    try {
      await tx`
        update ledger_accounts set balance = balance + ${delta.get(account) ?? 0n}
        where name = ${account}`;
    } catch (e) {
      const err = e as { code?: string; constraint_name?: string };
      if (err.code === '23514' && err.constraint_name === 'ledger_accounts_balance_check') {
        throw new InsufficientFunds(account);
      }
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
