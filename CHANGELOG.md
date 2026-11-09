# Changelog

## Unreleased

- Labels, counter names, goal names and connection aliases lose control and invisible characters (bidi controls, zero-width characters, Unicode tags); results say so with `LABELS_SANITIZED`. Report context no longer bypasses label sanitizing, truncation never splits an emoji, and goal names that look identical after sanitizing are flagged as duplicates.
- Text summaries put rows, segments, counter and goal lists and artifact text inside an `<untrusted-data-…>` block with a fresh random tag and a warning before and after it. Report, comparison and time-series descriptions say the same.
- Errors carry `error.details`: the input `field`, up to five `candidates` for mistyped metric, dimension, goal, filter, sort, connection or allowlisted counter IDs (never applied automatically and never taken from other connections), the sanitized Yandex message as `upstream_message`, and any extra facts. The text summary now shows the `request_id`.
- Busy sign-in ports give `AUTH_NOT_CONFIGURED` with a next action instead of `INTERNAL_ERROR`.
- Text summaries of reports, comparisons and time series show the filters and why rows were cut (page limit, response budget or top segments only), and comparisons say how many segments are only in structured content.
- Tool descriptions lead with what the tool does in Yandex Metrika, so client-side tool search finds them; analytics tools say that calls spend API quota. Server instructions ask the model to say which rows or pages were not fetched.
- The `tool call` log line on stderr records response and text sizes, returned rows, truncation and the MCP client name and version; labels and counter IDs are still never logged. The User-Agent sent to Yandex names the MCP client, e.g. `yandex-metrika-mcp/1.0.0 (claude-code/2.1.0)`.
- Tool arguments are validated strictly: a misspelled argument, also inside `period` or `filters`, is rejected instead of being ignored.

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
