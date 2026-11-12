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
 * (version "1.0" would answer 500), and that error is thrown as an RpcError. Anything else is a
 * failure to get the node's answer and throws a plain Error, so callers can tell the two apart:
 * a refused connection, no answer within `timeoutMs`, or any non-2xx status, with a JSON body or
 * not (a 401, a 503 from a full work queue, a proxy's 502).
 */
export function bitcoinRpc(
  url: string,
  auth: { user: string; password: string },
  timeoutMs = 30_000,
): BitcoinRpc {
  const base = url.replace(/\/$/, '');
  const authorization = `Basic ${Buffer.from(`${auth.user}:${auth.password}`).toString('base64')}`;
  return {
    async call<T>(method: string, params: unknown[] = [], wallet?: string) {
      const timeout = AbortSignal.timeout(timeoutMs);
      let body: { result: T; error?: { code: number; message: string } | null };
      try {
        const res = await fetch(wallet ? `${base}/wallet/${encodeURIComponent(wallet)}` : base, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: timeout,
        });
        if (!res.ok) throw new Error(`bitcoind ${method}: HTTP ${res.status}`);
        body = (await res.json()) as typeof body;
      } catch (error) {
        if (!timeout.aborted) throw error;
        throw new Error(`bitcoind ${method}: no answer within ${timeoutMs / 1000} s`, {
          cause: error,
        });
      }
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

export interface Scan {
  total_amount: number;
  unspents: { txid: string; vout: number; amount: number }[];
}

/**
 * The confirmed coins of `address`, from a scan of the UTXO set. The node scans for one caller
 * at a time and answers -8 to any other (this process or another client), so this waits up to
 * 5 s for that scan to finish.
 */
export async function scanAddress(rpc: BitcoinRpc, address: string): Promise<Scan> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      const result = await rpc.call<Scan & { success: boolean }>('scantxoutset', [
        'start',
        [`addr(${address})`],
      ]);
      if (!result.success) throw new Error(`the scan for ${address} was aborted`);
      return result;
    } catch (error) {
      const busy =
        error instanceof RpcError && error.code === -8 && /in progress/.test(error.message);
      if (!busy || Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
