export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://kit:kit@127.0.0.1:55432/kit',
  evmRpcUrl: process.env.EVM_RPC_URL ?? 'http://127.0.0.1:58545',
};

/** `a, b,,c` -> ['a', 'b', 'c']; unset or empty -> []. */
export const commaList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
