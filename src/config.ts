export const defaults = {
  // test-only credentials of the throwaway Postgres in docker-compose.yml
  databaseUrl: 'postgres://kit:kit@127.0.0.1:55432/kit',
  evmRpcUrl: 'http://127.0.0.1:58545',
  bitcoinRpcUrl: 'http://127.0.0.1:58443',
  // test-only credentials of the regtest node in docker-compose.yml
  bitcoinRpcAuth: { user: 'kit', password: 'kit' },
};

export type Env = Record<string, string | undefined>;

/** A variable of `env`. One rule everywhere in the kit: an empty value is the same as unset. */
export const setting = (env: Env, name: string): string | undefined => env[name] || undefined;

/** Where the tests, the fault run and the scripts find the services, from `env`. */
export function configFrom(env: Env) {
  return {
    databaseUrl: setting(env, 'DATABASE_URL') ?? defaults.databaseUrl,
    evmRpcUrl: setting(env, 'EVM_RPC_URL') ?? defaults.evmRpcUrl,
    bitcoinRpcUrl: setting(env, 'BITCOIN_RPC_URL') ?? defaults.bitcoinRpcUrl,
    bitcoinRpcAuth: {
      user: setting(env, 'BITCOIN_RPC_USER') ?? defaults.bitcoinRpcAuth.user,
      password: setting(env, 'BITCOIN_RPC_PASSWORD') ?? defaults.bitcoinRpcAuth.password,
    },
  };
}

export const config = configFrom(process.env);

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
