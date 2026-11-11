import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AssetId, ChainAdapter } from '../src/core/adapter.js';
import { acct, ledgerAsset, post } from '../src/pipeline/ledger.js';
import {
  formatReport,
  reconcile,
  type ReconcileReport,
  type ReconcileRow,
} from '../src/pipeline/reconcile.js';
import { getWithdrawal, type Withdrawal } from '../src/pipeline/requests.js';
import { runOnce, type ChainRuntime } from '../src/pipeline/worker.js';
import { makeEvmEnv } from './helpers/evm-env.js';
import {
  attemptsOf,
  drive,
  openPipeline,
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

  const state = async (id: string) => (await getWithdrawal(p.db, id)).state;

  // Broadcast, then exactly one block: confirmed once, below finalityDepth, not yet settled.
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
    const twin: ChainAdapter = {
      ...env.adapter,
      getTxStatus: (txid) => env.adapter.getTxStatus(txid === 'twin' ? real.txid : txid),
    };
    const rt = p.deps.chains[env.chain];
    if (!rt) throw new Error('no runtime');

    const r = await run({ [env.chain]: { ...rt, adapter: twin } });
    expect(failedChecks(r)).toEqual(['one_confirmed_attempt']);
    expect(check(r, 'one_confirmed_attempt').detail).toContain(w.id);
    expect(r.ok).toBe(false);
  });
});
