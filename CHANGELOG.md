# Changelog

## 1.0.0-beta.1

First public beta with the full v1 scope.

- 13 read-only tools: status, connect, disconnect, list/describe counters, catalog, report, period comparison, time series, export, job status, cancel, artifact reading; 3 prompts.
- Browser sign-in with PKCE through a local one-time page; token import from the CLI; environment token for headless setups.
- Tokens in the OS credential store; explicit opt-in file store.
- Several isolated connections with per-connection counter allowlists.
- Data correctness: counter time zone, complete periods by default, strict accuracy, tri-state sampling, API totals, non-additive metrics, percentage points, calendar time axis, unknown-is-not-zero.
- Quota-aware client: per-account concurrency and /stat budgets, Retry-After handling, bounded retries.
- In-memory cache with explicit `refresh` and `allow_stale`.
- Durable CSV/JSON exports: checkpoints with checksums, drift detection, resume after restart, atomic publication, manifest, Excel-safe CSV, exact big integers.
- CLI: `setup` for Claude Desktop, Claude Code, Cursor, VS Code, Windsurf and Codex; `auth`, `jobs`, `doctor`, `demo`.
- Packaging: npm, MCPB bundle, Docker image, MCP Registry metadata.
