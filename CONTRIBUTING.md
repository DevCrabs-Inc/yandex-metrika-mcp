# Contributing

Thanks for helping. Code, comments, commits and PRs are in English; user documentation lives in `docs/ru` (Russian) and README files.

## Setup

```bash
pnpm install
make setup     # also installs git hooks (lefthook)
pnpm check     # Biome, tsc --noEmit, vitest
pnpm dev       # run the server from source over stdio
```

Node 22.13+ is required. The source runs directly through Node type stripping, so use only erasable TypeScript syntax.

## Layout

See [AGENTS.md](AGENTS.md) for layering rules. In short: `domain` is pure, `app` holds use cases and ports, `infra` implements ports (Yandex API, OAuth, SQLite, files), `mcp` adapts to the protocol, `container.ts` wires everything.

## Tests

- `test/unit`: pure logic (periods, quality, deltas, filters, cursors, setup).
- `test/contract`: the Yandex HTTP client against a fake `fetch`.
- `test/integration`: the MCP server, connections, OAuth over real loopback HTTP, exports with SQLite and files.
- `test/e2e`: the stdio server as a child process.

Every bug fix and every data-correctness rule needs a regression test. Fixtures are synthetic; never commit real report data, tokens or counter IDs of clients.

## Changing the catalog or presets

Metrics and dimensions live in `src/domain/catalog.ts`; presets in `src/domain/presets.ts`. Only add fields you have checked against the official Yandex documentation, set their aggregation semantics correctly, and bump the preset version when its fields change.

## Commits and PRs

Imperative subject up to 72 characters with a prefix: `feat:`, `fix:`, `improve:`, `refactor:`, `add:`, `chore:`, `docs:`, `test:`, `perf:`, `build:`. Keep PRs focused and describe how you verified the change.
