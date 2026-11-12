.PHONY: up down test typecheck lint migrate conformance faults demo reconcile contracts

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

migrate: node_modules
	npx tsx scripts/migrate.ts

conformance: node_modules
	npx vitest run test/*.conformance.test.ts

# The full fault matrix (scripts/lib/scenarios.ts), graded by the chain; writes docs/results.md
# when every scenario passes.
faults: node_modules
	npx tsx scripts/fault-run.ts

# A 30-second tour on a fresh schema: brings the containers up first.
demo: node_modules up
	npx tsx scripts/demo.ts

# Reconciles the ledger against the chain, configured by the environment (KIT_SEED, KIT_DB_SCHEMA,
# KIT_CHAINS, DATABASE_URL and the chain's own variables), which make passes through.
reconcile: node_modules
	npx tsx scripts/reconcile.ts

# Compiles contracts/TestToken.sol with forge inside the Foundry image (solc version from the
# file's pragma; forge downloads it on first use) and writes only its ABI and bytecode.
contracts:
	docker run --rm -v "$(CURDIR)/contracts:/contracts" --entrypoint sh \
	  ghcr.io/foundry-rs/foundry:v1.9.0 -c '\
	  set -e; mkdir -p /tmp/p/src; cp /contracts/TestToken.sol /tmp/p/src/; cd /tmp/p; \
	  forge build --quiet; \
	  printf "{\"abi\":%s,\"bytecode\":\"%s\"}\n" "$$(forge inspect TestToken abi --json)" \
	    "$$(forge inspect TestToken bytecode)" > /contracts/TestToken.json'
