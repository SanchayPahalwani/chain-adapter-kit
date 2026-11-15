export interface AssetPolicy {
  // The least one withdrawal may ask, at least 1n. A deployment must set it at least to the
  // chain's smallest transferable amount (Bitcoin's dust limit, DUST_SAT in
  // src/adapters/bitcoin/adapter.ts), otherwise a withdrawal can be accepted that the chain will
  // never carry: it would hold the user's funds, and nothing would end it.
  minAmount: bigint;
  perWithdrawalMax: bigint;
  rolling24hMax: bigint;
  approvalThreshold: bigint; // amount >= threshold needs approvals
  approvalsRequired: number; // M
  approvers: string[]; // the N
}

export type RejectReason =
  | 'invalid_address'
  | 'not_allowlisted'
  | 'below_minimum'
  | 'over_withdrawal_limit'
  | 'over_24h_limit'
  | 'insufficient_funds'
  | 'rejected_by_approver';

export interface RequestFacts {
  addressValid: boolean;
  allowlisted: boolean;
  amount: bigint;
  recent24h: bigint; // the user's other non-rejected withdrawals of this asset in the window
}

// A bad policy is a configuration error, so it throws instead of rejecting requests.
export function assertValidPolicy(p: AssetPolicy): void {
  // typeof as well: a number or a missing value would compare with 1n without complaint
  if (typeof p.minAmount !== 'bigint' || p.minAmount < 1n) {
    throw new Error(`minAmount must be a bigint of at least 1n, got ${String(p.minAmount)}`);
  }
  if (
    !Number.isInteger(p.approvalsRequired) ||
    p.approvalsRequired < 1 ||
    p.approvalsRequired > p.approvers.length
  ) {
    throw new Error(
      `approvalsRequired must be between 1 and the ${p.approvers.length} approvers, got ${p.approvalsRequired}`,
    );
  }
  // A name listed twice approves once, so the check above would pass an M no withdrawal can reach.
  const twice = p.approvers.find((a, i) => p.approvers.indexOf(a) !== i);
  if (twice !== undefined) throw new Error(`approver ${twice} is listed more than once`);
}

// The checks that run before the hold, in order; the first failure wins.
export function checkRequest(p: AssetPolicy, f: RequestFacts): RejectReason | null {
  if (!f.addressValid) return 'invalid_address';
  if (!f.allowlisted) return 'not_allowlisted';
  if (f.amount < p.minAmount) return 'below_minimum';
  if (f.amount > p.perWithdrawalMax) return 'over_withdrawal_limit';
  if (f.recent24h + f.amount > p.rolling24hMax) return 'over_24h_limit';
  return null;
}

export const needsApproval = (p: AssetPolicy, amount: bigint) => amount >= p.approvalThreshold;

export const canApprove = (p: AssetPolicy, approverId: string, requesterId: string) =>
  approverId !== requesterId && p.approvers.includes(approverId);
