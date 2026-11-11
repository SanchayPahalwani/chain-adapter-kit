export interface AssetPolicy {
  perWithdrawalMax: bigint;
  rolling24hMax: bigint;
  approvalThreshold: bigint; // amount >= threshold needs approvals
  approvalsRequired: number; // M
  approvers: string[]; // the N
}

export type RejectReason =
  | 'invalid_address'
  | 'not_allowlisted'
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

// The checks that run before the hold, in order; the first failure wins.
export function checkRequest(p: AssetPolicy, f: RequestFacts): RejectReason | null {
  if (!f.addressValid) return 'invalid_address';
  if (!f.allowlisted) return 'not_allowlisted';
  if (f.amount > p.perWithdrawalMax) return 'over_withdrawal_limit';
  if (f.recent24h + f.amount > p.rolling24hMax) return 'over_24h_limit';
  return null;
}

export const needsApproval = (p: AssetPolicy, amount: bigint) => amount >= p.approvalThreshold;

export const canApprove = (p: AssetPolicy, approverId: string, requesterId: string) =>
  approverId !== requesterId && p.approvers.includes(approverId);
