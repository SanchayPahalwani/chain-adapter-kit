import type { AssetId, TxStatus } from '../core/adapter.js';
import type { Db, Tx } from './db.js';
import { acct, balance, ledgerAsset } from './ledger.js';
import type { ChainRuntime } from './worker.js';

export interface ReconcileRow {
  chain: string;
  asset: string;
  ledger: bigint;
  onchain: bigint;
  explained: bigint;
  drift: bigint;
}
export interface LedgerCheck {
  name: string;
  ok: boolean;
  detail: string;
}
export interface ReconcileReport {
  rows: ReconcileRow[];
  checks: LedgerCheck[];
  ok: boolean;
}

interface AttemptRow {
  id: string; // the withdrawal's
  chain: string;
  asset: string;
  amount: bigint;
  txid: string;
}
type Confirmed = Extract<TxStatus, { state: 'confirmed' }>;

const toCheck = (name: string, bad: string[]): LedgerCheck => ({
  name,
  ok: bad.length === 0,
  detail: bad.join('; '),
});

async function ledgerChecks(tx: Tx): Promise<LedgerCheck[]> {
  const unbalanced = await tx<{ asset: string; net: bigint }[]>`
    select * from (
      select a.asset, sum(case when e.side = 'debit' then e.amount else -e.amount end) as net
        from ledger_entries e join ledger_accounts a on a.name = e.account
       group by a.asset) s
     where net <> 0 order by asset`;
  const mismatched = await tx<{ name: string; balance: bigint; journal: bigint }[]>`
    select * from (
      select a.name, a.balance,
             coalesce(sum(case when e.side = a.normal_side then e.amount else -e.amount end), 0) as journal
        from ledger_accounts a left join ledger_entries e on e.account = a.name
       group by a.name, a.balance) s
     where balance <> journal order by name`;
  // Full join: a hold with no withdrawal, and a withdrawal with no hold, both show.
  const inFlight = await tx<{ asset: string; held: bigint; owed: bigint }[]>`
    with held as (
      select asset, balance from ledger_accounts where name = 'withdrawals_in_flight:' || asset
    ), owed as (
      select chain || ':' || asset as asset, sum(amount) as amount from withdrawals
       where state in ('AWAITING_APPROVAL','APPROVED','RESERVED','SIGNED','BROADCAST')
       group by 1
    )
    select coalesce(h.asset, o.asset) as asset, coalesce(h.balance, 0) as held, coalesce(o.amount, 0) as owed
      from held h full join owed o on o.asset = h.asset
     where coalesce(h.balance, 0) <> coalesce(o.amount, 0) order by 1`;
  const bad: Record<string, string[]> = {
    debits_equal_credits: unbalanced.map((r) => `${r.asset}: net ${r.net}`),
    balances_match_journal: mismatched.map(
      (r) => `${r.name}: ${r.balance} vs entries ${r.journal}`,
    ),
    in_flight_matches_withdrawals: inFlight.map(
      (r) => `${r.asset}: held ${r.held} vs owed ${r.owed}`,
    ),
  };
  return Object.entries(bad).map(([name, list]) => toCheck(name, list));
}

/**
 * Compares each chain's `custody` balance with the hot wallet's on-chain balance, and checks the
 * ledger against itself. Reads only; never writes.
 */
export async function reconcile(
  db: Db,
  chains: Record<string, ChainRuntime>,
  assets: Record<string, AssetId[]>,
): Promise<ReconcileReport> {
  for (const chain of Object.keys(assets)) {
    if (!chains[chain]) throw new Error(`no chain runtime for ${chain}`);
  }
  // One snapshot, so the custody balances, withdrawals and checks describe one instant.
  const snap = await db.begin('isolation level repeatable read read only', async (tx) => {
    const custody = new Map<string, bigint>();
    for (const [chain, list] of Object.entries(assets)) {
      for (const asset of list) {
        const a = ledgerAsset(chain, asset);
        custody.set(a, await balance(tx, acct.custody(a)));
      }
    }
    const attempts = await tx<AttemptRow[]>`
      select w.id, w.chain, w.asset, w.amount, t.txid
        from withdrawals w join tx_attempts t on t.withdrawal_id = w.id
       where w.state in ('SIGNED','BROADCAST') -- the only states with attempts that are not terminal
       order by w.id, t.attempt_no`;
    return { custody, attempts, checks: await ledgerChecks(tx) };
  });

  // The chain reads cannot be pinned to the snapshot's instant. A transfer that confirms or settles
  // between the reads (or confirms between its status read and the balance read) can show as
  // drift for one run: confirm a non-zero drift with a second run.
  const hits = new Map<string, { at: AttemptRow; s: Confirmed }[]>();
  for (const at of snap.attempts) {
    const rt = chains[at.chain];
    if (!rt || !(at.chain in assets)) continue;
    const s = await rt.adapter.getTxStatus(at.txid);
    if (s.state === 'confirmed') hits.set(at.id, [...(hits.get(at.id) ?? []), { at, s }]);
  }
  const explained = new Map<string, bigint>();
  const add = (a: string, v: bigint) => explained.set(a, (explained.get(a) ?? 0n) + v);
  const doubles: string[] = [];
  for (const [id, list] of hits) {
    const [hit] = list;
    // At most one attempt can confirm. If two do, what the ledger should hold is unknown: count neither.
    if (!hit || list.length > 1) {
      doubles.push(`withdrawal ${id}: ${list.length} attempts confirmed`);
      continue;
    }
    if (hit.s.succeeded) add(ledgerAsset(hit.at.chain, hit.at.asset), -hit.at.amount);
    add(ledgerAsset(hit.at.chain, 'native'), -hit.s.feePaid);
  }

  const rows: ReconcileRow[] = [];
  for (const [chain, list] of Object.entries(assets)) {
    const rt = chains[chain];
    if (!rt) continue; // checked above
    for (const asset of list) {
      const a = ledgerAsset(chain, asset);
      const ledger = snap.custody.get(a) ?? 0n;
      const onchain = await rt.adapter.getBalance(rt.hotAddress, asset);
      const exp = explained.get(a) ?? 0n;
      rows.push({ chain, asset, ledger, onchain, explained: exp, drift: onchain - ledger - exp });
    }
  }
  const checks = [...snap.checks, toCheck('one_confirmed_attempt', doubles)];
  const ok = rows.every((r) => r.drift === 0n) && checks.every((c) => c.ok);
  return { rows, checks, ok };
}

/** Plain text for a terminal: the rows, the checks, one summary line. */
export function formatReport(r: ReconcileReport): string {
  const table = [
    ['chain', 'asset', 'ledger', 'onchain', 'explained', 'drift'],
    ...r.rows.map((x) => [
      x.chain,
      x.asset,
      ...[x.ledger, x.onchain, x.explained, x.drift].map(String),
    ]),
  ];
  const widths =
    table[0]?.map((_, i) => Math.max(...table.map((cells) => cells[i]?.length ?? 0))) ?? [];
  const lines = table.map((cells) =>
    cells
      .map((c, i) => (i < 2 ? c.padEnd(widths[i] ?? 0) : c.padStart(widths[i] ?? 0)))
      .join('  ')
      .trimEnd(),
  );
  lines.push('');
  const nameWidth = Math.max(0, ...r.checks.map((c) => c.name.length));
  for (const c of r.checks) {
    lines.push(`${c.ok ? 'ok    ' : 'FAILED'}  ${c.name.padEnd(nameWidth)}  ${c.detail}`.trimEnd());
  }
  lines.push('');
  const drifting = r.rows.filter((x) => x.drift !== 0n).length;
  const failing = r.checks.filter((c) => !c.ok).length;
  lines.push(
    r.ok
      ? `reconciliation ok: ${r.rows.length} rows, drift 0, ${r.checks.length} checks passed`
      : `reconciliation FAILED: ${drifting} of ${r.rows.length} rows drift, ${failing} of ${r.checks.length} checks failed`,
  );
  return lines.join('\n') + '\n';
}
