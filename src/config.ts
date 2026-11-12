export const defaults = {
  databaseUrl: 'postgres://kit:kit@127.0.0.1:55432/kit',
  evmRpcUrl: 'http://127.0.0.1:58545',
};

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? defaults.databaseUrl,
  evmRpcUrl: process.env.EVM_RPC_URL ?? defaults.evmRpcUrl,
};

/** `a, b,,c` -> ['a', 'b', 'c']; unset or empty -> []. */
export const commaList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

/** The scheme of a URL, such as 'postgres:', or '' when `value` does not parse as one. */
export function urlScheme(value: string): string {
  try {
    return new URL(value).protocol;
  } catch {
    return '';
  }
}

/** For checking settings: throws `message` unless `ok`. */
export function must(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
