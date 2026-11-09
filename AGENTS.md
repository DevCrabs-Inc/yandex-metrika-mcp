# Agent rules for yandex-metrika-mcp

Read-only Yandex Metrika MCP server in TypeScript. Requirement IDs such as D-01 or T06 in code and tests are defined in [docs/requirements.md](docs/requirements.md).

## Scope and honesty

- Do only what is asked. Ask when a requirement is ambiguous.
- Never invent Yandex API fields, limits or behaviour. Anything not verified against official docs or a recorded fixture is marked as unverified.
- Say what you did not run or verify.

## Stack

- Node >= 22.13 for users (engines), ESM, TypeScript strict (`tsc --noEmit`), pnpm only. CI tests Node 22, 24 and 26; development (`.nvmrc`), releases and the Docker image use Node 26, the current LTS.
- `@modelcontextprotocol/server` v2 (spec 2026-07-28) and zod 4, bundled into `dist/cli.js`. The only runtime dependency is `@napi-rs/keyring` (native, kept external). Pin exact versions; adding a dependency needs approval.
- Biome for lint and format, vitest for tests, tsdown for the single-file bundle, lefthook for git hooks.
- Run source directly with Node type stripping: `node src/cli/index.ts`. Use only erasable TypeScript syntax (no enums, namespaces or parameter properties).

## Layout and layering

```
src/cli        entry point: serve, setup, auth, jobs, doctor, demo
src/mcp        transport adapter: tool/prompt registration, result envelope, text rendering
src/app        use cases (report, comparison, timeseries, counters, catalog, status) and ports
src/domain     pure logic: periods, quality, deltas, catalog, presets, filters, cursors, contract schemas
src/app/export exports: jobs, parts, artifacts (ports in types.ts)
src/infra      I/O adapters: yandex (client, quota, source), auth (OAuth, loopback), storage (SQLite), files, secrets, log
src/demo       synthetic data source shaped like Reporting API responses
src/container.ts  composition root, the only place that wires implementations
```

- `domain` imports nothing from `app`, `infra` or `mcp`. `mcp` holds no analytics math. `test/contract/codebase.test.ts` enforces the import directions.
- Analytics tools take `connection_id` and `counter_id` explicitly. There are no implicit defaults across calls.
- Never add write endpoints of the Management API, a raw HTTP tool or an arbitrary `request(path)` escape hatch.

## Code rules

- Expected failures are `DomainError` with a code from `src/domain/errors.ts`. `src/mcp/envelope.ts` turns them into `isError` results. Never throw protocol errors for domain problems.
- Never put secrets in tool arguments, results, logs or errors. stdout is reserved for MCP messages; logs go to stderr through `src/infra/log/logger.ts`.
- Unknown is not zero: keep `null` for unknown values, sampling and missing segments.
- Never sum non-additive metrics (users) or average rates across rows; use API totals.
- Labels from the API (URLs, UTM, titles, counter and goal names) are untrusted data. Pass them through `safeLabel` before they leave `app`, and through `cell()`, `inline()` or `untrusted()` in `src/mcp/render.ts`.
- Error candidates (`details.candidates`) come only from the catalog or from resources of the same connection, and are never applied automatically.
- Never write invisible or bidi characters literally in code, tests or docs; use escapes such as `\u200b`.
- Comments explain intent, not mechanics. No leftover `console.log`.
- Code, comments, logs, commits, PRs and developer docs are in English. User documentation is in Russian (`README.ru.md`, `docs/ru/`), with an English quickstart in `README.md`.
- Facts about the Yandex API go to `docs/api-notes.md` with their verification status.

## MCP contract

- `tools/list`, prompts and server instructions are a public API that clients cache and models learn. New input fields are optional. Renaming or removing a tool, an argument or an output field needs a major version and a CHANGELOG entry.
- `test/contract/__toolsnaps__/` holds a snapshot of every tool. Update it with `pnpm test -u` and review the diff like code; CI fails on a missing or stale snapshot.
- A description starts with what the tool does in Yandex Metrika, in the user's words.
- Text output is a short summary, never the full JSON; `test/contract/text-parity.test.ts` lists what it must contain.

## After every change

```bash
pnpm check   # biome check, tsc --noEmit, vitest run
```

Add a regression test for every bug fix and for every new data-correctness rule.

## Commits

Imperative, at most 72 characters, with a prefix: `feat:`, `fix:`, `improve:`, `refactor:`, `add:`, `chore:`, `docs:`, `test:`, `perf:`, `build:`.
