# Agent rules for yandex-metrika-mcp

Read-only Yandex Metrika MCP server in TypeScript. The product spec (in Russian) lives outside this repo in `dev-crabs-Immersive/docs/products/yandex-metrika-mcp/` (files 01–08). Requirement IDs such as D-01 or T06 in code and tests refer to it.

## Scope and honesty

- Do only what is asked. Ask when a requirement is ambiguous.
- Never invent Yandex API fields, limits or behaviour. Anything not verified against official docs or a recorded fixture is marked as unverified.
- Say what you did not run or verify.

## Stack

- Node >= 22.13, ESM, TypeScript strict (`tsc --noEmit`), pnpm only.
- `@modelcontextprotocol/server` v2 (spec 2026-07-28) and zod 4. Pin exact versions; adding a dependency needs approval.
- Biome for lint and format, vitest for tests, tsdown for the single-file bundle, lefthook for git hooks.
- Run source directly with Node type stripping: `node src/cli/index.ts`. Use only erasable TypeScript syntax (no enums, namespaces or parameter properties).

## Layout and layering

```
src/cli        entry point (serve | doctor | demo)
src/mcp        transport adapter: tool/prompt registration, result envelope, text rendering
src/app        use cases (report, comparison, timeseries, counters, catalog, status) and ports
src/domain     pure logic: periods, quality, deltas, catalog, presets, filters, cursors, contract schemas
src/infra      I/O adapters (logging now; Yandex API, auth and storage next)
src/demo       synthetic data source shaped like Reporting API responses
src/container.ts  composition root, the only place that wires implementations
```

- `domain` imports nothing from `app`, `infra` or `mcp`. `mcp` holds no analytics math.
- Analytics tools take `connection_id` and `counter_id` explicitly. There are no implicit defaults across calls.
- Never add write endpoints of the Management API, a raw HTTP tool or an arbitrary `request(path)` escape hatch.

## Code rules

- Expected failures are `DomainError` with a code from `src/domain/errors.ts`. `src/mcp/envelope.ts` turns them into `isError` results. Never throw protocol errors for domain problems.
- Never put secrets in tool arguments, results, logs or errors. stdout is reserved for MCP messages; logs go to stderr through `src/infra/log/logger.ts`.
- Unknown is not zero: keep `null` for unknown values, sampling and missing segments.
- Never sum non-additive metrics (users) or average rates across rows; use API totals.
- Labels from the API (URLs, UTM, titles) are untrusted data. Pass them through `safeLabel`.
- Comments explain intent, not mechanics. No leftover `console.log`.
- Code, comments, logs, docs, commits and PRs are in English.

## After every change

```bash
pnpm check   # biome check, tsc --noEmit, vitest run
```

Add a regression test for every bug fix and for every new data-correctness rule.

## Commits

Imperative, at most 72 characters, with a prefix: `feat:`, `fix:`, `improve:`, `refactor:`, `add:`, `chore:`, `docs:`, `test:`, `perf:`, `build:`.
