// The command line of scripts/fault-run.ts, apart from the script so that its rules can be tested.
import { parseArgs } from 'node:util';

/** A command line the script cannot run: it prints the message and its usage, and exits 2. */
export class UsageError extends Error {
  override name = 'UsageError';
}

export interface RunArgs {
  chains: string[]; // in the order the run takes them
  quick: boolean;
  n: number; // withdrawals per scenario, for the scenarios without counts of their own
  only?: string[];
  keep: boolean;
  json: boolean;
  noWrite: boolean;
  // Anything but the whole matrix on every chain at its default counts. docs/results.md describes
  // exactly that, so a partial run never writes it.
  partial: boolean;
}

export function parseRunArgs(
  argv: string[],
  known: { chains: string[]; scenarios: string[] },
): RunArgs {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        chain: { type: 'string', default: 'all' },
        quick: { type: 'boolean', default: false },
        'per-scenario': { type: 'string' },
        only: { type: 'string' },
        keep: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        'no-write': { type: 'boolean', default: false },
      },
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const perScenario = values['per-scenario'];
  if (values.quick && perScenario !== undefined) {
    throw new UsageError('--quick or --per-scenario, not both');
  }
  const chains = values.chain === 'all' ? known.chains : [values.chain];
  for (const chain of chains) {
    if (!known.chains.includes(chain)) {
      throw new UsageError(`unknown chain ${chain} (known: ${known.chains.join(', ')}, all)`);
    }
  }
  const n = values.quick ? 2 : Number(perScenario ?? 10);
  if (!Number.isInteger(n) || n < 1)
    throw new UsageError('--per-scenario must be a positive integer');
  const only = values.only?.split(',').map((s) => s.trim());
  for (const name of only ?? []) {
    if (!known.scenarios.includes(name)) throw new UsageError(`unknown scenario ${name}`);
  }
  const partial =
    values.chain !== 'all' || values.quick || only !== undefined || perScenario !== undefined;
  return {
    chains,
    quick: values.quick,
    n,
    only,
    keep: values.keep,
    json: values.json,
    noWrite: values['no-write'],
    partial,
  };
}
