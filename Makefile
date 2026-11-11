.PHONY: up down test typecheck lint migrate conformance contracts

node_modules: package-lock.json
	npm ci

up:
	docker compose up -d --wait

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

# Compiles contracts/TestToken.sol with forge inside the Foundry image (solc version from the
# file's pragma; forge downloads it on first use) and writes only its ABI and bytecode.
contracts:
	docker run --rm -v "$(CURDIR)/contracts:/contracts" --entrypoint sh \
	  ghcr.io/foundry-rs/foundry:v1.9.0 -c '\
	  set -e; mkdir -p /tmp/p/src; cp /contracts/TestToken.sol /tmp/p/src/; cd /tmp/p; \
	  forge build --quiet; \
	  printf "{\"abi\":%s,\"bytecode\":\"%s\"}\n" "$$(forge inspect TestToken abi --json)" \
	    "$$(forge inspect TestToken bytecode)" > /contracts/TestToken.json'
