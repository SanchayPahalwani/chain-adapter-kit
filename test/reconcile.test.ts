import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AssetId, ChainAdapter, TxStatus } from '../src/core/adapter.js';
import { acct, ledgerAsset, post } from '../src/pipeline/ledger.js';
import {
  formatReport,
  reconcile,
  type ReconcileReport,
  type ReconcileRow,
} from '../src/pipeline/reconcile.js';
import { getWithdrawal, type Withdrawal } from '../src/pipeline/requests.js';
import { runOnce, type ChainRuntime } from '../src/pipeline/worker.js';
import { makeEvmEnv } from '../scripts/lib/evm-env.js';
import {
  attemptsOf,
  drive,
  openPipeline,
  overrideAdapter,
  type Pipeline,
  type PipelineEnv,
} from './pipeline-suite.js';

describe('reconciliation', () => {
  let env: PipelineEnv;
  let p: Pipeline;
  let token: AssetId;

  const run = (chains: Record<string, ChainRuntime> = p.deps.chains) =>
    reconcile(p.db, chains, { [env.chain]: env.assets });
  const row = (r: ReconcileReport, asset: AssetId): ReconcileRow => {
    const found = r.rows.find((x) => x.chain === env.chain && x.asset === asset);
    if (!found) throw new Error(`no row for ${asset}`);
    return found;
  };
  const check = (r: ReconcileReport, name: string) => {
    const found = r.checks.find((c) => c.name === name);
    if (!found) throw new Error(`no check ${name}`);
    return found;
  };
  const failedChecks = (r: ReconcileReport) => r.checks.filter((c) => !c.ok).map((c) => c.name);

  const withAdapter = (adapter: ChainAdapter): Record<string, ChainRuntime> => {
    const rt = p.deps.chains[env.chain];
    if (!rt) throw new Error('no runtime');
    return { [env.chain]: { ...rt, adapter } };
  };
  // Stored attempts under made-up txids, with the withdrawal moved to `state` by hand: the stub
  // adapter below answers for them, so these tests need no transaction on anvil.
  async function fakeAttempts(w: Withdrawal, to: 'SIGNED' | 'BROADCAST', txids: string[]) {
    await p.db`update withdrawals set state = ${to} where id = ${w.id}`;
    for (const [i, txid] of txids.entries()) {
      await p.db`
        insert into tx_attempts (withdrawal_id, attempt_no, txid, raw, unsigned, fee)
        values (${w.id}, ${i + 1}, ${txid}, ${txid}, '{}', '{}')`;
    }
  }
  // An adapter whose statuses come from `statuses` and whose native balance is `nativeDelta`
  // away from the real one.
  const stub = (statuses: Record<string, TxStatus>, nativeDelta: bigint) =>
    overrideAdapter(env.adapter, {
      getTxStatus: (txid) => Promise.resolve(statuses[txid] ?? { state: 'unknown' }),
      getBalance: async (address, asset) =>
        (await env.adapter.getBalance(address, asset)) + (asset === 'native' ? nativeDelta : 0n),
    });
  const confirmed = (succeeded: boolean, feePaid: bigint): TxStatus => ({
    state: 'confirmed',
    block: { height: 1, hash: '0xb1' },
    confirmations: 1,
    succeeded,
    feePaid,
  });

  const state = async (id: string) => (await getWithdrawal(p.db, id)).state;

  // Broadcast, then exactly one block: confirmed once, below finalityDepth, not yet settled.
  // Assumes nothing else mines on this anvil between mine(1) and the reads; a foreign block
  // makes the confirmations assertion fail loudly rather than let a test pass falsely.
  async function confirmedNotFinal(w: Withdrawal): Promise<{ feePaid: bigint }> {
    await drive(p.deps, env, async () => (await state(w.id)) === 'SIGNED');
    await runOnce(p.deps, 'one');
    expect(await state(w.id)).toBe('BROADCAST');
    await env.devnet.mine(1);
    const [attempt] = await attemptsOf(p.db, w.id);
    if (!attempt) throw new Error('no attempt');
    const status = await env.adapter.getTxStatus(attempt.txid);
    if (status.state !== 'confirmed') throw new Error(`attempt is ${status.state}`);
    expect(status.confirmations).toBeLessThan(env.adapter.finalityDepth);
    expect(status.succeeded).toBe(true);
    return { feePaid: status.feePaid };
  }

  beforeAll(async () => {
    env = await makeEvmEnv();
    const t = env.assets[1];
    if (!t) throw new Error('the env has no token asset');
    token = t;
  });
  afterAll(async () => {
    await env.clearStuck();
  });
  beforeEach(async () => {
    p = await openPipeline(env);
  });
  afterEach(async () => {
    await p.close();
  });

  it('Q1 clean after a settlement', async () => {
    const amount = env.unit('native');
    await p.credit('native', 3n * amount);
    await p.credit(token, 5n * env.unit(token));
    const w = await p.withdraw('native', amount);
    await drive(p.deps, env, async () => (await state(w.id)) === 'SETTLED');

    const r = await run();
    expect(r.rows.map((x) => x.asset)).toEqual(env.assets);
    for (const x of r.rows) {
      expect(x.drift).toBe(0n);
      expect(x.explained).toBe(0n);
      expect(x.ledger).toBe(x.onchain);
    }
    expect(r.checks.map((c) => c.name).sort()).toEqual([
      'balances_match_journal',
      'custody_covered',
      'debits_equal_credits',
      'in_flight_matches_withdrawals',
      'one_confirmed_attempt',
    ]);
    expect(failedChecks(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(formatReport(r)).toMatch(/ok/);
  });

  it('Q2 a confirmed but not final transfer is explained, not drift', async () => {
    const amount = env.unit('native');
    await p.credit('native', amount);
    const w = await p.withdraw('native', amount);
    const { feePaid } = await confirmedNotFinal(w);

    const r = await run();
    const native = row(r, 'native');
    expect(native.explained).toBe(-(amount + feePaid));
    expect(native.onchain - native.ledger).toBe(-(amount + feePaid));
    expect(native.drift).toBe(0n);
    expect(row(r, token).drift).toBe(0n);
    expect(failedChecks(r)).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('Q3 an unexplained on-chain change is flagged', async () => {
    await env.devnet.fund(p.hot.hotAddress, 'native', 1n);

    const r = await run();
    expect(row(r, 'native').drift).toBe(1n);
    expect(row(r, 'native').explained).toBe(0n);
    expect(row(r, token).drift).toBe(0n);
    expect(failedChecks(r)).toEqual([]);
    expect(r.ok).toBe(false);
    expect(formatReport(r)).toMatch(/FAILED/);
  });

  it('Q4 a tampered balance fails balances_match_journal', async () => {
    const n = ledgerAsset(env.chain, 'native');
    await p.credit('native', env.unit('native'));
    await p.db`update ledger_accounts set balance = balance + 1 where name = ${acct.user(p.userId, n)}`;

    const r = await run();
    expect(failedChecks(r)).toEqual(['balances_match_journal']);
    expect(check(r, 'balances_match_journal').detail).toContain(acct.user(p.userId, n));
    expect(row(r, 'native').drift).toBe(0n);
    expect(r.ok).toBe(false);
  });

  it('Q5 a hold without a withdrawal fails in_flight_matches_withdrawals', async () => {
    const n = ledgerAsset(env.chain, 'native');
    await p.credit('native', env.unit('native'));
    await p.db.begin((tx) =>
      post(tx, 'stray-hold', 'hold', n, [
        { account: acct.user(p.userId, n), side: 'debit', amount: 7n },
        { account: acct.inFlight(n), side: 'credit', amount: 7n },
      ]),
    );

    const r = await run();
    expect(failedChecks(r)).toEqual(['in_flight_matches_withdrawals']);
    expect(check(r, 'in_flight_matches_withdrawals').detail).toContain(n);
    expect(row(r, 'native').drift).toBe(0n);
    expect(r.ok).toBe(false);
  });

  it('Q6 a token transfer confirmed but not final is explained in the token and in native', async () => {
    const amount = 3n * env.unit(token);
    await p.credit(token, amount);
    const w = await p.withdraw(token, amount);
    const { feePaid } = await confirmedNotFinal(w);
    expect(feePaid).toBeGreaterThan(0n);

    const r = await run();
    expect(row(r, token).explained).toBe(-amount);
    expect(row(r, token).drift).toBe(0n);
    expect(row(r, 'native').explained).toBe(-feePaid);
    expect(row(r, 'native').drift).toBe(0n);
    expect(failedChecks(r)).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('Q7 an unexplained on-chain token change is flagged in the token row only', async () => {
    await p.credit(token, env.unit(token));
    await env.devnet.fund(p.hot.hotAddress, token, 1n);

    const r = await run();
    expect(row(r, token).drift).toBe(1n);
    expect(row(r, 'native').drift).toBe(0n);
    expect(failedChecks(r)).toEqual([]);
    expect(r.ok).toBe(false);
  });

  it('Q8 two confirmed attempts of one withdrawal fail one_confirmed_attempt', async () => {
    const amount = env.unit('native');
    await p.credit('native', amount);
    const w = await p.withdraw('native', amount);
    await confirmedNotFinal(w);
    const [real] = await attemptsOf(p.db, w.id);
    if (!real) throw new Error('no attempt');
    // A second stored attempt that this adapter reports as the same confirmed transaction.
    await p.db`
      insert into tx_attempts (withdrawal_id, attempt_no, txid, raw, unsigned, fee)
      values (${w.id}, 2, 'twin', 'twin', '{}', '{}')`;
    const twin = overrideAdapter(env.adapter, {
      getTxStatus: (txid) => env.adapter.getTxStatus(txid === 'twin' ? real.txid : txid),
    });

    const r = await run(withAdapter(twin));
    expect(failedChecks(r)).toEqual(['one_confirmed_attempt']);
    expect(check(r, 'one_confirmed_attempt').detail).toContain(w.id);
    // neither attempt is counted, so the transfer that did happen shows as drift
    const native = row(r, 'native');
    expect(native.explained).toBe(0n);
    expect(native.drift).toBe(native.onchain - native.ledger);
    expect(native.drift).toBeLessThan(-amount);
    expect(r.ok).toBe(false);
  });

  it('Q9 refuses to compare nothing', async () => {
    await expect(reconcile(p.db, p.deps.chains, {})).rejects.toThrow(/no chain and asset/);
    await expect(reconcile(p.db, p.deps.chains, { [env.chain]: [] })).rejects.toThrow(
      /no chain and asset/,
    );
  });

  it('Q10 a custody balance no requested row covers fails custody_covered', async () => {
    await p.credit(token, 50n);

    const r = await reconcile(p.db, p.deps.chains, { [env.chain]: ['native'] });
    expect(r.rows.map((x) => x.asset)).toEqual(['native']);
    expect(row(r, 'native').drift).toBe(0n);
    expect(failedChecks(r)).toEqual(['custody_covered']);
    expect(check(r, 'custody_covered').detail).toBe(
      `${acct.custody(ledgerAsset(env.chain, token))}: 50`,
    );
    expect(r.ok).toBe(false);
  });

  it('Q11 an unbalanced entry fails debits_equal_credits', async () => {
    const n = ledgerAsset(env.chain, 'native');
    // one credit line with no debit, its account balance moved to match, so only this check fails
    const [tx] = await p.db<{ id: string }[]>`
      insert into ledger_txs (ref, kind) values ('lopsided', 'test') returning id::text`;
    if (!tx) throw new Error('no ledger tx');
    await p.db`
      insert into ledger_entries (tx_id, account, side, amount)
      values (${tx.id}, ${acct.platform(n)}, 'credit', 5)`;
    await p.db`update ledger_accounts set balance = balance + 5 where name = ${acct.platform(n)}`;

    const r = await run();
    expect(failedChecks(r)).toEqual(['debits_equal_credits']);
    expect(check(r, 'debits_equal_credits').detail).toBe(`${n}: net -5`);
    expect(row(r, 'native').drift).toBe(0n);
    expect(r.ok).toBe(false);
  });

  it('Q12 a confirmed attempt that reverted is explained by its fee only', async () => {
    const amount = 4n * env.unit(token);
    await p.credit(token, amount);
    const w = await p.withdraw(token, amount);
    await fakeAttempts(w, 'BROADCAST', ['stub-1']);

    // reverted: the token stays, the hot wallet paid 7 in gas
    const r = await run(withAdapter(stub({ 'stub-1': confirmed(false, 7n) }, -7n)));
    expect(row(r, token).explained).toBe(0n);
    expect(row(r, token).drift).toBe(0n);
    expect(row(r, 'native').explained).toBe(-7n);
    expect(row(r, 'native').drift).toBe(0n);
    expect(failedChecks(r)).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('Q13 a replaced attempt that confirmed while the latest is pending is explained', async () => {
    const amount = env.unit('native');
    await p.credit('native', amount);
    const w = await p.withdraw('native', amount);
    // SIGNED: a replacement is stored, but the first attempt is the one that confirmed
    await fakeAttempts(w, 'SIGNED', ['stub-1', 'stub-2']);
    const statuses = { 'stub-1': confirmed(true, 5n), 'stub-2': { state: 'pending' } as const };

    const r = await run(withAdapter(stub(statuses, -(amount + 5n))));
    expect(row(r, 'native').explained).toBe(-(amount + 5n));
    expect(row(r, 'native').drift).toBe(0n);
    expect(failedChecks(r)).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('Q14 a failed check names at most five offenders', async () => {
    const n = ledgerAsset(env.chain, 'native');
    for (let i = 0; i < 7; i++) {
      await p.db`
        insert into ledger_accounts (name, asset, normal_side, balance)
        values (${acct.user(`ghost-${i}`, n)}, ${n}, 'credit', 1)`;
    }

    const r = await run();
    expect(failedChecks(r)).toEqual(['balances_match_journal']);
    const detail = check(r, 'balances_match_journal').detail;
    expect(detail.split('; ')).toHaveLength(6);
    expect(detail).toContain(acct.user('ghost-4', n));
    expect(detail).not.toContain(acct.user('ghost-5', n));
    expect(detail.endsWith('; and 2 more')).toBe(true);
  });

  it('Q15 formatReport layout and signs', () => {
    const text = formatReport({
      rows: [
        { chain: 'c1', asset: 'native', ledger: 100n, onchain: 90n, explained: -7n, drift: -3n },
      ],
      checks: [
        { name: 'debits_equal_credits', ok: true, detail: '' },
        { name: 'custody_covered', ok: false, detail: 'custody:c1:x: 50' },
      ],
      ok: false,
    });
    expect(text).toBe(
      [
        'chain  asset   ledger  onchain  explained  drift',
        'c1     native     100       90         -7     -3',
        '',
        'ok      debits_equal_credits',
        'FAILED  custody_covered       custody:c1:x: 50',
        '',
        'reconciliation FAILED: 1 of 1 rows drift, 1 of 2 checks failed',
        '',
      ].join('\n'),
    );
  });
});
