.PHONY: up down test typecheck lint

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
