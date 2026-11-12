export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export interface BitcoinRpc {
  /** `wallet` routes the call to /wallet/<name>; wallet RPCs need it once more than one wallet is loaded. */
  call<T>(method: string, params?: unknown[], wallet?: string): Promise<T>;
}

/**
 * JSON-RPC 2.0 over fetch. bitcoind answers HTTP 200 with an `error` member for a failed call
 * (version "1.0" would answer 500), so the body decides. A failure to get an answer at all
 * (connection refused, a proxy's 502 page) throws as it is, so callers can tell the two apart.
 */
export function bitcoinRpc(url: string, auth: { user: string; password: string }): BitcoinRpc {
  const base = url.replace(/\/$/, '');
  const authorization = `Basic ${Buffer.from(`${auth.user}:${auth.password}`).toString('base64')}`;
  return {
    async call<T>(method: string, params: unknown[] = [], wallet?: string) {
      const res = await fetch(wallet ? `${base}/wallet/${encodeURIComponent(wallet)}` : base, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const body = (await res.json()) as {
        result: T;
        error?: { code: number; message: string } | null;
      };
      if (body.error) throw new RpcError(body.error.code, body.error.message);
      return body.result;
    },
  };
}

/** A BTC amount from the node (a JSON number) as satoshis, without float multiplication. */
export const btcToSats = (v: number): bigint => {
  const m = /^(-)?(\d+)\.(\d{8})$/.exec(v.toFixed(8));
  if (!m) throw new Error(`not a BTC amount: ${v}`);
  const sats = BigInt(m[2]!) * 100_000_000n + BigInt(m[3]!);
  return m[1] ? -sats : sats;
};
