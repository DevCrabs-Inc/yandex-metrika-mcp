.PHONY: setup dev build test lint format typecheck check inspect

setup:
	pnpm install --frozen-lockfile
	pnpm exec lefthook install

dev:
	pnpm dev

build:
	pnpm build

test:
	pnpm test

lint:
	pnpm lint

format:
	pnpm format

typecheck:
	pnpm typecheck

check:
	pnpm check

inspect: build
	pnpm dlx @modelcontextprotocol/inspector node dist/cli.js
