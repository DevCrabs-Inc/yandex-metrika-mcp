# Changelog

## 1.0.0-beta.1

First public beta with the full v1 scope.

- 13 read-only tools: status, connect, disconnect, list/describe counters, catalog, report, period comparison, time series, export, job status, cancel, artifact reading; 3 prompts.
- Browser sign-in through the DevCrabs OAuth app in Yandex ID: read-only `metrika:read`, PKCE, a local one-time page, no OAuth app of your own and no token in the chat. `YM_MCP_CLIENT_ID` selects your own app; tokens can also be imported from the CLI or passed in `YANDEX_METRIKA_TOKEN` for headless setups.
- Tokens in the OS credential store; explicit opt-in file store.
- Several isolated connections with per-connection counter allowlists.
- Data correctness: counter time zone, complete periods by default, strict accuracy, tri-state sampling, API totals, non-additive metrics, percentage points, calendar time axis, unknown-is-not-zero.
- Untrusted data: labels, counter and goal names and connection aliases lose control and invisible characters (`LABELS_SANITIZED`); text summaries put external data inside a per-response `<untrusted-data-…>` block.
- Text summaries state the counter, exact dates, time zone, filters, quality, totals, why rows were cut and how to get the next page; the full result is in structured content.
- Typed errors with a next action and a request ID; `error.details` names the input field and suggests up to five close valid IDs (from the catalog or the same connection, never applied automatically). Tool arguments are validated strictly.
- Quota-aware client: per-account concurrency and /stat budgets, Retry-After handling, bounded retries; the User-Agent names the MCP client.
- Logs on stderr record sizes, rows, truncation and the MCP client, never labels, counter IDs or tokens.
- In-memory cache with explicit `refresh` and `allow_stale`.
- Durable CSV/JSON exports: checkpoints with checksums, drift detection, resume after restart, atomic publication, manifest, Excel-safe CSV, exact big integers.
- CLI: `setup` for Claude Desktop, Claude Code, Cursor, VS Code, Windsurf and Codex; `auth`, `jobs`, `doctor`, `demo`.
- Packaging: npm package `@dev-crabs/yandex-metrika-mcp`, MCPB bundle, Dockerfile, MCP Registry metadata, Cursor and Claude plugin manifests, `llms-install.md` for AI agents.
