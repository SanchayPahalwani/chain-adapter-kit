.PHONY: up down test typecheck lint migrate conformance faults demo reconcile chain-cost contracts

node_modules: package-lock.json
	npm ci

up:
	docker compose up -d --build --wait

down:
	docker compose down -v

test: node_modules
	npm test

typecheck: node_modules
	npm run typecheck

lint: node_modules
	npm run lint

# The schema KIT_DB_SCHEMA names (it must exist), or the default one.
migrate: node_modules
	npx tsx scripts/migrate.ts

conformance: node_modules
	npx vitest run test/*.conformance.test.ts

# The full fault matrix (scripts/lib/scenarios.ts), graded by the chain; writes docs/results.md
# when every scenario passes and the checkout did not change during the run.
faults: node_modules
	npx tsx scripts/fault-run.ts

# A short tour on a fresh schema: brings the containers up first. No migrate: the demo creates and
# migrates its own schema, and drops it at the end.
demo: node_modules up
	npx tsx scripts/demo.ts

# Reconciles the ledger against the chain, configured by the environment (KIT_SEED, KIT_DB_SCHEMA,
# KIT_CHAINS, DATABASE_URL and the chain's own variables), which make passes through. Migrates the
# schema it reads first (KIT_DB_SCHEMA's, or the default one), so a schema an older version made
# has the tables this one reads.
reconcile: node_modules migrate
	npx tsx scripts/reconcile.ts

# What adding Bitcoin took, from git (docs/adding-a-chain.md): the milestone-4 commits, without
# the fault-run fixes that landed between them (ee6d484, 428ceae) or the later hardening.
BITCOIN_COMMITS = dfc12c8 df96c74 a4e163c 14f50c3 4361425 c6fcb73 10ef314
chain-cost: node_modules
	npx tsx scripts/chain-cost.ts src/adapters/bitcoin $(BITCOIN_COMMITS)

# Compiles contracts/TestToken.sol with forge inside the Foundry image (solc version from the
# file's pragma; forge downloads it on first use) and writes only its ABI and bytecode.
contracts:
	docker run --rm -v "$(CURDIR)/contracts:/contracts" --entrypoint sh \
	  ghcr.io/foundry-rs/foundry:v1.9.0 -c '\
	  set -e; mkdir -p /tmp/p/src; cp /contracts/TestToken.sol /tmp/p/src/; cd /tmp/p; \
	  forge build --quiet; \
	  printf "{\"abi\":%s,\"bytecode\":\"%s\"}\n" "$$(forge inspect TestToken abi --json)" \
	    "$$(forge inspect TestToken bytecode)" > /contracts/TestToken.json'
