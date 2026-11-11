# Prior art

Before designing the adapter interface I read how three public projects structure
their per-chain code. This note records what was read, what this repo borrows, and
where it differs. It is a short survey from one sitting, not a review of those
projects; where something could not be confirmed from the source, it says so.

## What was read

### BitGoJS

Repository: `github.com/BitGo/BitGoJS`, under `modules/`.

- `sdk-core/src/bitgo/baseCoin/iBaseCoin.ts` and `baseCoin.ts`: the per-coin
  interface. `IBaseCoin` is wide and shaped around a wallet service
  (`isValidAddress`, `deriveAddress`, `explainTransaction`, `verifyTransaction`,
  `signTransaction`, `getSignablePayload`, `feeEstimate`, `supportsTss`, and more).
  `BaseCoin` makes about a dozen methods abstract; the rest throw
  `NotImplementedError` until a coin overrides them. `broadcastTransaction` is one of
  the default-throwing ones.
- `sdk-core/src/account-lib/baseCoin/baseTransactionBuilder.ts` and
  `baseTransaction.ts`: an offline builder (`from`, `sign`, `addSignature`, `build`)
  and a transaction object with `id` and `toBroadcastFormat`. The comment on `id`
  says a transaction computed offline may not have one; it is left to each coin.
- `abstract-eth` and `abstract-utxo`: separate base modules for the two families.
  The common interface has no notion of a nonce or of coins. Fee bumping shows up
  only as `rbfTxIds` on the UTXO coin.
- Adding a coin touches a coin registry (`bitgo/src/v2/coins/index.ts`), the
  `statics` module and `account-lib`'s index, as far as the code shows. Each module
  has its own unit tests and fixtures; I found no shared suite that every coin must
  pass. (There is an `sdk-test` module I did not read.)

### Trust Wallet wallet-core

Repository: `github.com/trustwallet/wallet-core`.

- `src/CoinEntry.h`: the per-chain interface. Three methods are required
  (`validateAddress`, `deriveAddress`, `sign`); `plan`, `preImageHashes`, `compile`
  and others are optional.
- `include/TrustWalletCore/TWTransactionCompiler.h` and
  `src/proto/TransactionCompiler.proto`: external signing in two calls. One returns
  the pre-image hashes to sign; the other takes the signatures, in the same order,
  and compiles the final transaction.
- The library is offline by design: no balances, no broadcast, no status.
- A new chain starts from `registry.json` and a generator (`tools/new-blockchain`)
  that produces the entry, the protobuf messages and test skeletons. Test fixtures
  are expected to come from real mainnet transactions. I could not read the "new
  blockchain" checklist page itself.

### Coinbase Mesh (formerly Rosetta)

Repositories: `github.com/coinbase/mesh-specifications` (`api.json`) and
`github.com/coinbase/mesh-cli`.

- The Construction API splits a transfer into `derive`, `preprocess`, `metadata`,
  `payloads`, `parse`, `combine`, `hash` and `submit`. Only `metadata` and `submit`
  need a node. `payloads` returns the bytes to sign with a declared signature type;
  `combine` attaches signatures; `hash` gives the transaction id before `submit`.
- The Data API covers blocks, mempool, balances and coins.
- `mesh-cli check:construction` is a black-box conformance run on a live chain: it
  creates addresses, asks for funds, builds, signs, broadcasts and confirms
  transfers. `check:data` syncs from genesis, handles reorgs, and reconciles
  balances.
- The spec does not state what `submit` must do when the same transaction is
  submitted twice, as far as I could find. There is no fee-bump or replacement
  endpoint.

## What this repo borrows

| Idea                                                                           | From                                                                      | Where it appears here                                         |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Build, then expose the bytes to sign, then attach signatures                   | wallet-core's `preImageHashes` / `compile`; Mesh's `payloads` / `combine` | `buildTransfer` returns `signingPayloads`; `attachSignatures` |
| The transaction id is available before broadcast                               | Mesh's `/construction/hash`                                               | `attachSignatures` returns `txid`                             |
| A conformance run that builds and broadcasts real transactions on a live chain | `mesh-cli check:construction`                                             | `runConformanceSuite` against a local devnet                  |
| Balance reconciliation as part of the checks                                   | `mesh-cli check:data`                                                     | `reconcile` (ledger against chain)                            |
| One module per chain behind one interface                                      | all three                                                                 | `src/adapters/<chain>/`                                       |

## Where it differs

- **Scope of the interface.** BitGoJS's coin interface serves a hosted wallet
  product and is correspondingly wide. wallet-core stops at signing. This interface
  is narrow and covers what a withdrawal and a deposit scanner need, including the
  online half: broadcast, status, and block scan.
- **Broadcast semantics are part of the contract.** Here `broadcast` must be safe to
  repeat and must answer `already_known` for a transaction the node already has. In
  the three projects this is either out of scope or not specified.
- **Replacement is in the common interface.** `buildReplacement` covers a fee bump
  by nonce, replace-by-fee on UTXOs, and re-issuing after expiry, under one rule: a
  replacement can never confirm together with what it replaces. None of the three
  has this in the shared interface.
- **Inputs are explicit.** The nonce or the coins a transfer will use are reserved
  through an `InputStore` the adapter drives, so the reservation can live in the
  caller's database transaction. Mesh folds this into `metadata`; the other two leave
  it to the application.
- **One suite every adapter must pass, in the repo, run in CI.** Mesh has this as an
  external black-box tool driven by configuration. BitGoJS and wallet-core test each
  chain separately.
- **A withdrawal pipeline.** None of the three includes a persisted state machine
  for withdrawals, crash recovery between signing and broadcast, or drop and reorg
  handling for outgoing transactions. That is the second half of this repo.
- **Local chains only.** wallet-core asks for mainnet-proven fixtures. This repo does
  the opposite on purpose: everything runs against local test chains and refuses
  anything else.
